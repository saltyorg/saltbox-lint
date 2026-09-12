package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"

	canonicalformat "github.com/saltyorg/saltbox-lint/format"
	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/report"
	"github.com/spf13/cobra"
)

type formatOptions struct {
	root          string
	mode          string
	stdinFilename string
}

type formatResponse struct {
	SchemaVersion int           `json:"schema_version"`
	Path          string        `json:"path"`
	SourceSHA256  string        `json:"source_sha256"`
	Status        string        `json:"status"`
	Edits         []report.Edit `json:"edits"`
	Reason        string        `json:"reason,omitempty"`
}

type plannedFormat struct {
	status string
	edits  []lint.Edit
	reason string
	source *lint.Source
}

func newFormatCommand() *cobra.Command {
	var opts formatOptions
	command := &cobra.Command{
		Use:   "format --stdin-filename PATH [--mode canonical|lint-fixes] -",
		Short: "Plan verified source edits for an editor buffer",
		Long: "Read exactly one YAML snapshot from stdin and emit a read-only JSON edit plan.\n" +
			"Exit status: 0 for ready, unchanged, or skipped plans; 2 for usage or operational failure.",
		Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			return runFormat(command, args[0], opts)
		},
	}
	flags := command.Flags()
	flags.StringVar(&opts.root, "root", "", "Source root for the returned file identity and lint context")
	flags.StringVar(&opts.mode, "mode", "canonical", "Edit plan: canonical or lint-fixes")
	flags.StringVar(&opts.stdinFilename, "stdin-filename", "", "Working-directory-relative filename for the stdin snapshot")
	return command
}

func runFormat(command *cobra.Command, selection string, opts formatOptions) error {
	if err := command.Context().Err(); err != nil {
		return err
	}
	if selection != "-" {
		return fmt.Errorf("format reads exactly one '-' stdin selection")
	}
	if opts.stdinFilename == "" {
		return fmt.Errorf("'-' and --stdin-filename must be used together")
	}
	if opts.mode != "canonical" && opts.mode != "lint-fixes" {
		return fmt.Errorf("unknown format mode %q", opts.mode)
	}
	identity, err := lint.ResolveSourceIdentity(opts.root, opts.stdinFilename)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(command.InOrStdin())
	if err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	if err := command.Context().Err(); err != nil {
		return err
	}

	plan, err := planFormat(command.Context(), opts.mode, identity, data)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(data)
	response := formatResponse{
		SchemaVersion: 1,
		Path:          identity.Path,
		SourceSHA256:  hex.EncodeToString(hash[:]),
		Status:        plan.status,
		Edits:         sourceEdits(plan.source, plan.edits),
		Reason:        plan.reason,
	}
	if err := json.NewEncoder(command.OutOrStdout()).Encode(response); err != nil {
		return fmt.Errorf("write format response: %w", err)
	}
	return nil
}

func planFormat(ctx context.Context, mode string, identity lint.SourceIdentity, data []byte) (plannedFormat, error) {
	if mode == "canonical" {
		result, err := canonicalformat.Plan(ctx, identity.Path, data)
		if err != nil {
			return plannedFormat{}, err
		}
		source, _ := lint.Parse(identity.Path, data)
		return plannedFormat{status: result.Status, edits: result.Edits, reason: result.Reason, source: source}, nil
	}

	filename := filepath.Join(identity.Root, filepath.FromSlash(identity.Path))
	project, err := lint.Load(ctx, lint.Options{Root: identity.Root, StdinFilename: filename, Stdin: data})
	if err != nil {
		return plannedFormat{}, err
	}
	source := project.Sources[identity.Path]
	if source == nil || !project.Selected[identity.Path] {
		return plannedFormat{}, fmt.Errorf("selected source %q is unavailable after loading context", identity.Path)
	}
	diagnostics := lint.Analyze(project, lint.Rules())
	if err := ctx.Err(); err != nil {
		return plannedFormat{}, err
	}
	changes, err := lint.PlanFixes(project, diagnostics)
	if err != nil {
		return plannedFormat{}, err
	}
	if err := ctx.Err(); err != nil {
		return plannedFormat{}, err
	}
	if len(changes) == 0 {
		return plannedFormat{status: "unchanged", source: source}, nil
	}
	if len(changes) != 1 || changes[0].Path != identity.Path {
		return plannedFormat{}, fmt.Errorf("fix planner returned changes outside selected source %q", identity.Path)
	}
	edits, err := lint.PlannedFixEdits(changes[0])
	if err != nil {
		return plannedFormat{}, err
	}
	if len(edits) == 0 {
		return plannedFormat{status: "unchanged", source: source}, nil
	}
	return plannedFormat{status: "ready", edits: edits, source: source}, nil
}

func sourceEdits(source *lint.Source, edits []lint.Edit) []report.Edit {
	records := make([]report.Edit, 0, len(edits))
	for _, edit := range edits {
		start := source.Position(edit.Span.Start)
		end := source.Position(edit.Span.End)
		records = append(records, report.Edit{
			Range: report.Range{
				Start: report.Position{Line: start.Line, Column: start.Column},
				End:   report.Position{Line: end.Line, Column: end.Column},
			},
			Span: report.Span{Start: edit.Span.Start, End: edit.Span.End},
			Text: edit.Text,
		})
	}
	return records
}
