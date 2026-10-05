package report

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
)

// RenderReferences reports source-owned inspection without lint findings.
func RenderReferences(out io.Writer, references lint.ReferenceReport, format string) error {
	if format == "json" {
		return json.NewEncoder(out).Encode(references)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Root: %q\nContract: %s\nResolution describes declaration candidates; runtime values and precedence are unmodeled.\n", references.Root, references.Contract)
	for _, source := range references.Sources {
		fmt.Fprintf(&b, "Source: %q (%s)\n", source.Path, source.ParseState)
		for _, message := range source.ParseDiagnostics {
			fmt.Fprintf(&b, "  Parse: %s\n", message)
		}
	}
	for _, read := range references.References {
		fmt.Fprintf(&b, "%q:%d:%d: %s target=%q (%s) suffixes=%q: %s\n  Read: %q\n", read.Location.Path, read.Location.Line, read.Location.Column, read.LookupKind, read.Target, read.TargetKind, read.Suffixes, read.State, read.Location.Text)
		for _, reason := range read.Reasons {
			fmt.Fprintf(&b, "  Reason: %s\n", reason)
		}
		for _, alias := range read.AliasDeclarations {
			fmt.Fprintf(&b, "  Possible alias %q (%s): %q:%d:%d = %q\n", alias.Name, alias.Provenance, alias.Key.Path, alias.Key.Line, alias.Key.Column, alias.Value.Text)
		}
		for _, candidate := range read.Candidates {
			declaration := candidate.Declaration
			fmt.Fprintf(&b, "  Candidate %q (%s, %s, suffix=%q): %q:%d:%d\n    Source value: %q\n", declaration.Name, declaration.Provenance, candidate.LookupLayer, candidate.Suffix, declaration.Key.Path, declaration.Key.Line, declaration.Key.Column, declaration.Value.Text)
			for _, comment := range declaration.Comments {
				fmt.Fprintf(&b, "    Comment: %q\n", comment.Text)
			}
		}
		for _, hint := range read.SpellingCandidates {
			fmt.Fprintf(&b, "  Possible spelling %q: %q:%d:%d\n", hint.Name, hint.Key.Path, hint.Key.Line, hint.Key.Column)
		}
	}
	fmt.Fprintf(&b, "Reference count: %d\nDependency generation: %s\n", len(references.References), references.Dependencies.Generation)
	_, err := io.WriteString(out, b.String())
	return err
}
