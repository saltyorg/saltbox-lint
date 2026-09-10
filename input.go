package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"syscall"
)

// processInput owns only the handle it opens for pipe/terminal reads. Regular
// redirected files keep their inherited offset. Setup is lazy so commands that
// never read stdin do not need a valid descriptor or /proc access.
type processInput struct {
	ctx    context.Context
	source *os.File
	reader io.Reader
	owned  *os.File
	stop   func() bool
	closed chan struct{}
}

func (in *processInput) Read(p []byte) (int, error) {
	if err := in.ctx.Err(); err != nil {
		return 0, err
	}
	if in.reader == nil {
		if err := in.open(); err != nil {
			return 0, err
		}
	}
	n, err := in.reader.Read(p)
	if ctxErr := in.ctx.Err(); ctxErr != nil {
		return n, ctxErr
	}
	return n, err
}

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
	var owned *os.File
	var openErr error
	// An inherited blocking descriptor is not necessarily registered with Go's
	// poller. Dup would share O_NONBLOCK with the caller; reopening on Linux gives
	// us an independent open-file description whose Close interrupts Read.
	err = raw.Control(func(fd uintptr) {
		owned, openErr = os.OpenFile(fmt.Sprintf("/proc/self/fd/%d", fd), os.O_RDONLY|syscall.O_NONBLOCK, 0)
	})
	if err != nil {
		return fmt.Errorf("access stdin descriptor: %w", err)
	}
	if openErr != nil {
		return fmt.Errorf("open interruptible stdin: %w", openErr)
	}
	in.owned = owned
	in.reader = owned
	in.closed = make(chan struct{})
	in.stop = context.AfterFunc(in.ctx, func() { _ = owned.Close(); close(in.closed) })
	return nil
}

// close joins a cancellation callback before returning. No reader goroutine is
// launched, and the caller's original descriptor is never closed or retuned.
func (in *processInput) close() {
	if in.stop == nil {
		return
	}
	if !in.stop() {
		<-in.closed
	}
	_ = in.owned.Close()
	in.stop = nil
}
