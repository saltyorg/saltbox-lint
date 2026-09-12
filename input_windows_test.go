package main

import (
	"os"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func fileFlags(t *testing.T, file *os.File) uintptr {
	t.Helper()
	// Pipe handle inheritance is caller-owned, just like Unix status flags.
	var flags uint32
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetHandleInformation")
	if ok, _, err := proc.Call(file.Fd(), uintptr(unsafe.Pointer(&flags))); ok == 0 {
		t.Fatal(err)
	}
	return uintptr(flags)
}
