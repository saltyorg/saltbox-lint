package format

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestStandaloneEmptyCollectionsKeepValueIndentation(t *testing.T) {
	for _, tt := range []struct{ name, input, want string }{
		{"nested sequence", "root:\n    empty:\n        []\n", "root:\n  empty:\n    []\n"},
		{"root mapping value", "empty:\n    { }\n", "empty:\n  {}\n"},
		{"root sequence value", "empty:\n    [ ]\n", "empty:\n  []\n"},
		{"nested mapping", "root:\n    empty:\n        {}\n", "root:\n  empty:\n    {}\n"},
		{"comments and gap", "root:\n    empty: # value\n\n        # attached\n        [] # collection\n", "root:\n  empty: # value\n\n        # attached\n    [] # collection\n"},
		{"sequence item", "-\n    []\n", "-\n  []\n"},
		{"root collection", "  [ ]\n", "[]\n"},
	} {
		for _, newline := range []string{"\n", "\r\n"} {
			t.Run(tt.name+newline, func(t *testing.T) {
				input := strings.ReplaceAll(tt.input, "\n", newline)
				want := strings.ReplaceAll(tt.want, "\n", newline)
				result, err := Plan(t.Context(), "vars.yml", []byte(input))
				if err != nil || result.Status == "skipped" {
					t.Fatalf("plan: %+v %v", result, err)
				}
				got := apply([]byte(input), result.Edits)
				if string(got) != want {
					t.Fatalf("got %q; want %q", got, want)
				}
				second, err := Plan(t.Context(), "vars.yml", got)
				if err != nil || second.Status != "unchanged" {
					t.Fatalf("idempotence: %+v %v", second, err)
				}
			})
		}
	}
}

func TestFlowExpansionPreservesSourceBlankGaps(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n"} {
		input, err := os.ReadFile("../lint/testdata/canonical/flow-gaps.input.yaml")
		if err != nil {
			t.Fatal(err)
		}
		want, err := os.ReadFile("../lint/testdata/canonical/flow-gaps.golden.yaml")
		if err != nil {
			t.Fatal(err)
		}
		input = bytes.ReplaceAll(input, []byte("\n"), []byte(newline))
		want = bytes.ReplaceAll(want, []byte("\n"), []byte(newline))
		result, err := Plan(t.Context(), "vars.yml", input)
		if err != nil || result.Status != "ready" {
			t.Fatalf("plan: %+v %v", result, err)
		}
		if got := apply(input, result.Edits); !bytes.Equal(got, want) {
			t.Fatalf("got:\n%s\nwant:\n%s", got, want)
		}
		second, err := Plan(t.Context(), "vars.yml", want)
		if err != nil || second.Status != "unchanged" {
			t.Fatalf("idempotence: %+v %v", second, err)
		}
	}
}

func TestFlowExpansionPreservesBoundaryBlankGaps(t *testing.T) {
	for _, tt := range []struct{ name, input, want string }{
		{"leading value", "v: [\n\n one]\n", "v:\n\n  - one\n"},
		{"leading root", "[\n\n one]\n", "\n- one\n"},
		{"trailing value", "v: [one,\n\n]\n", "v:\n  - one\n\n"},
		{"trailing before token", "v: [one,\n\n]\nw: two", "v:\n  - one\n\nw: two"},
		{"nested boundary gaps", "v: [[\n\n one,\n\n], two]\n", "v:\n  -\n\n    - one\n\n  - two\n"},
		{"nested trailing final", "v: [[one,\n\n],\n\n]\n", "v:\n  - - one\n\n\n"},
		{"blank mapping value", "v: {a:\n\n one, b: two}\n", "v:\n  a:\n\n    one\n  b: two\n"},
		{"anchored leading", "v: &v [\n\n one]\n", "v: &v\n\n  - one\n"},
		{"anchor prefix gap", "v: &v\n\n  [one]\n", "v: &v\n\n  - one\n"},
		{"empty anchor prefix gap", "v: &v\n\n  []\n", "v: &v\n\n  []\n"},
		{"document marker leading gap", "--- [\n\n one]\n", "--- \n\n- one\n"},
		{"nested trailing before final item", "[[one,\n\n], two]", "- - one\n\n- two"},
		{"empty interior", "v: [\n\n]\n", "v: [\n\n  ]\n"},
	} {
		for _, newline := range []string{"\n", "\r\n"} {
			t.Run(tt.name+newline, func(t *testing.T) {
				input := strings.ReplaceAll(tt.input, "\n", newline)
				want := strings.ReplaceAll(tt.want, "\n", newline)
				result, err := Plan(t.Context(), "vars.yml", []byte(input))
				if err != nil || result.Status == "skipped" {
					t.Fatalf("plan: %+v %v", result, err)
				}
				got := apply([]byte(input), result.Edits)
				if string(got) != want {
					t.Fatalf("got %q; want %q", got, want)
				}
				second, err := Plan(t.Context(), "vars.yml", got)
				if err != nil || second.Status != "unchanged" {
					t.Fatalf("idempotence: %+v %v", second, err)
				}
			})
		}
	}
	for _, input := range []string{"[one,\n\n]", "v: [[one,\n\n]]"} {
		result, err := Plan(t.Context(), "vars.yml", []byte(input))
		if err != nil || result.Status != "skipped" || len(result.Edits) > 0 || !strings.Contains(result.Reason, "trailing blank gap at EOF") {
			t.Fatalf("EOF conflict: %+v %v", result, err)
		}
	}
}
