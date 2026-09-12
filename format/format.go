// Package format plans verified canonical YAML source edits without file I/O.
package format

import (
	"bytes"
	"context"
	"fmt"
	"unicode/utf8"

	"github.com/saltyorg/saltbox-lint/lint"
)

// Result is a plan against the exact supplied UTF-8 snapshot. Status is ready,
// unchanged or skipped. Skipped results have a reason and no edits. Edit spans
// are ordered, nonoverlapping UTF-8 byte offsets in the original snapshot.
type Result struct {
	Status string
	Edits  []lint.Edit
	Reason string
}

// Plan constructs and independently verifies canonical edits. Syntax that
// cannot safely be transformed is a skipped result; cancellation is an error.
// The caller owns data, and no source or filesystem state is ever modified.
func Plan(ctx context.Context, filename string, data []byte) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	result, err := plan(ctx, filename, data)
	if canceled := ctx.Err(); canceled != nil {
		return Result{}, canceled
	}
	if err != nil {
		return Result{Status: "skipped", Reason: err.Error()}, nil
	}
	return result, nil
}

func plan(ctx context.Context, filename string, data []byte) (Result, error) {
	if !utf8.Valid(data) {
		return Result{}, fmt.Errorf("source is not valid UTF-8")
	}
	bare := bytes.ReplaceAll(data, []byte("\r\n"), nil)
	if bytes.ContainsRune(bare, '\r') || bytes.Contains(data, []byte("\r\n")) && bytes.ContainsRune(bare, '\n') {
		return Result{}, fmt.Errorf("mixed or unsupported line endings")
	}
	before, ds := lint.Parse(filename, data)
	if before.Kind == lint.Template {
		return Result{}, fmt.Errorf("templates are not YAML formatting sources")
	}
	if len(ds) > 0 {
		return Result{}, fmt.Errorf("invalid YAML: %s", ds[0].Message)
	}
	if _, err := parseIndependent(ctx, data); err != nil {
		return Result{}, err
	}
	after, structural, err := canonicalCandidate(ctx, before)
	if err != nil {
		return Result{}, err
	}
	candidate, ds := lint.Parse(filename, after)
	if len(ds) > 0 {
		return Result{}, fmt.Errorf("candidate is invalid YAML: %s", ds[0].Message)
	}
	if err = verify(ctx, before, candidate, false); err != nil {
		return Result{}, err
	}
	corrections, err := lint.FormattingEdits(candidate)
	if err != nil {
		return Result{}, err
	}
	final := applyEdits(after, corrections)
	formatted, ds := lint.Parse(filename, final)
	if len(ds) > 0 {
		return Result{}, fmt.Errorf("formatting correction is invalid YAML")
	}
	if err = verify(ctx, candidate, formatted, true); err != nil {
		return Result{}, err
	}
	if err = verifyDiagnostics(ctx, before, formatted); err != nil {
		return Result{}, err
	}
	again, _, err := canonicalCandidate(ctx, formatted)
	if err != nil {
		return Result{}, err
	}
	remaining, err := lint.FormattingEdits(formatted)
	if err != nil {
		return Result{}, err
	}
	if !bytes.Equal(final, again) || len(remaining) > 0 {
		return Result{}, fmt.Errorf("canonical candidate is not idempotent")
	}
	if bytes.Equal(data, final) {
		return Result{Status: "unchanged"}, nil
	}
	edits := composeEdits(data, structural, corrections)
	if !bytes.Equal(applyEdits(data, edits), final) {
		return Result{}, fmt.Errorf("source edit composition failed")
	}
	return Result{Status: "ready", Edits: edits}, nil
}
