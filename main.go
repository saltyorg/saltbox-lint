package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/saltyorg/saltbox-lint/cmd"
)

// version is populated by release builds with -X main.version=….
var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	// Restore normal signal termination after cancellation as a fallback for
	// operations outside our interruptible input boundary.
	restoreSignals := context.AfterFunc(ctx, stop)
	input := &processInput{ctx: ctx, source: os.Stdin}
	code := cmd.Run(ctx, os.Args[1:], cmd.Streams{In: input, Out: os.Stdout, Err: os.Stderr}, version)
	input.close()
	restoreSignals()
	stop()
	os.Exit(code)
}
