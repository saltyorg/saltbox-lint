package cmd

import (
	"os"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
)

func openTestPTY(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = master.Close() })
	fd := int(master.Fd())
	for _, request := range []uint{unix.TIOCPTYGRANT, unix.TIOCPTYUNLK} {
		if err := unix.IoctlSetInt(fd, request, 0); err != nil {
			t.Fatal(err)
		}
	}
	// Darwin TIOCPTYGNAME writes char[128]. IoctlSetInt forwards a native-width
	// raw argument to libSystem ioctl: this request interprets it as a pointer,
	// despite the wrapper's name. Pin the complete output buffer across the
	// pointer-to-integer bridge; neither Darwin target narrows the argument.
	var name [128]byte
	var pin runtime.Pinner
	pin.Pin(&name[0])
	defer pin.Unpin()
	err = unix.IoctlSetInt(fd, unix.TIOCPTYGNAME, int(uintptr(unsafe.Pointer(&name[0]))))
	runtime.KeepAlive(&name)
	if err != nil {
		t.Fatal(err)
	}
	slave, err := os.OpenFile(unix.ByteSliceToString(name[:]), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = slave.Close() })
	return master, slave
}
