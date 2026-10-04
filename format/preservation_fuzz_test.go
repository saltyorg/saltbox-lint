package format

import (
	"bytes"
	"slices"
	"testing"
	"unicode/utf8"

	"github.com/saltyorg/saltbox-lint/internal/fuzztest"
	"github.com/saltyorg/saltbox-lint/lint"
)

func FuzzWhitespaceFixes(f *testing.F) {
	for _, seed := range fuzztest.Seeds(f, "../lint/testdata/preservation") {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if !fuzztest.Bounded(data) {
			return
		}
		original := bytes.Clone(data)
		before, ds := lint.Parse("vars.yml", data)
		if len(ds) != 0 {
			return
		}
		edits, err := lint.FormattingEdits(before)
		if err != nil {
			if len(edits) != 0 {
				t.Fatal("declined formatting returned edits")
			}
			return
		}
		checkFuzzEdits(t, data, edits)
		project := &lint.Project{Sources: map[string]*lint.Source{before.Path: before}, Selected: map[string]bool{before.Path: true}}
		diagnostics := []lint.Diagnostic{{Path: before.Path, Fix: &lint.Fix{Edits: edits}}}
		changes, err := lint.PlanFixes(project, diagnostics)
		if err != nil {
			t.Fatal(err)
		}
		fuzztest.Unchanged(t, original, data)
		fuzztest.Unchanged(t, original, before.Data)
		if len(edits) == 0 {
			if len(changes) != 0 {
				t.Fatal("already valid bytes received a whitespace change")
			}
			return
		}
		if len(changes) == 0 {
			return // The authoritative planner may fail closed.
		}
		if len(changes) != 1 || !bytes.Equal(changes[0].Before, original) {
			t.Fatal("whitespace plan lost its original snapshot")
		}
		projection, err := lint.PlannedFixEdits(changes[0])
		if err != nil {
			t.Fatal(err)
		}
		checkFuzzEdits(t, data, projection)
		if !bytes.Equal(apply(data, projection), changes[0].After) {
			t.Fatal("projected edits differ from the accepted plan")
		}
		after, ds := lint.Parse(before.Path, changes[0].After)
		if len(ds) != 0 {
			t.Fatal(ds)
		}
		// The existing yaml.v3 verifier protects typed meaning, comments, styles,
		// anchors and literal/Jinja tokens independently of the planner parser.
		if err := verify(t.Context(), before, after, true); err != nil {
			t.Fatal(err)
		}
		again, err := lint.FormattingEdits(after)
		if err != nil || len(again) != 0 {
			t.Fatalf("complete whitespace plan not idempotent: %v %v", again, err)
		}
		project.Selected[before.Path] = false
		if changes, err := lint.PlanFixes(project, diagnostics); err != nil || len(changes) != 0 {
			t.Fatal("whitespace fix touched an unselected source")
		}
	})
}

func FuzzCanonicalFormatting(f *testing.F) {
	for _, seed := range fuzztest.Seeds(f, "../lint/testdata/preservation") {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if !fuzztest.Bounded(data) {
			return
		}
		original := bytes.Clone(data)
		result, err := Plan(t.Context(), "vars.yml", data)
		if err != nil {
			t.Fatal(err)
		}
		fuzztest.Unchanged(t, original, data)
		switch result.Status {
		case "skipped":
			if result.Reason == "" || len(result.Edits) != 0 {
				t.Fatal("unsupported input did not fail closed")
			}
			return
		case "unchanged":
			if len(result.Edits) != 0 {
				t.Fatal("unchanged result supplied edits")
			}
		case "ready":
			if len(result.Edits) == 0 {
				t.Fatal("ready result omitted edits")
			}
		default:
			t.Fatalf("unknown result status %q", result.Status)
		}
		if !utf8.Valid(data) {
			t.Fatal("formatter accepted invalid UTF-8")
		}
		checkFuzzEdits(t, data, result.Edits)
		final := apply(data, result.Edits)
		if result.Status == "ready" && bytes.Equal(data, final) {
			t.Fatal("ready edits did not change bytes")
		}
		before, bd := lint.Parse("vars.yml", data)
		after, ad := lint.Parse("vars.yml", final)
		if len(bd)+len(ad) != 0 {
			t.Fatal("accepted plan contains invalid YAML")
		}
		old, err := parseIndependent(t.Context(), data)
		if err != nil {
			t.Fatal(err)
		}
		current, err := parseIndependent(t.Context(), final)
		if err != nil {
			t.Fatal(err)
		}
		comments, err := parseIndependent(t.Context(), apply(data, lint.FormattingSectionEdits(before)))
		if err != nil {
			t.Fatal(err)
		}
		if len(old) != len(current) || len(old) != len(comments) || len(before.Documents) != len(after.Documents) {
			t.Fatal("canonical plan changed document count")
		}
		for i := range old {
			if err := equivalentYAML(t.Context(), old[i], current[i], comments[i], true); err != nil {
				t.Fatal(err)
			}
		}
		for i := range before.Documents {
			if err := equivalentSource(t.Context(), before.Documents[i], after.Documents[i], true); err != nil {
				t.Fatal(err)
			}
		}
		if !slices.Equal(documentSyntax(data), documentSyntax(final)) || bytes.HasSuffix(data, []byte("\n")) != bytes.HasSuffix(final, []byte("\n")) {
			t.Fatal("canonical plan changed document syntax or final newline")
		}
		// At the lexical level, reuse the independent verifier on the canonical
		// phase. The final phase permits only the shared authorized whitespace.
		canonical, _, err := canonicalCandidate(t.Context(), before)
		if err != nil {
			t.Fatal(err)
		}
		middle, md := lint.Parse("vars.yml", canonical)
		if len(md) != 0 {
			t.Fatal(md)
		}
		if err := verify(t.Context(), before, middle, false); err != nil {
			t.Fatal(err)
		}
		if err := verify(t.Context(), middle, after, true); err != nil {
			t.Fatal(err)
		}
		again, err := Plan(t.Context(), "vars.yml", final)
		if err != nil || again.Status != "unchanged" || len(again.Edits) != 0 {
			t.Fatalf("canonical plan not idempotent: %+v %v", again, err)
		}
	})
}

func checkFuzzEdits(t *testing.T, data []byte, edits []lint.Edit) {
	t.Helper()
	last := 0
	for _, edit := range edits {
		fuzztest.Span(t, data, edit.Span.Start, edit.Span.End)
		if edit.Span.Start < last {
			t.Fatal("edit spans overlap or are unordered")
		}
		if utf8.Valid(data) && (!fuzztest.Boundary(data, edit.Span.Start) || !fuzztest.Boundary(data, edit.Span.End) || !utf8.ValidString(edit.Text)) {
			t.Fatal("edit splits Unicode/CRLF or inserts invalid UTF-8")
		}
		last = edit.Span.End
	}
}
