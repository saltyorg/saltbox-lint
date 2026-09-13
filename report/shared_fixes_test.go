package report

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func malformedExpressions(tb testing.TB, count int) (*lint.Project, []lint.Diagnostic, string) {
	tb.Helper()
	var input, expected strings.Builder
	for i := range count {
		fmt.Fprintf(&input, "v%d: \"{{ a\n | f }}\"\n", i)
		fmt.Fprintf(&expected, "v%d: \"{{ a\n%s| f }}\"\n", i, strings.Repeat(" ", 7+len(fmt.Sprint(i))))
	}
	source, errors := lint.Parse("values.yml", []byte(input.String()))
	if len(errors) != 0 {
		tb.Fatalf("parse: %+v", errors)
	}
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
	var rules []lint.Rule
	for _, rule := range lint.Rules() {
		if rule.ID == "jinja-layout" {
			rules = append(rules, rule)
		}
	}
	ds := lint.Analyze(p, rules)
	if len(ds) != count {
		tb.Fatalf("findings=%d want=%d", len(ds), count)
	}
	for _, d := range ds {
		if d.Fix == nil || d.Fix != ds[0].Fix || len(d.Fix.Edits) != count {
			tb.Fatalf("fix ownership: %+v", d)
		}
	}
	return p, ds, expected.String()
}

type jsonV2Result struct {
	SchemaVersion int `json:"schema_version"`
	Diagnostics   []struct {
		Diagnostic
		FixID string `json:"fix_id"`
	} `json:"diagnostics"`
	Fixes []struct {
		ID   string `json:"id"`
		Path string `json:"path"`
		Fix
	} `json:"fixes"`
}

func renderJSONV2(t *testing.T, p *lint.Project, ds []lint.Diagnostic) jsonV2Result {
	t.Helper()
	var out bytes.Buffer
	if err := Render(&out, p, ds, Options{Format: "json"}); err != nil {
		t.Fatal(err)
	}
	var result jsonV2Result
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.SchemaVersion != 2 || result.Diagnostics == nil || result.Fixes == nil {
		t.Fatalf("JSON v2 envelope missing: version=%d diagnostics=%d fixes=%d", result.SchemaVersion, len(result.Diagnostics), len(result.Fixes))
	}
	for _, d := range result.Diagnostics {
		if d.Fix != nil {
			t.Fatal("legacy inline fix emitted")
		}
	}
	return result
}

func TestSharedFixScaling(t *testing.T) {
	for _, count := range []int{10, 20, 40} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			p, ds, expected := malformedExpressions(t, count)
			changes, err := lint.PlanFixes(p, ds)
			if err != nil || len(changes) != 1 || !bytes.Equal(changes[0].Before, p.Sources["values.yml"].Data) || string(changes[0].After) != expected {
				t.Fatalf("PlanFixes parity: changes=%+v err=%v expected=%q", changes, err, expected)
			}
			result := renderJSONV2(t, p, ds)
			if len(result.Diagnostics) != count || len(result.Fixes) != 1 || len(result.Fixes[0].Edits) != count {
				t.Fatalf("shared records: diagnostics=%d fixes=%d", len(result.Diagnostics), len(result.Fixes))
			}
			for _, d := range result.Diagnostics {
				if d.FixID != "fix-1" {
					t.Fatalf("dangling reference %q", d.FixID)
				}
			}
			if result.Fixes[0].ID != "fix-1" || result.Fixes[0].Path != "values.yml" {
				t.Fatalf("fix identity %+v", result.Fixes[0])
			}
		})
	}
}

func TestJSONV2FixReferences(t *testing.T) {
	p, ds := sample()
	original := ds[0]
	clone := original
	clone.Fix = &lint.Fix{Message: original.Fix.Message, Edits: slices.Clone(original.Fix.Edits)}
	differentMessage := clone
	differentMessage.Fix = &lint.Fix{Message: "different", Edits: slices.Clone(original.Fix.Edits)}
	differentEdit := clone
	differentEdit.Fix = &lint.Fix{Message: original.Fix.Message, Edits: []lint.Edit{{Span: lint.Span{Start: 8, End: 9}, Text: "z"}}}
	secondFile := original
	secondFile.Path = "b.yml"
	source, _ := lint.Parse("b.yml", p.Sources["a.yml"].Data)
	p.Sources["b.yml"] = source
	manual := original
	manual.Fix = nil
	manual.Preview = &lint.Preview{Edits: slices.Clone(original.Fix.Edits)}
	result := renderJSONV2(t, p, []lint.Diagnostic{differentMessage, original, clone, original, secondFile, differentEdit, manual})
	want := []string{"fix-1", "fix-2", "fix-2", "fix-2", "fix-3", "fix-4", ""}
	if len(result.Fixes) != 4 || len(result.Diagnostics) != len(want) {
		t.Fatalf("counts: %+v", result)
	}
	for i, d := range result.Diagnostics {
		if d.FixID != want[i] {
			t.Errorf("diagnostic %d reference=%q want=%q", i, d.FixID, want[i])
		}
	}
	for i, fix := range result.Fixes {
		if fix.ID != fmt.Sprintf("fix-%d", i+1) {
			t.Errorf("order=%+v", fix)
		}
	}
	edit := result.Fixes[1].Edits[0]
	if edit.Span != (Span{8, 9}) || edit.Range != (Range{Position{1, 6}, Position{1, 7}}) || edit.Text != "y" {
		t.Fatalf("original positions lost: %+v", edit)
	}
	if result.Fixes[2].Path != "b.yml" || result.Fixes[3].Edits[0].Text != "z" {
		t.Fatalf("content/path conflation: %+v", result.Fixes)
	}
	clean := renderJSONV2(t, p, nil)
	if len(clean.Diagnostics) != 0 || len(clean.Fixes) != 0 {
		t.Fatal("clean output contains records")
	}
	// Each invocation sees caller mutations; memoized records cannot outlive Render.
	original.Fix.Edits[0].Text = "mutated"
	next := renderJSONV2(t, p, []lint.Diagnostic{original})
	if next.Fixes[0].Edits[0].Text != "mutated" {
		t.Fatal("stale transformed fix")
	}
}

