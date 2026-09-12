//go:build linux || darwin

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
	"golang.org/x/sys/unix"
)

func fileFlags(t *testing.T, file *os.File) uintptr {
	t.Helper()
	raw, err := file.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var flags int
	var flagErr error
	if err := raw.Control(func(fd uintptr) { flags, flagErr = unix.FcntlInt(fd, unix.F_GETFL, 0) }); err != nil {
		t.Fatal(err)
	}
	if flagErr != nil {
		t.Fatal(flagErr)
	}
	return uintptr(flags)
}

func socketPair(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	unix.CloseOnExec(fds[0])
	unix.CloseOnExec(fds[1])
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
	if code != 0 || out.String() != "{\"schema_version\":2,\"diagnostics\":[],\"fixes\":[]}\n" || stderr.Len() != 0 {
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
