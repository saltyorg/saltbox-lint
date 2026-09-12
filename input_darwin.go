package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func (in *processInput) open() error {
	info, err := in.source.Stat()
	if err != nil {
		return fmt.Errorf("inspect stdin: %w", err)
	}
	if info.Mode().IsRegular() {
		in.reader = in.source
		return nil
	}
	raw, err := in.source.SyscallConn()
	if err != nil {
		return fmt.Errorf("access stdin: %w", err)
	}
	if info.Mode()&os.ModeSocket != 0 {
		in.reader = socketInput{ctx: in.ctx, raw: raw}
		return nil
	}
	wake, cancel, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("open stdin cancellation pipe: %w", err)
	}
	in.owned = cancel
	in.closed = make(chan struct{})
	in.stop = context.AfterFunc(in.ctx, func() { _ = cancel.Close(); close(in.closed) })
	in.release = func() { _ = wake.Close() }
	in.reader = darwinInput{ctx: in.ctx, raw: raw, wake: wake}
	return nil
}

// Poll handles pipes and terminal canonical readiness without changing shared
// O_NONBLOCK or termios state. Unlike kqueue, it does not report /dev/tty as
// permanently ready. The processInput contract excludes competing source reads
// between readiness and read. A separate pipe wakes cancellation immediately.
type darwinInput struct {
	ctx  context.Context
	raw  syscall.RawConn
	wake *os.File
}

func (in darwinInput) Read(p []byte) (int, error) {
	for {
		if err := in.ctx.Err(); err != nil {
			return 0, err
		}
		if len(p) == 0 {
			return 0, nil
		}
		var n int
		var readErr error
		ready := false
		err := in.raw.Control(func(fd uintptr) {
			fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}, {Fd: int32(in.wake.Fd()), Events: unix.POLLIN}}
			count, err := unix.Poll(fds, -1)
			if err != nil {
				readErr = err
				return
			}
			if count == 0 {
				return
			}
			if err := in.ctx.Err(); err != nil {
				readErr = err
				return
			}
			ready = true
			n, readErr = unix.Read(int(fd), p)
		})
		if err != nil {
			return 0, err
		}
		if errors.Is(readErr, unix.EINTR) || errors.Is(readErr, unix.EAGAIN) {
			continue
		}
		if readErr != nil {
			return 0, readErr
		}
		if !ready {
			continue
		}
		if n == 0 {
			return 0, io.EOF
		}
		return n, nil
	}
}
