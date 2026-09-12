package report

import (
	"bytes"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestPreviewDoesNotChangeMachineFormats(t *testing.T) {
	p, ds := sample()
	ds[0].Fix = nil
	for _, format := range []string{"json", "concise", "github"} {
		t.Run(format, func(t *testing.T) {
			var before, after, beforeSummary, afterSummary bytes.Buffer
			ds[0].Preview = nil
			if err := Render(&before, p, ds, Options{Format: format, Summary: &beforeSummary}); err != nil {
				t.Fatal(err)
			}
			ds[0].Preview = &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: 8, End: 9}, Text: "y"}}}
			if err := Render(&after, p, ds, Options{Format: format, Summary: &afterSummary}); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before.Bytes(), after.Bytes()) || !bytes.Equal(beforeSummary.Bytes(), afterSummary.Bytes()) {
				t.Fatalf("preview altered %s output", format)
			}
			if got := diagnostics(p, ds)[0]; got.preview == nil || got.Fix != nil {
				t.Fatalf("projection=%+v", got)
			}
		})
	}
}

func TestPreviewOnlyDoesNotIncreaseFixCountOrPatch(t *testing.T) {
	p, ds := sample()
	p.Selected = map[string]bool{"a.yml": true}
	ds[0].Fix = nil
	ds[0].Preview = &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: 8, End: 9}, Text: "y"}}}
	records := diagnostics(p, ds)
	if actualFix(records[0].Fix) {
		t.Fatal("preview counted as fix")
	}
	changes, err := lint.PlanFixes(p, ds)
	if err != nil {
		t.Fatal(err)
	}
	var patch bytes.Buffer
	if err := Diff(&patch, changes); err != nil {
		t.Fatal(err)
	}
	if patch.Len() != 0 {
		t.Fatal("manual preview entered patch output")
	}
}
