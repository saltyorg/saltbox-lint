package lint

import (
	"slices"
	"testing"
)

// Checkers are real functions operating on syntax; selecting one file must not
// suppress explanatory context or leak a context file's primary diagnostics.
func TestAnalyzeSelectedDiagnostics(t *testing.T) {
	selected, _ := Parse("selected.yml", []byte("value: wrong\n"))
	context, _ := Parse("context.yml", []byte("value: wrong\n"))
	p := &Project{Sources: map[string]*Source{selected.Path: selected, context.Path: context}, Selected: map[string]bool{selected.Path: true}}
	rule := Rule{ID: "value", Kinds: []Kind{Generic}, Check: func(p *Project, s *Source) []Diagnostic {
		value := s.Documents[0].Get("value")
		if value.Value != "wrong" {
			return nil
		}
		d := Diagnostic{Path: s.Path, RuleID: "value", Severity: "error", Message: "unexpected value", Span: value.Span, Related: []RelatedLocation{{Path: "context.yml", Message: "explains the value", Span: Span{0, 5}}}}
		return []Diagnostic{d, d}
	}}
	got := Analyze(p, []Rule{rule})
	if len(got) != 1 || got[0].Path != "selected.yml" || len(got[0].Related) != 1 || got[0].Related[0].Path != "context.yml" {
		t.Fatalf("diagnostics=%#v", got)
	}
}

func TestAnalyzeInvalidSources(t *testing.T) {
	bad, ds := Parse("bad.yml", []byte("value: [\n"))
	good, _ := Parse("good.yml", []byte("value: ok\n"))
	p := &Project{Sources: map[string]*Source{bad.Path: bad, good.Path: good}, Selected: map[string]bool{bad.Path: true, good.Path: true}, Diagnostics: ds}
	rule := Rule{ID: "structural", Check: func(_ *Project, s *Source) []Diagnostic {
		// If invalid syntax reaches a structural checker, indexing fails rather than
		// masking the wrong dispatch with a test-specific conditional.
		value := s.Documents[0].Get("value")
		if value.Value == "ok" {
			return []Diagnostic{{Path: s.Path, RuleID: "structural", Message: "checked", Span: value.Span}}
		}
		return nil
	}}
	got := Analyze(p, []Rule{rule})
	if len(got) != 2 || got[0].Path != "bad.yml" || got[1].RuleID != "structural" {
		t.Fatalf("diagnostics=%#v", got)
	}
	p.Selected = map[string]bool{"good.yml": true}
	got = Analyze(p, []Rule{rule})
	if len(got) != 1 || got[0].Path != "good.yml" {
		t.Fatalf("malformed unused context leaked: %#v", got)
	}
	// Parse's attached errors must survive callers constructing a Project without
	// separately copying Parse's returned diagnostics.
	p.Diagnostics = nil
	p.Selected = map[string]bool{"bad.yml": true}
	got = Analyze(p, nil)
	if len(got) != 1 || got[0].RuleID != "yaml-syntax" {
		t.Fatalf("parse error lost: %#v", got)
	}
}

func TestAnalyzeKindsAndOrdering(t *testing.T) {
	a, _ := Parse("a.yml", []byte("a: b\n"))
	b, _ := Parse("b.yml", []byte("a: b\n"))
	p := &Project{Sources: map[string]*Source{b.Path: b, a.Path: a}, Selected: map[string]bool{a.Path: true, b.Path: true}}
	rules := []Rule{
		{ID: "wrong-kind", Kinds: []Kind{Tasks}, Check: func(_ *Project, s *Source) []Diagnostic { return []Diagnostic{{Path: s.Path, RuleID: "wrong-kind"}} }},
		{ID: "order", Kinds: []Kind{Generic}, Check: func(_ *Project, s *Source) []Diagnostic {
			return []Diagnostic{
				{Path: s.Path, RuleID: "z", Message: "later", Span: Span{3, 4}},
				{Path: s.Path, RuleID: "b", Message: "second", Span: Span{0, 1}},
				{Path: s.Path, RuleID: "a", Message: "last message", Span: Span{0, 1}},
				{Path: s.Path, RuleID: "a", Message: "first message", Span: Span{0, 1}},
			}
		}},
	}
	want := []string{"a.yml:a:first message", "a.yml:a:last message", "a.yml:b:second", "a.yml:z:later", "b.yml:a:first message", "b.yml:a:last message", "b.yml:b:second", "b.yml:z:later"}
	for range 10 {
		var keys []string
		for _, d := range Analyze(p, rules) {
			keys = append(keys, d.Path+":"+d.RuleID+":"+d.Message)
		}
		if !slices.Equal(keys, want) {
			t.Fatalf("order=%v", keys)
		}
	}
}
