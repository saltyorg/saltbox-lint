package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/saltyorg/saltbox-lint/cmd"
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

func socketPair(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	source, peer := os.NewFile(uintptr(fds[0]), "stdin-socket"), os.NewFile(uintptr(fds[1]), "stdin-peer")
	t.Cleanup(func() { _ = source.Close(); _ = peer.Close() })
	return source, peer
}

func shutdownWriter(t *testing.T, peer *os.File) {
	t.Helper()
	raw, err := peer.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var shutdownErr error
	if err := raw.Control(func(fd uintptr) { shutdownErr = syscall.Shutdown(int(fd), syscall.SHUT_WR) }); err != nil {
		t.Fatal(err)
	}
	if shutdownErr != nil {
		t.Fatal(shutdownErr)
	}
}

func TestSocketProcessInputValidYAMLAndEOF(t *testing.T) {
	source, peer := socketPair(t)
	before := fileFlags(t, source)
	if _, err := peer.Write([]byte("v: true\n")); err != nil {
		t.Fatal(err)
	}
	shutdownWriter(t, peer)
	input := &processInput{ctx: t.Context(), source: source}
	defer input.close()
	var out, stderr bytes.Buffer
	filename := filepath.Join(t.TempDir(), "virtual.yml")
	code := cmd.Run(t.Context(), []string{"check", "-", "--stdin-filename", filename, "--format", "json"}, cmd.Streams{In: input, Out: &out, Err: &stderr}, "test")
	if code != 0 || out.String() != "{\"diagnostics\":[]}\n" || stderr.Len() != 0 {
		t.Fatalf("code=%d out=%q err=%q", code, &out, &stderr)
	}
	input.close()
	if after := fileFlags(t, source); after != before {
		t.Fatalf("caller flags changed: %x => %x", before, after)
	}
	if _, err := os.Stat(filename); !os.IsNotExist(err) {
		t.Fatalf("virtual file appeared: %v", err)
	}
}

func TestSocketProcessInputWaitsAtMostOneRetryForData(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		source, peer := socketPair(t)
		input := &processInput{ctx: t.Context(), source: source}
		defer input.close()
		done := make(chan error, 1)
		go func() {
			data, err := io.ReadAll(input)
			if err == nil && string(data) != "later" {
				err = fmt.Errorf("data=%q", data)
			}
			done <- err
		}()
		// The real MSG_DONTWAIT call must reach its timer before data is supplied.
		synctest.Wait()
		start := time.Now()
		if _, err := peer.Write([]byte("later")); err != nil {
			t.Fatal(err)
		}
		shutdownWriter(t, peer)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(start); elapsed <= 0 || elapsed > 10*time.Millisecond {
			t.Fatalf("readiness retry delay=%s", elapsed)
		}
	})
}

func TestSocketProcessInputCancelsWhileIdleAndPreservesCaller(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		source, peer := socketPair(t)
		before := fileFlags(t, source)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		input := &processInput{ctx: ctx, source: source}
		defer input.close()
		done := make(chan error, 1)
		go func() { _, err := io.ReadAll(input); done <- err }()
		synctest.Wait()
		// Exercise multiple idle retries before cancelling between timer ticks.
		time.Sleep(25 * time.Millisecond)
		synctest.Wait()
		start := time.Now()
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled read: %v", err)
		}
		if elapsed := time.Since(start); elapsed != 0 {
			t.Fatalf("cancellation waited for retry: %s", elapsed)
		}
		input.close()
		if after := fileFlags(t, source); after != before {
			t.Fatalf("caller flags changed: %x => %x", before, after)
		}
		if _, err := peer.Write([]byte("intact")); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, 6)
		if _, err := io.ReadFull(source, data); err != nil {
			t.Fatal(err)
		}
		if string(data) != "intact" {
			t.Fatalf("caller socket unusable: %q", data)
		}
	})
}
