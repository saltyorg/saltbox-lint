package nativeio

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// CreatePipe produces the synchronous inherited handles used by shells and
// Node child_process; os.Pipe can instead produce overlapped Go-owned handles.
func TestReadSynchronousPipeCancellationAndCallerReuse(t *testing.T) {
	for range 50 {
		var read, write windows.Handle
		if err := windows.CreatePipe(&read, &write, nil, 0); err != nil {
			t.Fatal(err)
		}
		source := os.NewFile(uintptr(read), "read")
		writer := os.NewFile(uintptr(write), "write")
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		entered := make(chan struct{})
		go func() { close(entered); _, err := Read(ctx, source, make([]byte, 1)); done <- err }()
		<-entered
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("read: %v", err)
			}
		case <-time.After(time.Second):
			_ = writer.Close()
			<-done
			t.Fatal("read cancellation blocked")
		}
		if _, err := writer.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, 1)
		if _, err := io.ReadFull(source, data); err != nil || string(data) != "x" {
			t.Fatalf("caller reuse: %q %v", data, err)
		}
		_ = writer.Close()
		if _, err := Read(t.Context(), source, data); !errors.Is(err, io.EOF) {
			t.Fatalf("EOF: %v", err)
		}
		_ = source.Close()
	}
}

func TestReadRejectsOverlappedHandle(t *testing.T) {
	path := t.TempDir() + `\overlapped`
	if err := os.WriteFile(path, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(handle), "overlapped")
	defer func() { _ = file.Close() }()
	if _, err := Read(t.Context(), file, make([]byte, 4)); !errors.Is(err, ErrOverlappedHandle) {
		t.Fatalf("overlapped read: %v", err)
	}
}
