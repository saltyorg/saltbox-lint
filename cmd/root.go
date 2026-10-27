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
	theme string
}

// helpOutput records help and usage write failures. Cobra discards them, and
// its --help flag path returns no error, so Run consults the record.
type helpOutput struct{ err error }

func (h *helpOutput) write(w io.Writer, text string) error {
	_, err := io.WriteString(w, text)
	if err != nil && h.err == nil {
		h.err = err
	}
	return err
}

// NewRootCommand creates an independent command tree for one invocation.
func NewRootCommand(streams Streams, version string) *cobra.Command {
	root, _ := newRootCommand(streams, version)
	return root
}

func newRootCommand(streams Streams, version string) (*cobra.Command, *helpOutput) {
	var opts rootOptions
	help := &helpOutput{}
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
		RunE: func(command *cobra.Command, _ []string) error {
			command.HelpFunc()(command, nil)
			return help.err
		},
		PersistentPreRunE: func(_ *cobra.Command, _ []string) error {
			if err := validateColorMode(opts.color); err != nil {
				return err
			}
			return validateThemeMode(opts.theme)
		},
	}
	root.SetIn(streams.In)
	root.SetOut(streams.Out)
	root.SetErr(streams.Err)
	root.CompletionOptions.DisableDefaultCmd = true
	root.PersistentFlags().StringVar(&opts.color, "color", "auto", "Color: auto, always, never")
	root.PersistentFlags().StringVar(&opts.theme, "theme", "auto", "Theme: auto, dark, light (auto detects the terminal background)")
	root.AddCommand(newCheckCommand(&opts), newFormatCommand(), newRulesCommand(&opts), newExplainCommand(), newReferencesCommand(), newQueryCommand(), newScaffoldCommand())
	configureHelp(root, streams.Out, help)
	return root, help
}

// configureHelp renders Cobra's default help into memory, then writes it once
// so failures reach the shared exit-status path instead of being discarded.
// The default help command is kept for its completion, with a Run that
// returns write failures rather than exiting the process through CheckErr.
func configureHelp(root *cobra.Command, out io.Writer, help *helpOutput) {
	render := root.HelpFunc()
	root.SetHelpFunc(func(command *cobra.Command, args []string) {
		destination := command.OutOrStdout()
		var text strings.Builder
		command.SetOut(&text)
		render(command, args)
		// Only the root owns an explicit writer; subcommands inherit it.
		if command == root {
			command.SetOut(out)
		} else {
			command.SetOut(nil)
		}
		_ = help.write(destination, text.String())
	})
	root.InitDefaultHelpCmd()
	for _, command := range root.Commands() {
		if command.Name() != "help" {
			continue
		}
		command.Run = nil
		command.RunE = func(command *cobra.Command, args []string) error {
			target, _, err := command.Root().Find(args)
			if target == nil || err != nil {
				return help.write(command.OutOrStderr(), fmt.Sprintf("Unknown help topic %#q\n", args)+command.Root().UsageString())
			}
			target.InitDefaultHelpFlag()
			target.InitDefaultVersionFlag()
			target.HelpFunc()(target, nil)
			return help.err
		}
	}
}

// Run reports operational/usage errors exactly once to stderr. Findings are
// already rendered (on stderr in diff mode). Exit codes are 0 clean, 1 findings,
// 2 failure. Injected readers remain caller-owned; callers must arrange any
// cancellation needed by a blocking reader.
func Run(ctx context.Context, args []string, streams Streams, version string) int {
	root, help := newRootCommand(streams, version)
	root.SetArgs(args)
	err := root.ExecuteContext(ctx)
	if err == nil {
		err = help.err
	}
	if errors.Is(err, errFindings) {
		return 1
	}
	if err != nil {
		_, _ = fmt.Fprintf(root.ErrOrStderr(), "saltbox-lint: %v\n", err)
		return 2
	}
	return 0
}
