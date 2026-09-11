// Package cmd owns command routing and exit status, without linter policy.
package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"
)

// Streams are explicit process I/O. Nil outputs discard and nil input is empty.
type Streams struct {
	In       io.Reader
	Out, Err io.Writer
}

var errFindings = errors.New("lint findings")

type rootOptions struct {
	color string
}

// NewRootCommand creates an independent command tree for one invocation.
func NewRootCommand(streams Streams, version string) *cobra.Command {
	var opts rootOptions
	if streams.In == nil {
		streams.In = strings.NewReader("")
	}
	if streams.Out == nil {
		streams.Out = io.Discard
	}
	if streams.Err == nil {
		streams.Err = io.Discard
	}
	if version == "" {
		version = "dev"
	}
	root := &cobra.Command{
		Use:           "saltbox-lint",
		Short:         "Check Saltbox and Sandbox source policy",
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
		Args:          cobra.NoArgs,
		RunE:          func(command *cobra.Command, _ []string) error { return command.Help() },
		PersistentPreRunE: func(_ *cobra.Command, _ []string) error {
			return validateColorMode(opts.color)
		},
	}
	root.SetIn(streams.In)
	root.SetOut(streams.Out)
	root.SetErr(streams.Err)
	root.CompletionOptions.DisableDefaultCmd = true
	root.PersistentFlags().StringVar(&opts.color, "color", "auto", "Color: auto, always, never")
	root.AddCommand(newCheckCommand(&opts), newRulesCommand(&opts))
	return root
}

// Run reports operational/usage errors exactly once to stderr. Findings are
// already rendered (on stderr in diff mode). Exit codes are 0 clean, 1 findings,
// 2 failure. Injected readers remain caller-owned; callers must arrange any
// cancellation needed by a blocking reader.
func Run(ctx context.Context, args []string, streams Streams, version string) int {
	root := NewRootCommand(streams, version)
	root.SetArgs(args)
	err := root.ExecuteContext(ctx)
	if errors.Is(err, errFindings) {
		return 1
	}
	if err != nil {
		_, _ = fmt.Fprintf(root.ErrOrStderr(), "saltbox-lint: %v\n", err)
		return 2
	}
	return 0
}
