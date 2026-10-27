//go:build !windows

package editorprocess

import (
	"io"
	"os"
	"syscall"
	"time"
)

// terminationGrace bounds the wait for an accepted group SIGKILL to reach this
// process. Signal acceptance is not delivery on every POSIX kernel.
const terminationGrace = 5 * time.Second

func openLifetime() io.Reader { return openDescriptor(3) }

// openDescriptor accepts only an inherited pipe or socket. Node creates stdio
// pipes as Unix socket pairs; FIFOs are accepted for other owners.
func openDescriptor(fd int) io.Reader {
	var status syscall.Stat_t
	if err := syscall.Fstat(fd, &status); err != nil {
		return nil
	}
	if mode := status.Mode & syscall.S_IFMT; mode != syscall.S_IFSOCK && mode != syscall.S_IFIFO {
		return nil
	}
	// The inherited descriptor lacks close-on-exec. Keep it out of Git and other
	// descendants so only this process observes the protocol.
	syscall.CloseOnExec(fd)
	return os.NewFile(uintptr(fd), "editor-lifetime")
}

// terminateLostOwner kills the group this process leads, including hung
// descendants, while the editor can no longer do so. Writing a diagnostic is
// deliberately avoided: stderr's reader is gone and SIGPIPE could pre-empt the
// group signal. A process that does not lead its group never signals siblings.
func terminateLostOwner() {
	pid := os.Getpid()
	if pid > 1 && syscall.Getpgrp() == pid {
		if err := syscall.Kill(-pid, syscall.SIGKILL); err == nil {
			time.Sleep(terminationGrace)
		}
	}
	os.Exit(OwnerLostExitCode)
}
