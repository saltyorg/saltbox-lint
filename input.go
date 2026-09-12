package main

import (
	"context"
	"io"
	"os"
)

// processInput is the sole active consumer of source while a command runs.
// The caller retains descriptor ownership and may reuse it after close. Setup
// is lazy; commands that never read stdin need no valid descriptor.
type processInput struct {
	ctx     context.Context
	source  *os.File
	reader  io.Reader
	owned   *os.File
	stop    func() bool
	closed  chan struct{}
	release func()
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
	if in.release != nil {
		in.release()
		in.release = nil
	}
}
