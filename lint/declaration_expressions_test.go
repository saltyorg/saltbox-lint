package lint

import (
	"strings"
	"testing"
)

func TestDeclarationExpressionsDoNotMapUnrelatedValues(t *testing.T) {
	s := jinjaSource(t, "wanted: '{{ target }}'\nother: '"+strings.Repeat("{{ unrelated }} ", 512)+"'\n")
	declaration := defaultDeclaration{Value: s.Documents[0].Get("wanted")}
	allocations := testing.AllocsPerRun(10, func() {
		got := expressionsForDeclaration(s, declaration)
		if len(got) != 1 || len(got[0].Tokens) != 1 || got[0].Tokens[0].Text != "target" {
			t.Fatalf("declaration expressions = %+v", got)
		}
	})
	if allocations > 20 {
		t.Fatalf("one declaration allocated %.0f times while scanning unrelated expressions", allocations)
	}
}

func TestDeclarationExpressionsPreserveTraversalAndUnsafeAncestors(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		want        []string
	}{
		{"nested values and keys", "wanted:\n  '{{ key }}': ['{{ first }}', '{{ second }}']\nother: '{{ ignored }}'\n", []string{"key", "first", "second"}},
		{"unsafe declaration", "wanted: !unsafe '{{ ignored }}'\n", nil},
		{"unsafe ancestor", "!unsafe {wanted: '{{ ignored }}'}\n", nil},
		{"unsafe nested value", "wanted:\n  safe: '{{ kept }}'\n  unsafe: !unsafe '{{ ignored }}'\n", []string{"kept"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := jinjaSource(t, tc.input)
			got := expressionsForDeclaration(s, defaultDeclaration{Value: s.Documents[0].Get("wanted")})
			if len(got) != len(tc.want) {
				t.Fatalf("expressions = %+v, want %v", got, tc.want)
			}
			for i, name := range tc.want {
				if len(got[i].Tokens) != 1 || got[i].Tokens[0].Text != name || string(s.Data[got[i].Tokens[0].Span.Start:got[i].Tokens[0].Span.End]) != name {
					t.Fatalf("expression %d = %+v, want token and source %q", i, got[i], name)
				}
			}
		})
	}
	first := jinjaSource(t, "wanted: '{{ first }}'\n")
	foreign := jinjaSource(t, "wanted: '{{ foreign }}'\n")
	if got := expressionsForDeclaration(first, defaultDeclaration{Value: foreign.Documents[0].Get("wanted")}); got != nil {
		t.Fatalf("foreign declaration returned %+v", got)
	}
	if got := expressionsForDeclaration(first, defaultDeclaration{}); got != nil {
		t.Fatalf("nil declaration returned %+v", got)
	}
}

func TestDeclarationExpressionsPreserveSharedNodeMembership(t *testing.T) {
	s := jinjaSource(t, "wanted: {inner: '{{ target }}'}\nother: literal\n")
	declaration := defaultDeclaration{Value: s.Documents[0].Get("wanted")}
	// Public nodes can be assembled by callers. A shared child is selected at
	// each source occurrence, even where its declaring parent is not an ancestor.
	s.Documents[0].Entries[1].Value = declaration.Value.Get("inner")
	if got := expressionsForDeclaration(s, declaration); len(got) != 2 {
		t.Fatalf("shared node expressions = %+v, want both source occurrences", got)
	}
	foreign := &Node{Kind: "sequence", Items: []*Node{declaration.Value.Get("inner")}}
	if got := expressionsForDeclaration(s, defaultDeclaration{Value: foreign}); len(got) != 2 {
		t.Fatalf("foreign parent of source nodes returned %+v, want both source occurrences", got)
	}
}
