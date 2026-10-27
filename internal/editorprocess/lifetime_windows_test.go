package editorprocess

import (
	"encoding/binary"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// libuvTable builds libuv's child stdio buffer: uint32 count, count CRT flag
// bytes, then count unaligned HANDLE values.
func libuvTable(flags []byte, handles []uint64) []byte {
	size := int(unsafe.Sizeof(windows.Handle(0)))
	buffer := make([]byte, 4+len(flags)+len(handles)*size)
	binary.LittleEndian.PutUint32(buffer, uint32(len(flags)))
	copy(buffer[4:], flags)
	for i, handle := range handles {
		offset := 4 + len(flags) + i*size
		if size == 8 {
			binary.LittleEndian.PutUint64(buffer[offset:], handle)
		} else {
			binary.LittleEndian.PutUint32(buffer[offset:], uint32(handle))
		}
	}
	return buffer
}

func TestLifetimeCRTTable(t *testing.T) {
	invalid := uint64(uintptr(windows.InvalidHandle))
	ignored := []byte{0, 0, 0}
	ignoredHandles := []uint64{invalid, invalid, invalid}
	valid := libuvTable(append(ignored, crtOpen|crtPipe), append(ignoredHandles, 0x1234))
	if handle, ok := crtHandle(valid, 3); !ok || handle != 0x1234 {
		t.Fatalf("libuv pipe descriptor not found: %#x %v", handle, ok)
	}
	for name, buffer := range map[string][]byte{
		"empty":      nil,
		"three fds":  libuvTable(ignored, ignoredHandles),
		"truncated":  valid[:len(valid)-1],
		"not open":   libuvTable(append(ignored, crtPipe), append(ignoredHandles, 0x1234)),
		"not pipe":   libuvTable(append(ignored, crtOpen|0x40), append(ignoredHandles, 0x1234)),
		"invalid":    libuvTable(append(ignored, crtOpen|crtPipe), append(ignoredHandles, invalid)),
		"null":       libuvTable(append(ignored, crtOpen|crtPipe), append(ignoredHandles, 0)),
		"huge count": append([]byte{0, 1, 0, 0}, valid[4:]...),
	} {
		t.Run(name, func(t *testing.T) {
			if _, ok := crtHandle(buffer, 3); ok {
				t.Fatal("invalid CRT table accepted")
			}
		})
	}
}

func TestLifetimeHandleReaderReportsBrokenPipe(t *testing.T) {
	var reader, writer windows.Handle
	if err := windows.CreatePipe(&reader, &writer, nil, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(reader) })
	onLost, lost := lostRecorder()
	ctx := watch(t.Context(), handleReader(reader), onLost)
	if err := windows.CloseHandle(writer); err != nil {
		t.Fatal(err)
	}
	awaitLost(t, lost)
	if ctx.Err() == nil {
		t.Fatal("closed owner handle did not cancel")
	}
}
