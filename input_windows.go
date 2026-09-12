package main

import (
	"context"
	"fmt"
	"os"

	"github.com/saltyorg/saltbox-lint/nativeio"
)

func (in *processInput) open() error {
	if _, err := in.source.Stat(); err != nil {
		return fmt.Errorf("inspect stdin: %w", err)
	}
	in.reader = windowsInput{ctx: in.ctx, source: in.source}
	return nil
}

type windowsInput struct {
	ctx    context.Context
	source *os.File
}

func (in windowsInput) Read(p []byte) (int, error) {
	return nativeio.Read(in.ctx, in.source, p)
}
