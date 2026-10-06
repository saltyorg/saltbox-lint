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
	root, format, stdinFilename, stdinSourceFilename, changedSince string
	fix, diff                                                      bool
	includeAnalysis                                                bool
	stats                                                          bool
}

func newCheckCommand(rootOpts *rootOptions) *cobra.Command {
	var opts checkOptions
	command := &cobra.Command{
		Use:   "check [paths...]",
		Short: "Check sources (defaults to the current directory)",
		Long: "Check YAML sources and explicitly selected read-only templates with their required context. Directory discovery keeps its existing YAML primary selection. --changed-since REF selects current worktree changes and dependents. Use '-' with --stdin-filename to check an unsaved buffer.\n" +
			"Exit status: 0 clean, 1 findings, 2 usage or operational failure.",
		RunE: func(command *cobra.Command, args []string) error {
			if command.Flags().Changed("changed-since") && opts.changedSince == "" {
				return fmt.Errorf("--changed-since requires a nonempty revision")
			}
			return runCheck(command, args, opts, rootOpts.color, rootOpts.theme)
		},
	}
	flags := command.Flags()
	flags.StringVar(&opts.changedSince, "changed-since", "", "Check current worktree changes from an exact commit and affected primary sources")
	flags.StringVar(&opts.root, "root", "", "Source root for identities and context")
	flags.StringVar(&opts.stdinFilename, "stdin-filename", "", "Working-directory-relative filename for '-' input")
	flags.StringVar(&opts.stdinSourceFilename, "stdin-source-filename", "", "Original source spelling for stdin classification; must resolve to the same source owner")
	flags.StringVar(&opts.format, "format", "auto", "Output format: auto, human, concise, json, github, sarif (auto uses human on a terminal)")
	flags.BoolVar(&opts.fix, "fix", false, "Apply verified formatting fixes and recheck")
	flags.BoolVar(&opts.diff, "diff", false, "Print unified formatting changes without writing")
	flags.BoolVar(&opts.includeAnalysis, "include-analysis", false, "Include versioned dependency records in JSON output")
	flags.BoolVar(&opts.stats, "stats", false, "Report versioned counts and phase timings (JSON field or stderr)")
	command.MarkFlagsMutuallyExclusive("fix", "diff")
	return command
}

func (opts checkOptions) loadOptions(args []string, in io.Reader) (lint.Options, error) {
	switch opts.format {
	case "auto", "human", "concise", "json", "github", "sarif":
	default:
		return lint.Options{}, fmt.Errorf("unknown output format %q", opts.format)
	}
	if opts.diff && (opts.format == "json" || opts.format == "github" || opts.format == "sarif") {
		return lint.Options{}, fmt.Errorf("--diff cannot use structured output")
	}
	if opts.includeAnalysis && opts.format != "json" {
		return lint.Options{}, fmt.Errorf("--include-analysis requires --format json")
	}
	load := lint.Options{Root: opts.root, IncludeAnalysis: opts.includeAnalysis, ChangedSince: opts.changedSince}
	if opts.changedSince != "" {
		if len(args) != 0 || opts.stdinFilename != "" || opts.stdinSourceFilename != "" || opts.fix {
			return load, fmt.Errorf("--changed-since cannot be combined with paths, stdin or --fix")
		}
		return load, nil
	}
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
	if opts.stdinSourceFilename != "" && stdin != 1 {
		return load, fmt.Errorf("--stdin-source-filename requires stdin")
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
		load.StdinSourceFilename = opts.stdinSourceFilename
		load.Stdin = data
	}
	if len(args) == 0 {
		load.Paths = []string{"."}
	}
	return load, nil
}

