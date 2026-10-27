package editorprocess

import (
	"encoding/binary"
	"io"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// startupInfo mirrors STARTUPINFOW with the CRT reservation fields that the
// x/sys/windows declaration leaves unnamed.
type startupInfo struct {
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

// Both declarations must describe the same native structure.
var (
	_ [unsafe.Sizeof(startupInfo{}) - unsafe.Sizeof(windows.StartupInfo{})]struct{}
	_ [unsafe.Sizeof(windows.StartupInfo{}) - unsafe.Sizeof(startupInfo{})]struct{}
)

// CRT descriptor flags used by libuv's child stdio buffer.
const (
	crtOpen = 0x01
	crtPipe = 0x08
)

// openLifetime reads Node's fourth stdio entry. libuv passes CRT descriptors in
// STARTUPINFOW.lpReserved2 as: uint32 count, count flag bytes, then count
// unaligned HANDLE values. Go does not interpret this table, so os.NewFile(3)
// would name no inherited object.
func openLifetime() io.Reader {
	var info startupInfo
	if err := windows.GetStartupInfo((*windows.StartupInfo)(unsafe.Pointer(&info))); err != nil || info.LpReserved2 == nil {
		return nil
	}
	handle, ok := crtHandle(unsafe.Slice(info.LpReserved2, int(info.CbReserved2)), 3)
	if !ok {
		return nil
	}
	if kind, err := windows.GetFileType(handle); err != nil || kind != windows.FILE_TYPE_PIPE {
		return nil
	}
	// Go's own launcher uses explicit handle lists, but other launch paths may
	// inherit every inheritable handle. Only this process may hold the protocol.
	_ = windows.SetHandleInformation(handle, windows.HANDLE_FLAG_INHERIT, 0)
	return handleReader(handle)
}

// crtHandle validates the table bounds and returns an open pipe descriptor.
func crtHandle(buffer []byte, fd int) (windows.Handle, bool) {
	const handleSize = int(unsafe.Sizeof(windows.Handle(0)))
	if fd < 0 || len(buffer) < 4 {
		return 0, false
	}
	count := binary.LittleEndian.Uint32(buffer)
	if count > 256 || uint32(fd) >= count {
		return 0, false
	}
	entries := int(count)
	if len(buffer) < 4+entries+entries*handleSize {
		return 0, false
	}
	if buffer[4+fd]&(crtOpen|crtPipe) != crtOpen|crtPipe {
		return 0, false
	}
	offset := 4 + entries + fd*handleSize
	var value uint64
	if handleSize == 8 {
		value = binary.LittleEndian.Uint64(buffer[offset:])
	} else {
		value = uint64(binary.LittleEndian.Uint32(buffer[offset:]))
	}
	handle := windows.Handle(value)
	if handle == 0 || handle == windows.InvalidHandle {
		return 0, false
	}
	return handle, true
}

// handleReader performs synchronous reads. Node's default child pipe end is not
// overlapped, and the handle remains open for the life of the process.
type handleReader windows.Handle

func (h handleReader) Read(buffer []byte) (int, error) {
	var count uint32
	if err := windows.ReadFile(windows.Handle(h), buffer, &count, nil); err != nil {
		return int(count), err
	}
	return int(count), nil
}

// terminateLostOwner exits; the process's kill-on-close editor Job then
// terminates every remaining descendant.
func terminateLostOwner() { os.Exit(OwnerLostExitCode) }
