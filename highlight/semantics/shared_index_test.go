package semantics_test

import (
	"github.com/saltyorg/saltbox-lint/highlight/semantics"
	"github.com/saltyorg/saltbox-lint/yamlindex"
	"testing"
)

func TestClassifyRejectsMismatchedSharedSourceIdentity(t *testing.T) {
	wrong, err := yamlindex.Scan("other: x\n")
	if err != nil {
		t.Fatal(err)
	}
	source := "actual: x\n"
	got, err := semantics.Classify(source, semantics.Options{SourceIndex: wrong})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Start != 0 || got[0].End != 6 || got[0].Type != semantics.Property {
		t.Fatalf("tokens=%+v", got)
	}
}

// These are concrete parser divergences found by the common-tree prototype.
// Reusing lint validation must not change the semantic parser's own contract.
func TestSharedIndexPreservesIndependentSemanticParserContracts(t *testing.T) {
	cases := []struct {
		name, source, err string
		spans             [][2]int
	}{
		{name: "duplicates", source: "a: 1\na: 2\n", spans: [][2]int{{0, 1}, {5, 6}}},
		{name: "missing alias", source: "a: *missing\n", err: "parse YAML for semantic classification: yaml: unknown anchor 'missing' referenced"},
		{name: "malformed later document", source: "---\na: 1\n---\nb: [\n", spans: [][2]int{{4, 5}}},
		{name: "incompatible directive", source: "%YAML 1.2\n---\na: x\n", err: "parse YAML for semantic classification: yaml: found incompatible YAML document"},
		{name: "unsafe value", source: "a: !unsafe '{{ x }}'\n", spans: [][2]int{{0, 1}}},
		{name: "quoted unicode key", source: "\"\\u0061\": 'hé😀'\r\n", spans: [][2]int{{0, 8}}},
		{name: "alias remains reference", source: "a: &x {b: true}\nc: *x\n", spans: [][2]int{{0, 1}, {7, 8}, {16, 17}}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			index, err := yamlindex.Scan(test.source)
			if err != nil {
				t.Fatal(err)
			}
			got, err := semantics.Classify(test.source, semantics.Options{SourceIndex: index})
			if test.err != "" {
				if err == nil || err.Error() != test.err || len(got) != 0 {
					t.Fatalf("got=%+v err=%v", got, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(test.spans) {
				t.Fatalf("tokens=%+v", got)
			}
			for i, span := range test.spans {
				if got[i].Start != span[0] || got[i].End != span[1] || got[i].Type != semantics.Property {
					t.Fatalf("token=%+v, want span=%v", got[i], span)
				}
			}
		})
	}
}
