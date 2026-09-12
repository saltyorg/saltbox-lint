//go:build linux || darwin

package main

import (
	"context"
	"io"
	"syscall"
	"time"
)

// Sockets cannot be reopened through /proc. MSG_DONTWAIT applies to this read
// only, preserving the caller's shared descriptor flags. Idle sockets retry
// every 10ms (at most about 100 wakeups/second); cancellation wakes immediately.
// This small, short-lived CLI path needs neither a reader goroutine nor a new
// readiness-poller dependency.
type socketInput struct {
	ctx context.Context
	raw syscall.RawConn
}

func (in socketInput) Read(p []byte) (int, error) {
	for {
		if err := in.ctx.Err(); err != nil {
			return 0, err
		}
		if len(p) == 0 {
			return 0, nil
		}
		var n int
		var readErr error
		err := in.raw.Control(func(fd uintptr) { n, _, readErr = syscall.Recvfrom(int(fd), p, syscall.MSG_DONTWAIT) })
		if err != nil {
			return 0, err
		}
		switch readErr {
		case nil:
			if n == 0 {
				return 0, io.EOF
			}
			return n, nil
		case syscall.EINTR:
			continue
		case syscall.EAGAIN:
			timer := time.NewTimer(10 * time.Millisecond)
			select {
			case <-in.ctx.Done():
				timer.Stop()
				return 0, in.ctx.Err()
			case <-timer.C:
			}
		default:
			return 0, readErr
		}
	}
}
