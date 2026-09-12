//go:build linux || darwin

package cmd

import (
	"io"
	"os"
	"os/exec"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

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
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	_ = slave.Close()
	// Master EOF is EIO on Linux and EOF on Darwin. Drain while the child runs
	// so full PTY buffers cannot deadlock Wait; command cancellation kills it.
	output, _ := io.ReadAll(master)
	return output, command.Wait()
}
