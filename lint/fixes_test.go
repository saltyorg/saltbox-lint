package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPlanFixesRejectsConflictsAndSemanticEdits(t *testing.T) {
	p := layoutProject(t, "v: \"{{ a\n | f('a  b') }}\" # keep  spaces\n")
	for _, edits := range [][]Edit{
		{{Span: Span{9, 10}, Text: " "}, {Span: Span{9, 11}, Text: "\n"}},
		{{Span: Span{19, 21}, Text: " "}},
		{{Span: Span{0, 1}, Text: "x"}},
	} {
		cs, err := PlanFixes(p, []Diagnostic{{Path: "values.yml", Fix: &Fix{Edits: edits}}})
		if err != nil {
			continue
		}
		if len(cs) > 0 {
			t.Fatalf("unsafe edits accepted: %+v", edits)
		}
	}
	p.Selected["values.yml"] = false
	cs, err := PlanFixes(p, []Diagnostic{{Path: "values.yml", Fix: &Fix{Edits: []Edit{{Span: Span{9, 10}, Text: "       "}}}}})
	if err != nil || len(cs) > 0 {
		t.Fatalf("unselected changes: %+v %v", cs, err)
	}
}
func TestWriteChangesPreservesModeRejectsStaleAndSymlink(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "values.yml")
	before := []byte("v: \"{{ a\n | f }}\"\n")
	if err := os.WriteFile(path, before, 0640); err != nil {
		t.Fatal(err)
	}
	p := layoutProject(t, string(before))
	p.Root = root
	changes, err := PlanFixes(p, Analyze(p, Rules()))
	if err != nil || len(changes) != 1 {
		t.Fatalf("plan: %+v %v", changes, err)
	}
	if err := WriteChanges(p, changes); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(after, changes[0].After) {
		t.Fatalf("write: %q %v", after, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0640 {
		t.Fatalf("mode: %v %v", info, err)
	}
	if err := WriteChanges(p, changes); err == nil {
		t.Fatal("stale write accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target.yml")
	if err := os.WriteFile(target, before, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := WriteChanges(p, changes); err == nil {
		t.Fatal("symlink write accepted")
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, before) {
		t.Fatal("symlink target altered")
	}
}
func TestWriteChangesRejectsUnverifiedAndUnselectedChanges(t *testing.T) {
	root := t.TempDir()
	input := "v: value\n"
	p := layoutProject(t, input)
	p.Root = root
	path := filepath.Join(root, "values.yml")
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	for _, change := range []Change{{Path: "../escape", Before: []byte(input), After: []byte("bad")}, {Path: "values.yml", Before: []byte(input), After: []byte("v: changed\n")}} {
		if err := WriteChanges(p, []Change{change}); err == nil {
			t.Fatalf("unsafe write accepted: %+v", change)
		}
	}
	p.Selected["values.yml"] = false
	if err := WriteChanges(p, []Change{{Path: "values.yml", Before: []byte(input), After: []byte(input)}}); err == nil {
		t.Fatal("unselected write accepted")
	}
}

func TestPlanFixesDeclinesLiteralAndCommentWhitespaceChanges(t *testing.T) {
	input := "v: \"{{ 'a  b' }}\" # keep  spaces\n"
	p := layoutProject(t, input)
	for _, span := range []Span{{Start: 9, End: 11}, {Start: 24, End: 26}} {
		ds := []Diagnostic{{Path: "values.yml", Fix: &Fix{Edits: []Edit{{Span: span, Text: " "}}}}}
		changes, err := PlanFixes(p, ds)
		if err != nil || len(changes) > 0 {
			t.Fatalf("literal/comment edit: %+v %v", changes, err)
		}
	}
}
func TestWriteChangesPreflightsWholeBatch(t *testing.T) {
	root := t.TempDir()
	input := []byte("v: \"{{ a\n | f }}\"\n")
	p := layoutProject(t, string(input))
	p.Root = root
	second, _ := Parse("second.yml", input)
	p.Sources[second.Path] = second
	p.Selected[second.Path] = true
	for _, path := range []string{"values.yml", "second.yml"} {
		if err := os.WriteFile(filepath.Join(root, path), input, 0600); err != nil {
			t.Fatal(err)
		}
	}
	changes, err := PlanFixes(p, Analyze(p, jinjaRules()))
	if err != nil || len(changes) != 2 {
		t.Fatalf("changes %+v %v", changes, err)
	}
	if err := os.WriteFile(filepath.Join(root, "values.yml"), []byte("v: changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := WriteChanges(p, changes); err == nil {
		t.Fatal("stale batch accepted")
	}
	actual, err := os.ReadFile(filepath.Join(root, "second.yml"))
	if err != nil || !bytes.Equal(actual, input) {
		t.Fatalf("batch partially written despite preflight failure: %q %v", actual, err)
	}
}
func TestPlanFixesDeduplicatesEqualEdits(t *testing.T) {
	p := layoutProject(t, "v: \"{{ a\n | f }}\"\n")
	ds := Analyze(p, jinjaRules())
	if len(ds) == 0 {
		t.Fatal("missing finding")
	}
	ds = append(ds, ds[0])
	changes, err := PlanFixes(p, ds)
	if err != nil || len(changes) != 1 || string(changes[0].After) != "v: \"{{ a\n       | f }}\"\n" {
		t.Fatalf("duplicate edit: %+v %v", changes, err)
	}
}
func TestPlanFixesRejectsSplittingNumericToken(t *testing.T) {
	p := layoutProject(t, "v: '{{ 1e3 }}'\n")
	changes, err := PlanFixes(p, []Diagnostic{{Path: "values.yml", Fix: &Fix{Edits: []Edit{{Span: Span{8, 8}, Text: " "}}}}})
	if err != nil || len(changes) > 0 {
		t.Fatalf("numeric literal split: %+v %v", changes, err)
	}
}
func TestPlanFixesRejectsSplittingIdentifiersAndOperators(t *testing.T) {
	for _, tc := range []struct {
		input string
		pos   int
	}{
		{"v: '{{ café }}'\n", 10},
		{"v: '{{ a != b }}'\n", 10},
		{"v: '{{ a ** b }}'\n", 10},
	} {
		p := layoutProject(t, tc.input)
		changes, err := PlanFixes(p, []Diagnostic{{Path: "values.yml", Fix: &Fix{Edits: []Edit{{Span: Span{tc.pos, tc.pos}, Text: " "}}}}})
		if err != nil || len(changes) > 0 {
			t.Fatalf("lexical token split: %+v %v", changes, err)
		}
	}
}
func TestWriteChangesWithEmptyBatchNeedsNoFilesystem(t *testing.T) {
	if err := WriteChanges(&Project{}, nil); err != nil {
		t.Fatalf("empty write: %v", err)
	}
}
func TestWriteChangesPreservesSpecialModeBits(t *testing.T) {
	root := t.TempDir()
	input := "v: \"{{ a\n | f }}\"\n"
	p := layoutProject(t, input)
	p.Root = root
	path := filepath.Join(root, "values.yml")
	if err := os.WriteFile(path, []byte(input), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0640|os.ModeSticky); err != nil {
		t.Fatal(err)
	}
	changes, err := PlanFixes(p, Analyze(p, jinjaRules()))
	if err != nil || len(changes) != 1 {
		t.Fatalf("changes: %+v %v", changes, err)
	}
	if err := WriteChanges(p, changes); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode() != (0640|os.ModeSticky) {
		t.Fatalf("mode changed: %v %v", info, err)
	}
}
func TestPlanFixesDeclinesUntrustedEditsInUnsupportedExpressions(t *testing.T) {
	p := layoutProject(t, "v: '{{ a $ b }}'\n")
	changes, err := PlanFixes(p, []Diagnostic{{Path: "values.yml", Fix: &Fix{Edits: []Edit{{Span: Span{8, 9}, Text: "  "}}}}})
	if err != nil || len(changes) > 0 {
		t.Fatalf("unsupported expression correction: %+v %v", changes, err)
	}
}
