//go:build linux || darwin

package cmd

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"testing"

	"github.com/charmbracelet/x/term"
	"golang.org/x/sys/unix"
)

func TestPTYDescriptorsWithoutControllingTerminal(t *testing.T) {
	if os.Getenv("SALTBOX_LINT_TEST_PTY_DESCRIPTORS") == "1" {
		for _, stream := range []*os.File{os.Stdin, os.Stdout, os.Stderr} {
			if !term.IsTerminal(stream.Fd()) {
				t.Fatalf("%s is not a terminal", stream.Name())
			}
			columns, rows, err := term.GetSize(stream.Fd())
			if err != nil || columns != 40 || rows != 24 {
				t.Fatalf("%s dimensions=%dx%d error=%v, want 40x24", stream.Name(), columns, rows, err)
			}
		}
		controlling, err := os.OpenFile("/dev/tty", os.O_RDWR|unix.O_NOCTTY, 0)
		if err == nil {
			_ = controlling.Close()
			t.Fatal("capture child owns a controlling terminal")
		}
		if !errors.Is(err, unix.ENXIO) {
			t.Fatalf("inspect controlling terminal: %v", err)
		}
		os.Exit(0)
	}
	command := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestPTYDescriptorsWithoutControllingTerminal$")
	command.Env = append(os.Environ(), "SALTBOX_LINT_TEST_PTY_DESCRIPTORS=1")
	output, err := runTestPTY(t, command, 40, "")
	if err != nil {
		t.Fatalf("PTY descriptor checks: %v: %q", err, output)
	}
}

func TestPTYCapturesCompleteOutput(t *testing.T) {
	stdout := bytes.Repeat([]byte("stdout"), 16*1024)
	stderr := bytes.Repeat([]byte("stderr"), 16*1024)
	if os.Getenv("SALTBOX_LINT_TEST_PTY_WRITER") == "1" {
		if _, err := os.Stdout.Write(stdout); err != nil {
			os.Exit(2)
		}
		if _, err := os.Stderr.Write(stderr); err != nil {
			os.Exit(2)
		}
		os.Exit(1)
	}
	// Both streams exceed the PTY buffer and the child exits immediately after
	// its final write. Capture must drain during execution and retain the tail.
	command := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestPTYCapturesCompleteOutput$")
	command.Env = append(os.Environ(), "SALTBOX_LINT_TEST_PTY_WRITER=1")
	output, err := runTestPTY(t, command, 40, "")
	if exitErr, ok := err.(*exec.ExitError); !ok || exitErr.ExitCode() != 1 {
		t.Fatalf("want writer exit 1, got %v (%d bytes)", err, len(output))
	}
	want := append(stdout, stderr...)
	if !bytes.Equal(output, want) {
		t.Fatalf("PTY capture differs: got %d bytes, want %d", len(output), len(want))
	}
}

func runTestPTY(t *testing.T, command *exec.Cmd, columns uint16, stdoutPath string) ([]byte, error) {
	t.Helper()
	master, slave := openTestPTY(t)
	if err := unix.IoctlSetWinsize(int(slave.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Row: 24, Col: columns}); err != nil {
		t.Fatal(err)
	}
	command.Stdin, command.Stdout, command.Stderr = slave, slave, slave
	if stdoutPath != "" {
		output, err := os.Create(stdoutPath)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = output.Close() }()
		command.Stdout = output
	}
	// Isolate capture from the host terminal without assigning a controlling
	// terminal. On Darwin, its session leader's exit revokes the slave even
	// while the parent retains it for the strict post-exit output drain.
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	// Cancellation closes the master as well as killing the command, so a
	// blocked reader or Darwin output drain can finish. Join the callback too.
	cancelled := make(chan struct{})
	stop := context.AfterFunc(t.Context(), func() {
		defer close(cancelled)
		_ = master.Close()
		_ = slave.Close()
	})
	defer func() {
		if !stop() {
			<-cancelled
		}
	}()
	type capture struct {
		output []byte
		err    error
	}
	read := make(chan capture, 1)
	go func() {
		output, err := io.ReadAll(master)
		if err != nil && (runtime.GOOS != "linux" || !errors.Is(err, unix.EIO)) {
			// A failed reader cannot drain the slave. Hang up the master so
			// Darwin's TIOCDRAIN cannot keep waiting for that reader.
			_ = master.Close()
		}
		read <- capture{output, err}
	}()
	// Keep a slave open until the child has exited and queued output has been
	// read. Darwin's last slave close flushes unread output. Read concurrently
	// so a child writing more than the PTY buffer can still finish.
	waitErr := command.Wait()
	drainErr := drainTestPTY(slave)
	_ = slave.Close()
	result := <-read
	if result.err != nil && (runtime.GOOS != "linux" || !errors.Is(result.err, unix.EIO)) {
		t.Fatalf("read PTY after child exit %v: %v (%d bytes)", waitErr, result.err, len(result.output))
	}
	if drainErr != nil {
		t.Fatalf("drain PTY after child exit %v: %v (%d bytes)", waitErr, drainErr, len(result.output))
	}
	return result.output, waitErr
}
