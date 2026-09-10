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
	code := cmd.Run(ctx, os.Args[1:], cmd.Streams{In: os.Stdin, Out: os.Stdout, Err: os.Stderr}, version)
	stop()
	os.Exit(code)
}