func TestJSONV2OrderedEditsAndInsertionRanges(t *testing.T) {
	p, ds := sample()
	first := ds[0]
	first.Fix = &lint.Fix{Message: "ordered", Edits: []lint.Edit{
		{Span: lint.Span{Start: 8, End: 8}, Text: " "},
		{Span: lint.Span{Start: 8, End: 15}, Text: "\n"},
	}}
	second := first
	second.Fix = &lint.Fix{Message: first.Fix.Message, Edits: slices.Clone(first.Fix.Edits)}
	slices.Reverse(second.Fix.Edits)
	result := renderJSONV2(t, p, []lint.Diagnostic{first, second})
	if len(result.Fixes) != 2 || result.Diagnostics[0].FixID == result.Diagnostics[1].FixID {
		t.Fatal("ordered edits conflated")
	}
	edits := result.Fixes[0].Edits
	if edits[0].Span != (Span{8, 8}) || edits[0].Range != (Range{Position{1, 6}, Position{1, 6}}) || edits[1].Span != (Span{8, 15}) || edits[1].Range != (Range{Position{1, 6}, Position{2, 5}}) {
		t.Fatalf("original insertion/multiline ranges changed: %+v", edits)
	}
}

// Captured at 9ce89d8 before shared-record expansion changed.
var baselineOutputHashes = map[int]map[string]string{
	10: {"human": "2ebddf49fef1b42615db80aec9f2251802800b961f341bd59db1cf3f8281fae5", "concise": "fa8452781115fe56aa6d8cbcdbec2d3e50546bfc5e8f6f7166b0c0f768b66331", "github": "f3efe44976ea186f31dcdf837ece0ab4fcd8a38b0d182d8d01325fa053ce7fd7"},
	20: {"human": "73db0bdefe12fc4b65be5a8f9b3fa5f09b59422c96b46979ad9949e1c8ba5622", "concise": "dd69ca1753d3f5657006ac857419f4b8af8a6af76a24c6de6134974f6f70d63f", "github": "1f46e7a426a21da23ea42cab0f9a80963412fc829dbc0eb6952f1ef95f8c20f1"},
	40: {"human": "870bbf09a1e9b965e5dd6f28c20791a8969d03660cf282412d850487eb13e23d", "concise": "881a085e14ad394a96d1aedde3a3bc4759d4ae60e16bddafef6e6bfa73f64e81", "github": "23a30d0aa1acd72ea9289f7e0f348688983a8fb53d07ed20c7f9a91bad4ac47c"},
}

// Fixed deterministic input/output measurements also pin non-JSON parity across
// the shared record implementation. Run with -v to retain output hashes.
func TestSharedFixOutputEvidence(t *testing.T) {
	for _, count := range []int{10, 20, 40} {
		p, ds, _ := malformedExpressions(t, count)
		for _, format := range []string{"json", "human", "concise", "github"} {
			var out bytes.Buffer
			if err := Render(&out, p, ds, Options{Format: format}); err != nil {
				t.Fatal(err)
			}
			digest := fmt.Sprintf("%x", sha256.Sum256(out.Bytes()))
			if want := baselineOutputHashes[count][format]; want != "" && digest != want {
				t.Fatalf("%d %s changed: sha256=%s want=%s", count, format, digest, want)
			}
			var again bytes.Buffer
			if err := Render(&again, p, ds, Options{Format: format}); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(out.Bytes(), again.Bytes()) {
				t.Fatalf("%s output is nondeterministic", format)
			}
			t.Logf("count=%d format=%s bytes=%d sha256=%s edit_records=%d", count, format, out.Len(), digest, bytes.Count(out.Bytes(), []byte(`"text":`)))
		}
	}
}

