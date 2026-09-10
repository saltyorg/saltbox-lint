package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestProcessInputCancellationClosesOnlyOwnedRead(t *testing.T) {
	source, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	defer writer.Close()
	before := fileFlags(t, source)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	input := &processInput{ctx: ctx, source: source}
	defer input.close()
	if _, err := writer.Write([]byte("ready")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(input, buf); err != nil {
		t.Fatal(err)
	}
	// Synchronize after Read's context check, before the real owned file read.
	// Cancellation must interrupt the read, not merely win a scheduling race.
	entered := make(chan struct{})
	input.reader = &observedRead{Reader: input.reader, entered: entered}
	done := make(chan error, 1)
	go func() { _, err := io.ReadAll(input); done <- err }()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("read error: %v", err)
		}
	case <-time.After(time.Second):
		// Always release and join the read before failing, including against RED.
		_ = writer.Close()
		<-done
		t.Fatal("cancellation left input read blocked")
	}
	input.close()
	if after := fileFlags(t, source); after != before {
		t.Fatalf("caller flags changed: before=%x after=%x", before, after)
	}
	if _, err := writer.Write([]byte("owned")); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(source, buf); err != nil {
		t.Fatalf("caller input closed: %v", err)
	}
	if string(buf) != "owned" {
		t.Fatalf("caller input: %q", buf)
	}
}

type observedRead struct {
	io.Reader
	entered chan struct{}
}

func (r *observedRead) Read(p []byte) (int, error) {
	if r.entered != nil {
		close(r.entered)
		r.entered = nil
	}
	return r.Reader.Read(p)
}

func TestProcessInputPreservesRedirectedFileOffset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "input")
	if err := os.WriteFile(path, []byte("skipremaining"), 0600); err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if _, err := source.Seek(4, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	input := &processInput{ctx: t.Context(), source: source}
	defer input.close()
	data, err := io.ReadAll(input)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "remaining" {
		t.Fatalf("lost redirected offset: %q", data)
	}
	input.close()
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		t.Fatalf("caller source closed: %v", err)
	}
}

func TestProcessInputCancellationBeforeReadDoesNotConsumeInput(t *testing.T) {
	source, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	defer writer.Close()
	if _, err := writer.Write([]byte("untouched")); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	input := &processInput{ctx: ctx, source: source}
	defer input.close()
	if _, err := io.ReadAll(input); !errors.Is(err, context.Canceled) {
		t.Fatalf("read after cancel: %v", err)
	}
	data, err := io.ReadAll(source)
	if err != nil || string(data) != "untouched" {
		t.Fatalf("consumed caller input: %q %v", data, err)
	}
}

func fileFlags(t *testing.T, file *os.File) uintptr {
	t.Helper()
	raw, err := file.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var flags uintptr
	var errno syscall.Errno
	if err := raw.Control(func(fd uintptr) { flags, _, errno = syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFL, 0) }); err != nil {
		t.Fatal(err)
	}
	if errno != 0 {
		t.Fatal(errno)
	}
	return flags
}
