//go:build linux || darwin

package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// lifetimeChild mirrors the extension's POSIX launch: a detached process group
// with Node's stdio socket pair at descriptor 3.
type lifetimeChild struct {
	command *exec.Cmd
	owner   *os.File
	output  bytes.Buffer
	done    chan struct{}
	err     error
	once    sync.Once
}

func startLifetimeCLI(t *testing.T, args, env []string) *lifetimeChild {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	unix.CloseOnExec(fds[0])
	unix.CloseOnExec(fds[1])
	inherited, owner := os.NewFile(uintptr(fds[0]), "lifetime-child"), os.NewFile(uintptr(fds[1]), "lifetime-owner")
	child := &lifetimeChild{owner: owner, done: make(chan struct{})}
	child.command = exec.Command(args[0], args[1:]...)
	child.command.Env = env
	child.command.ExtraFiles = []*os.File{inherited}
	child.command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	child.command.Stdout, child.command.Stderr = &child.output, &child.output
	startErr := child.command.Start()
	_ = inherited.Close()
	if startErr != nil {
		_ = owner.Close()
		t.Fatal(startErr)
	}
	go func() {
		child.err = child.command.Wait()
		close(child.done)
	}()
	t.Cleanup(func() {
		// Go's process handle refuses signals after Wait; owner loss is the
		// production cleanup path for any remaining group members.
		_ = child.command.Process.Kill()
		child.loseOwnerQuietly()
		select {
		case <-child.done:
		case <-time.After(lifetimeBound):
			t.Error("lifetime CLI cleanup did not join")
		}
	})
	return child
}

func (child *lifetimeChild) pid() int { return child.command.Process.Pid }

func (child *lifetimeChild) exited() bool {
	select {
	case <-child.done:
		return true
	default:
		return false
	}
}

func (child *lifetimeChild) loseOwnerQuietly() { child.once.Do(func() { _ = child.owner.Close() }) }

func (child *lifetimeChild) loseOwner(t *testing.T) {
	t.Helper()
	var err error
	child.once.Do(func() { err = child.owner.Close() })
	if err != nil {
		t.Fatal(err)
	}
}

// wait joins the CLI and its output pipe. Owner loss is SIGKILL from the
// CLI's own group signal; a nonleader would use the distinct exit status.
func (child *lifetimeChild) wait(t *testing.T, bound time.Duration) lifetimeResult {
	t.Helper()
	select {
	case <-child.done:
	case <-time.After(bound):
		t.Fatalf("CLI did not exit within %v", bound)
	}
	result := lifetimeResult{output: child.output.String()}
	var exit *exec.ExitError
	if errors.As(child.err, &exit) {
		result.code = exit.ExitCode()
		status, ok := exit.Sys().(syscall.WaitStatus)
		result.ownerLoss = ok && status.Signaled() && status.Signal() == syscall.SIGKILL
	} else if child.err != nil {
		t.Fatal(child.err)
	}
	return result
}
