package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/saltyorg/saltbox-lint/cmd"
	"github.com/saltyorg/saltbox-lint/internal/editorprocess"
)

// version is populated by release builds with -X main.version=….
var version = "dev"

func main() {
	if err := setupEditorProcess(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	// An editor invocation holds an inherited lifetime pipe. Its EOF means the
	// extension host died without joining this process, so no deadline remains.
	lifetime := editorprocess.WatchLifetime(context.Background())
	ctx, stop := signal.NotifyContext(lifetime, processSignals()...)
	// Restore normal signal termination after cancellation as a fallback for
	// operations outside our interruptible input boundary.
	restoreSignals := context.AfterFunc(ctx, stop)
	input := &processInput{ctx: ctx, source: os.Stdin}
	code := cmd.Run(ctx, os.Args[1:], cmd.Streams{In: input, Out: os.Stdout, Err: os.Stderr}, version)
	input.close()
	// Cancellation by owner loss must terminate descendants, not exit normally.
	editorprocess.ExitIfOwnerLost(lifetime)
	restoreSignals()
	stop()
	os.Exit(code)
}