func BenchmarkSharedFixProcessing(b *testing.B) {
	for _, count := range []int{10, 20, 40} {
		p, ds, _ := malformedExpressions(b, count)
		b.Run(fmt.Sprintf("plan/%d", count), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if _, err := lint.PlanFixes(p, ds); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run(fmt.Sprintf("records/%d", count), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				diagnostics(p, ds)
			}
		})
		for _, format := range []string{"json", "concise", "github"} {
			b.Run(fmt.Sprintf("%s/%d", format, count), func(b *testing.B) {
				b.ReportAllocs()
				for b.Loop() {
					if err := Render(io.Discard, p, ds, Options{Format: format}); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}

func TestSharedFixComparisonDoesNotReexpand(t *testing.T) {
	p, ds, _ := malformedExpressions(t, 40)
	records := diagnostics(p, ds)
	var out bytes.Buffer
	r, err := newHumanRenderer(io.Discard, p, HumanOptions{Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	if !r.renderComparison(&out, records[0]) {
		t.Fatal("initial comparison missing")
	}
	// Duplicate display writes a short reference; it must not reconstruct and
	// normalize forty source edits for each additional finding.
	allocations := testing.AllocsPerRun(10, func() { out.Reset(); r.renderComparison(&out, records[1]) })
	t.Logf("duplicate comparison allocations: %.0f", allocations)
	if allocations > 16 {
		t.Fatalf("duplicate comparison allocated %.0f objects; shared source edits were expanded again", allocations)
	}
}

func BenchmarkSharedFixHumanSuggestions(b *testing.B) {
	for _, count := range []int{10, 20, 40} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			p, ds, _ := malformedExpressions(b, count)
			records := diagnostics(p, ds)
			var out bytes.Buffer
			r, err := newHumanRenderer(io.Discard, p, HumanOptions{Context: b.Context()})
			if err != nil {
				b.Fatal(err)
			}
			defer r.close()
			if !r.renderComparison(&out, records[0]) {
				b.Fatal("missing comparison")
			}
			b.ReportAllocs()
			for b.Loop() {
				for _, d := range records {
					out.Reset()
					r.renderComparison(&out, d)
				}
			}
		})
	}
}

func BenchmarkSharedFixPrefix(b *testing.B) {
	for _, count := range []int{10, 20, 40} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			p, ds, _ := malformedExpressions(b, count)
			group := diagnosticGroup{diagnostics: diagnostics(p, ds)}
			b.ReportAllocs()
			for b.Loop() {
				originalPrefixLine(p, group)
			}
		})
	}
}

func TestSharedFixNoncontiguousGroupsRetainReference(t *testing.T) {
	p, records := displayLifetimeFixture(t, 2)
	for i := range records {
		records[i] = fixLifetimeRecord(records[i])
	}
	first := records[0]
	records = append(records, first)
	var out bytes.Buffer
	r, err := newHumanRenderer(&out, p, HumanOptions{Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	if err := r.renderSequentialFindings(records); err != nil {
		t.Fatal(err)
	}
	if strings.Count(out.String(), "--- current/"+first.Path) != 1 || !strings.Contains(out.String(), "Suggestion shown above") {
		t.Fatalf("noncontiguous fix reference lost:\n%s", &out)
	}
	assertDisplayDataReleased(t, r)
}

func TestStructuralFixJSONReferencesMatchPlanner(t *testing.T) {
	input := "- debug: {msg: '{{ (a if flag else b) }}'}\n  when: value is defined\n"
	s, ds := lint.Parse("tasks/main.yml", []byte(input))
	if len(ds) > 0 {
		t.Fatal(ds)
	}
	p := &lint.Project{Sources: map[string]*lint.Source{s.Path: s}, Selected: map[string]bool{s.Path: true}}
	ds = lint.Analyze(p, lint.Rules())
	changes, err := lint.PlanFixes(p, ds)
	if err != nil || len(changes) != 1 {
		t.Fatalf("plan: %+v %v", changes, err)
	}
	result := renderJSONV2(t, p, ds)
	if len(result.Fixes) != 1 {
		t.Fatalf("shared fixes=%d", len(result.Fixes))
	}
	refs := 0
	for _, d := range result.Diagnostics {
		if d.FixID != "" {
			refs++
			if d.FixID != result.Fixes[0].ID {
				t.Fatal("dangling fix reference")
			}
		}
	}
	if refs != 2 {
		t.Fatalf("references=%d", refs)
	}
	actual := []byte(input)
	for i := len(result.Fixes[0].Edits) - 1; i >= 0; i-- {
		e := result.Fixes[0].Edits[i]
		actual = append(append(append([]byte{}, actual[:e.Span.Start]...), []byte(e.Text)...), actual[e.Span.End:]...)
	}
	if !bytes.Equal(actual, changes[0].After) {
		t.Fatalf("JSON planner disagreement: %q %q", actual, changes[0].After)
	}
}
