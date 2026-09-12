package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
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

func TestPlanFixesEquivalentProposalsKeepSourceOwnership(t *testing.T) {
	p := layoutProject(t, "v: \"{{ a\n | f }}\"\n")
	ds := Analyze(p, jinjaRules())
	original := ds[0]
	duplicate := original
	duplicate.Fix = &Fix{Message: "different presentation", Edits: append([]Edit(nil), original.Fix.Edits...)}
	second, _ := Parse("second.yml", p.Sources["values.yml"].Data)
	p.Sources[second.Path] = second
	p.Selected[second.Path] = true
	other := original
	other.Path = second.Path
	changes, err := PlanFixes(p, []Diagnostic{original, duplicate, original, other})
	if err != nil || len(changes) != 2 {
		t.Fatalf("changes=%+v err=%v", changes, err)
	}
	for i, path := range []string{"second.yml", "values.yml"} {
		if changes[i].Path != path || string(changes[i].After) != "v: \"{{ a\n       | f }}\"\n" {
			t.Fatalf("source ownership: %+v", changes)
		}
	}
	// Equivalent identity must not hide a later caller mutation or conflict.
	duplicate.Fix.Edits[0].Text = "\t"
	if _, err := PlanFixes(p, []Diagnostic{original, duplicate}); err == nil {
		t.Fatal("conflicting independent proposal accepted")
	}
	p.Selected[second.Path] = false
	changes, err = PlanFixes(p, []Diagnostic{original, other})
	if err != nil || len(changes) != 1 || changes[0].Path != "values.yml" {
		t.Fatalf("selection ignored: %+v %v", changes, err)
	}
	delete(p.Sources, "values.yml")
	if _, err := PlanFixes(p, []Diagnostic{original}); err == nil {
		t.Fatal("missing selected source ignored")
	}
}

func TestPlanFixesSharedProposalsRemainIdempotentAndDetached(t *testing.T) {
	input := "v: \"{{ a\n | f }}\"\n"
	p := layoutProject(t, input)
	ds := Analyze(p, jinjaRules())
	changes, err := PlanFixes(p, append(ds, ds...))
	if err != nil || len(changes) != 1 {
		t.Fatalf("changes=%+v err=%v", changes, err)
	}
	candidate, errors := Parse("values.yml", changes[0].After)
	if len(errors) != 0 {
		t.Fatal(errors)
	}
	p.Sources[candidate.Path] = candidate
	remaining := Analyze(p, jinjaRules())
	again, err := PlanFixes(p, remaining)
	if err != nil || len(remaining) != 0 || len(again) != 0 {
		t.Fatalf("not idempotent: %+v %+v %v", remaining, again, err)
	}
	candidate.Data[0] = 'x'
	if string(changes[0].Before) != input {
		t.Fatal("original Change bytes aliased caller data")
	}
	// Reusing the Project with a freshly parsed source must rebuild validation.
	updated, _ := Parse("values.yml", []byte("v: '{{ a $ b }}'\n"))
	p.Sources[updated.Path] = updated
	changes, err = PlanFixes(p, []Diagnostic{{Path: updated.Path, Fix: &Fix{Edits: []Edit{{Span: Span{8, 9}, Text: "  "}}}}})
	if err != nil || len(changes) != 0 {
		t.Fatalf("stale whitespace authority: %+v %v", changes, err)
	}
}

// A frozen pre-optimization authority oracle checks token boundaries and source
// mapping independently of the indexed containment implementation.
func legacyAllowedWhitespace(s *Source, e Edit) bool {
	for _, v := range []string{string(s.Data[e.Span.Start:e.Span.End]), e.Text} {
		for i := range len(v) {
			if !space(v[i]) {
				return false
			}
		}
	}
	for _, gap := range sectionGaps(s) {
		if e == gap.Edit {
			return true
		}
	}
	for _, expr := range Expressions(s) {
		if !expr.Complete || !expr.mapped || expr.Kind != "output" || !layoutSupported(expr) {
			continue
		}
		if e.Span.Start >= expr.opening.End && e.Span.End <= expr.closing.Start {
			intersects := false
			for _, t := range expr.Tokens {
				if e.Span.Start < t.Span.End && e.Span.End > t.Span.Start || e.Span.Start == e.Span.End && e.Span.Start > t.Span.Start && e.Span.Start < t.Span.End {
					intersects = true
					break
				}
			}
			if !intersects {
				return true
			}
		}
		if block, _ := pureBlock(s, expr); block && e.Span.End <= expr.Span.Start {
			start := bytes.LastIndexByte(s.Data[:expr.Span.Start], '\n') + 1
			if e.Span.Start >= start {
				return true
			}
		}
	}
	return false
}

func TestWhitespaceValidationPreservesAuthority(t *testing.T) {
	for _, input := range []string{
		"v: \"{{ a\n | f('a  b') }}\" # keep  spaces\n",
		"v: '{{ a != b }} {{ café }}'\n",
		"v: '{{ 1e3 }} {{ a $ b }}'\n",
		"v: !unsafe '{{ a }}'\n",
		"v: |-\n    {{ a\n     | f }}\n",
		"################################\n# Test\n################################\nv: true\n",
	} {
		source, errors := Parse("values.yml", []byte(input))
		if len(errors) != 0 {
			t.Fatal(errors)
		}
		validation := newWhitespaceValidation(source)
		for start := range len(input) + 1 {
			for end := start; end <= len(input); end++ {
				if strings.TrimSpace(input[start:end]) != "" {
					continue
				}
				for _, replacement := range []string{"", " ", "\n", "not whitespace"} {
					edit := Edit{Span: Span{start, end}, Text: replacement}
					want := legacyAllowedWhitespace(source, edit)
					if got := validation.allows(edit); got != want {
						t.Fatalf("input=%q edit=%+v allowed=%v want=%v", input, edit, got, want)
					}
				}
			}
		}
	}
}

func TestPlanFixesEmptyProposalsPreserveSourceValidation(t *testing.T) {
	for _, fix := range []*Fix{nil, {}, {Edits: []Edit{}}} {
		p := layoutProject(t, "v: true\n")
		diagnostics := []Diagnostic{{Path: "values.yml", Fix: fix}}
		changes, err := PlanFixes(p, diagnostics)
		if err != nil || len(changes) != 0 {
			t.Fatalf("empty proposal changed available source: %+v %v", changes, err)
		}
		delete(p.Sources, "values.yml")
		_, err = PlanFixes(p, diagnostics)
		if (err != nil) != (fix != nil) {
			t.Fatalf("missing source with fix=%+v: %v", fix, err)
		}
		p.Selected["values.yml"] = false
		if _, err := PlanFixes(p, diagnostics); err != nil {
			t.Fatalf("unselected empty proposal: %v", err)
		}
	}
}
