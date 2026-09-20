//go:build linux || darwin

package cmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// The subprocess isolates the controlling terminal and signal handler from the
// test runner while exercising the real command tree and cancellation boundary.
func TestTerminalInterruptHelper(t *testing.T) {
	if os.Getenv("SALTBOX_LINT_TERMINAL_HELPER") != "1" {
		return
	}
	proof := os.NewFile(3, "terminal-proof")
	ack := os.NewFile(4, "terminal-ack")
	before, beforeErr := unix.IoctlGetTermios(int(os.Stdin.Fd()), terminalGetState)
	ctx, stop := signal.NotifyContext(t.Context(), os.Interrupt)
	code := Run(ctx, []string{"rules", "jinja-layout", "--theme", "auto", "--color", "always"}, Streams{In: os.Stdin, Out: os.Stdout, Err: os.Stderr}, "test")
	stop()
	after, afterErr := unix.IoctlGetTermios(int(os.Stdin.Fd()), terminalGetState)
	switch {
	case beforeErr != nil || afterErr != nil:
		fmt.Fprintf(proof, "terminal ioctl: before=%v after=%v\n", beforeErr, afterErr)
	case *after != *before:
		fmt.Fprintf(proof, "terminal mode changed: before=%+v after=%+v\n", before, after)
	default:
		fmt.Fprintln(proof, "restored")
	}
	var release [1]byte
	_, _ = io.ReadFull(ack, release[:])
	os.Exit(code)
}

func TestTerminalQueryPreservesInterruptAndRestoresMode(t *testing.T) {
	master, slave := openTestPTY(t)
	fd := int(master.Fd())
	before, err := unix.IoctlGetTermios(int(slave.Fd()), terminalGetState)
	if err != nil {
		t.Fatal(err)
	}
	if before.Lflag&unix.ISIG == 0 || before.Cc[unix.VINTR] != 3 {
		t.Fatalf("unexpected PTY interrupt mode: %+v", before)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, executable, "-test.run=^TestTerminalInterruptHelper$")
	command.Env = append(withoutEnvironment(withoutEnvironment(os.Environ(), "NO_COLOR"), "TERM"), "TERM=xterm-256color", "SALTBOX_LINT_TERMINAL_HELPER=1")
	command.Stdin, command.Stdout, command.Stderr = slave, slave, slave
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	proofRead, proofWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer proofRead.Close()
	defer proofWrite.Close()
	ackRead, ackWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer ackRead.Close()
	defer ackWrite.Close()
	command.ExtraFiles = []*os.File{proofWrite, ackRead}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	_ = proofWrite.Close()
	_ = ackRead.Close()
	defer func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	var output bytes.Buffer
	var proof bytes.Buffer
	sent := false
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		pollFDs := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}, {Fd: int32(proofRead.Fd()), Events: unix.POLLIN}}
		ready, err := unix.Poll(pollFDs, 100)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if ready == 0 {
			continue
		}
		if pollFDs[0].Revents&unix.POLLIN != 0 {
			var chunk [4096]byte
			n, err := unix.Read(fd, chunk[:])
			if err != nil {
				t.Fatal(err)
			}
			output.Write(chunk[:n])
			if !sent && bytes.Contains(output.Bytes(), []byte("\x1b]11;?")) {
				if _, err := unix.Write(fd, []byte{3}); err != nil {
					t.Fatal(err)
				}
				sent = true
			}
		}
		if pollFDs[1].Revents&unix.POLLIN != 0 {
			var chunk [4096]byte
			n, err := unix.Read(int(proofRead.Fd()), chunk[:])
			if err != nil {
				t.Fatal(err)
			}
			proof.Write(chunk[:n])
		}
		if strings.Contains(output.String(), "context canceled") && bytes.Contains(proof.Bytes(), []byte{'\n'}) {
			break
		}
	}
	if !sent || !strings.Contains(output.String(), "context canceled") || strings.Contains(output.String(), "Good example:") || proof.String() != "restored\n" {
		t.Fatalf("sent=%t output=%q proof=%q", sent, output.String(), proof.String())
	}
	after, err := unix.IoctlGetTermios(int(slave.Fd()), terminalGetState)
	if err != nil {
		t.Fatal(err)
	}
	if *after != *before {
		t.Fatalf("terminal mode changed: before=%+v after=%+v", before, after)
	}
	if _, err := ackWrite.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	err = command.Wait()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 2 {
		t.Fatalf("exit=%v output=%q proof=%q", err, output.String(), proof.String())
	}
}

func TestBackgroundQueryStopsBeforeInspectingOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := queryBackground(ctx, nil, backgroundQueryTimeout); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}