func runCheck(command *cobra.Command, args []string, opts checkOptions, colorMode, themeMode string) (resultErr error) {
	var statistics *checkStatistics
	if opts.stats {
		statistics = newCheckStatistics()
		defer func() { resultErr = statistics.finish(command.ErrOrStderr(), opts.format, resultErr) }()
	}
	statistics.begin("input")
	if err := command.Context().Err(); err != nil {
		return err
	}
	load, err := opts.loadOptions(args, command.InOrStdin())
	if err != nil {
		return err
	}
	statistics.end(nil)
	if statistics != nil {
		load.Statistics = &lint.LoadStatistics{}
	}
	diagnosticOutput := command.OutOrStdout()
	if opts.diff {
		diagnosticOutput = command.ErrOrStderr()
	}
	format, human := resolveCheckPresentation(command.Context(), diagnosticOutput, opts.format, colorMode, themeMode)
	statistics.begin("discovery_loading")
	project, err := lint.Load(command.Context(), load)
	statistics.end(err)
	statistics.parsing("parsing", load.Statistics, err)
	if err != nil {
		return err
	}
	if opts.fix {
		statistics.begin("fix_selection")
		if err := lint.RequireWritableSelection(project); err != nil {
			return err
		}
		statistics.end(nil)
	}
	statistics.begin("analysis")
	diagnostics := lint.Analyze(project, lint.Rules())
	if err := command.Context().Err(); err != nil {
		return err
	}
	statistics.end(nil)
	if statistics != nil {
		statistics.record.Initial = report.CountStatistics(project, diagnostics)
	}
	if opts.fix || opts.diff {
		statistics.begin("fix_planning")
		changes, err := lint.PlanFixes(project, diagnostics)
		if err != nil {
			return err
		}
		statistics.end(nil)
		if statistics != nil {
			count := len(changes)
			statistics.record.PlannedFiles = &count
		}
		if opts.diff {
			statistics.begin("rendering")
			if err := report.Diff(command.OutOrStdout(), changes); err != nil {
				return err
			}
			var record *report.Statistics
			if statistics != nil {
				record = &statistics.record
			}
			if err := report.Render(command.ErrOrStderr(), project, diagnostics, report.Options{Format: format, Human: human, Statistics: record}); err != nil {
				return err
			}
			statistics.end(nil)
			if len(diagnostics) > 0 {
				return errFindings
			}
			return nil
		}
		statistics.begin("fix_writing")
		if err := lint.WriteChanges(project, changes); err != nil {
			return err
		}
		statistics.end(nil)
		if statistics != nil {
			count := len(changes)
			statistics.record.AppliedFiles = &count
			load.Statistics = &lint.LoadStatistics{}
		}
		statistics.begin("recheck_discovery_loading")
		project, err = lint.Load(command.Context(), load)
		statistics.end(err)
		statistics.parsing("recheck_parsing", load.Statistics, err)
		if err != nil {
			return err
		}
		statistics.begin("recheck_analysis")
		diagnostics = lint.Analyze(project, lint.Rules())
		statistics.end(command.Context().Err())
		if statistics != nil && command.Context().Err() == nil {
			statistics.record.Rechecked = report.CountStatistics(project, diagnostics)
		}
	}
	if err := command.Context().Err(); err != nil {
		return err
	}
	var record *report.Statistics
	if statistics != nil {
		record = &statistics.record
	}
	if format == "json" && record != nil {
		record.Phases = append(record.Phases, report.StatisticsPhase{Name: "encoding_writing", Status: "unavailable", Scope: "wall"})
	} else {
		statistics.begin("rendering")
	}
	if format == "sarif" {
		err = report.Render(command.OutOrStdout(), project, diagnostics, report.Options{Format: format, Version: command.Root().Version, Statistics: record})
	} else {
		err = renderCheck(command.Context(), command.OutOrStdout(), project, diagnostics, format, human, record)
	}
	if err != nil {
		if format == "json" && record != nil {
			for i := range record.Phases {
				if record.Phases[i].Name == "encoding_writing" {
					record.Phases[i].Status = "failed"
				}
			}
		}
		return err
	}
	statistics.end(nil)
	if len(diagnostics) > 0 {
		return errFindings
	}
	return nil
}

func renderCheck(ctx context.Context, out io.Writer, project *lint.Project, diagnostics []lint.Diagnostic, format string, human report.HumanOptions, statistics *report.Statistics) error {
	opts := report.Options{Format: format, Human: human, Statistics: statistics}
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
