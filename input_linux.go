package main

import (
	"context"
	"fmt"
	"os"
	"syscall"
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
