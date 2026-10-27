package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/saltyorg/saltbox-lint/internal/editorprocess"
	"golang.org/x/sys/windows"
)

// lifetimeStartupInfo is STARTUPINFOW with the CRT reservation fields named.
type lifetimeStartupInfo struct {
	Cb            uint32
	Reserved      *uint16
	Desktop       *uint16
	Title         *uint16
	X             uint32
	Y             uint32
	XSize         uint32
	YSize         uint32
	XCountChars   uint32
	YCountChars   uint32
	FillAttribute uint32
	Flags         uint32
	ShowWindow    uint16
	CbReserved2   uint16
	LpReserved2   *byte
	StdInput      windows.Handle
	StdOutput     windows.Handle
	StdErr        windows.Handle
}

var (
	_ [unsafe.Sizeof(lifetimeStartupInfo{}) - unsafe.Sizeof(windows.StartupInfo{})]struct{}
	_ [unsafe.Sizeof(windows.StartupInfo{}) - unsafe.Sizeof(lifetimeStartupInfo{})]struct{}
)

// lifetimeChild mirrors Node's Windows launch: libuv passes descriptor 3 in the
// CRT table of STARTUPINFOW.lpReserved2 with FOPEN|FPIPE flags.
type lifetimeChild struct {
	process windows.Handle
	id      int
	owner   windows.Handle
	output  string // path of the inherited stdout/stderr file
	once    sync.Once
}

func inheritable() *windows.SecurityAttributes {
	attributes := &windows.SecurityAttributes{InheritHandle: 1}
	attributes.Length = uint32(unsafe.Sizeof(*attributes))
	return attributes
}

func environmentBlock(env []string) []uint16 {
	var block []uint16
	for _, value := range env {
		block = append(block, utf16.Encode([]rune(value))...)
		block = append(block, 0)
	}
	return append(block, 0)
}

// crtTable writes libuv's layout: uint32 count, flag bytes, unaligned HANDLEs.
func crtTable(flags []byte, handles []windows.Handle) []byte {
	size := int(unsafe.Sizeof(windows.Handle(0)))
	table := make([]byte, 4+len(flags)+len(handles)*size)
	binary.LittleEndian.PutUint32(table, uint32(len(flags)))
	copy(table[4:], flags)
	for i, handle := range handles {
		offset := 4 + len(flags) + i*size
		if size == 8 {
			binary.LittleEndian.PutUint64(table[offset:], uint64(handle))
		} else {
			binary.LittleEndian.PutUint32(table[offset:], uint32(handle))
		}
	}
	return table
}

func startLifetimeCLI(t *testing.T, args, env []string) *lifetimeChild {
	t.Helper()
	var childEnd, owner windows.Handle
	if err := windows.CreatePipe(&childEnd, &owner, inheritable(), 0); err != nil {
		t.Fatal(err)
	}
	if err := windows.SetHandleInformation(owner, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		_ = windows.CloseHandle(childEnd)
		_ = windows.CloseHandle(owner)
		t.Fatal(err)
	}
	child := &lifetimeChild{owner: owner}
	inherited := []windows.Handle{childEnd}
	defer func() {
		for _, handle := range inherited {
			_ = windows.CloseHandle(handle)
		}
	}()
	t.Cleanup(child.loseOwnerQuietly)
	null, err := windows.CreateFile(windows.StringToUTF16Ptr("NUL"), windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, inheritable(), windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	inherited = append(inherited, null)
	outputPath := filepath.Join(t.TempDir(), "output")
	output, err := windows.CreateFile(windows.StringToUTF16Ptr(outputPath), windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, inheritable(), windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	inherited = append(inherited, output)
	const crtOpen, crtPipe, crtDevice = 0x01, 0x08, 0x40
	table := crtTable([]byte{crtOpen | crtDevice, crtOpen, crtOpen, crtOpen | crtPipe}, []windows.Handle{null, output, output, childEnd})
	info := lifetimeStartupInfo{
		Flags:       windows.STARTF_USESTDHANDLES,
		CbReserved2: uint16(len(table)),
		LpReserved2: &table[0],
		StdInput:    null,
		StdOutput:   output,
		StdErr:      output,
	}
	info.Cb = uint32(unsafe.Sizeof(info))
	application, err := windows.UTF16PtrFromString(args[0])
	if err != nil {
		t.Fatal(err)
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(args))
	if err != nil {
		t.Fatal(err)
	}
	block := environmentBlock(env)
	var process windows.ProcessInformation
	if err := windows.CreateProcess(application, commandLine, nil, nil, true, windows.CREATE_UNICODE_ENVIRONMENT, &block[0], nil, (*windows.StartupInfo)(unsafe.Pointer(&info)), &process); err != nil {
		t.Fatal(err)
	}
	_ = windows.CloseHandle(process.Thread)
	child.process, child.id, child.output = process.Process, int(process.ProcessId), outputPath
	t.Cleanup(func() {
		// The handle keeps this process identity valid until closed. The CLI's
		// kill-on-close Job removes its descendants when it terminates.
		if event, _ := windows.WaitForSingleObject(child.process, 0); event != windows.WAIT_OBJECT_0 {
			_ = windows.TerminateProcess(child.process, 1)
			if event, err := windows.WaitForSingleObject(child.process, uint32(lifetimeBound.Milliseconds())); event != windows.WAIT_OBJECT_0 {
				t.Errorf("lifetime CLI cleanup did not join: %d %v", event, err)
			}
		}
		_ = windows.CloseHandle(child.process)
	})
	return child
}

func (child *lifetimeChild) pid() int { return child.id }

func (child *lifetimeChild) exited() bool {
	event, err := windows.WaitForSingleObject(child.process, 0)
	return err == nil && event == windows.WAIT_OBJECT_0
}

func (child *lifetimeChild) loseOwnerQuietly() {
	child.once.Do(func() { _ = windows.CloseHandle(child.owner) })
}

func (child *lifetimeChild) loseOwner(t *testing.T) {
	t.Helper()
	var err error
	child.once.Do(func() { err = windows.CloseHandle(child.owner) })
	if err != nil {
		t.Fatal(err)
	}
}

// wait joins the CLI process. Owner loss exits with the distinct status, after
// which its kill-on-close Job terminates descendants.
func (child *lifetimeChild) wait(t *testing.T, bound time.Duration) lifetimeResult {
	t.Helper()
	event, err := windows.WaitForSingleObject(child.process, uint32(bound.Milliseconds()))
	if err != nil || event != windows.WAIT_OBJECT_0 {
		t.Fatalf("CLI did not exit within %v: %d %v", bound, event, err)
	}
	var code uint32
	if err := windows.GetExitCodeProcess(child.process, &code); err != nil {
		t.Fatal(err)
	}
	// The process has exited, so its inherited output handle is closed.
	output, err := os.ReadFile(child.output)
	if err != nil {
		t.Fatal(err)
	}
	return lifetimeResult{code: int(code), ownerLoss: code == editorprocess.OwnerLostExitCode, output: string(output)}
}
