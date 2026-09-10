package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/report"
	"github.com/spf13/cobra"
)

type checkOptions struct {
	root, format, stdinFilename string
	fix, diff                   bool
}

func newCheckCommand() *cobra.Command {
	var opts checkOptions
	command := &cobra.Command{
		Use:   "check [paths...]",
		Short: "Check sources (defaults to the current directory)",
		Long: "Check YAML sources and their required context. Use '-' with --stdin-filename to check an unsaved buffer.\n" +
			"Exit status: 0 clean, 1 findings, 2 usage or operational failure.",
		RunE: func(command *cobra.Command, args []string) error { return runCheck(command, args, opts) },
	}
	flags := command.Flags()
	flags.StringVar(&opts.root, "root", "", "Source root for identities and context")
	flags.StringVar(&opts.stdinFilename, "stdin-filename", "", "Working-directory-relative filename for '-' input")
	flags.StringVar(&opts.format, "format", "human", "Output format: human, concise, json, github")
	flags.BoolVar(&opts.fix, "fix", false, "Apply verified formatting fixes and recheck")
	flags.BoolVar(&opts.diff, "diff", false, "Print unified formatting changes without writing")
	command.MarkFlagsMutuallyExclusive("fix", "diff")
	return command
}

func (opts checkOptions) loadOptions(args []string, in io.Reader) (lint.Options, error) {
	switch opts.format {
	case "human", "concise", "json", "github":
	default:
		return lint.Options{}, fmt.Errorf("unknown output format %q", opts.format)
	}
	if opts.diff && (opts.format == "json" || opts.format == "github") {
		return lint.Options{}, fmt.Errorf("--diff cannot use structured output")
	}
	load := lint.Options{Root: opts.root}
	stdin := 0
	for _, arg := range args {
		if arg == "-" {
			stdin++
		} else {
			load.Paths = append(load.Paths, arg)
		}
	}
	if stdin > 1 {
		return load, fmt.Errorf("stdin may be selected only once")
	}
	if (stdin == 1) != (opts.stdinFilename != "") {
		return load, fmt.Errorf("'-' and --stdin-filename must be used together")
	}
	if stdin == 1 {
		if opts.fix || opts.diff {
			return load, fmt.Errorf("--fix and --diff cannot be used with stdin")
		}
		data, err := io.ReadAll(in)
		if err != nil {
			return load, fmt.Errorf("read stdin: %w", err)
		}
		load.StdinFilename = opts.stdinFilename
		load.Stdin = data
	}
	if len(args) == 0 {
		load.Paths = []string{"."}
	}
	return load, nil
}

func runCheck(command *cobra.Command, args []string, opts checkOptions) error {
	if err := command.Context().Err(); err != nil {
		return err
	}
	load, err := opts.loadOptions(args, command.InOrStdin())
	if err != nil {
		return err
	}
	project, err := lint.Load(command.Context(), load)
	if err != nil {
		return err
	}
	diagnostics := lint.Analyze(project, lint.Rules())
	if err := command.Context().Err(); err != nil {
		return err
	}
	if opts.fix || opts.diff {
		changes, err := lint.PlanFixes(project, diagnostics)
		if err != nil {
			return err
		}
		if opts.diff {
			if err := report.Diff(command.OutOrStdout(), changes); err != nil {
				return err
			}
			if err := report.Render(command.ErrOrStderr(), project, diagnostics, report.Options{Format: opts.format}); err != nil {
				return err
			}
			if len(diagnostics) > 0 {
				return errFindings
			}
			return nil
		}
		if err := lint.WriteChanges(project, changes); err != nil {
			return err
		}
		project, err = lint.Load(command.Context(), load)
		if err != nil {
			return err
		}
		diagnostics = lint.Analyze(project, lint.Rules())
	}
	if err := command.Context().Err(); err != nil {
		return err
	}
	if err := renderCheck(command.Context(), command.OutOrStdout(), project, diagnostics, opts.format); err != nil {
		return err
	}
	if len(diagnostics) > 0 {
		return errFindings
	}
	return nil
}

func renderCheck(ctx context.Context, out io.Writer, project *lint.Project, diagnostics []lint.Diagnostic, format string) error {
	opts := report.Options{Format: format}
	if format != "github" {
		return report.Render(out, project, diagnostics, opts)
	}
	opts.GitHub = report.GitHub{Workspace: os.Getenv("GITHUB_WORKSPACE"), Repository: os.Getenv("GITHUB_REPOSITORY"), Commit: os.Getenv("GITHUB_SHA"), ServerURL: os.Getenv("GITHUB_SERVER_URL")}
	// Source roots can be subdirectories of a checkout; links are repo-relative,
	// whereas workflow annotation paths are workspace-relative.
	root, err := exec.CommandContext(ctx, "git", "-C", project.Root, "rev-parse", "--show-toplevel").Output()
	if err == nil {
		opts.GitHub.RepositoryRoot = strings.TrimSpace(string(root))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	summaryPath := os.Getenv("GITHUB_STEP_SUMMARY")
	if summaryPath == "" {
		return report.Render(out, project, diagnostics, opts)
	}
	summary, err := os.OpenFile(summaryPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return fmt.Errorf("open GitHub job summary: %w", err)
	}
	opts.Summary = summary
	renderErr := report.Render(out, project, diagnostics, opts)
	closeErr := summary.Close()
	return errors.Join(renderErr, closeErr)
}
