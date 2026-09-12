package format

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func apply(data []byte, edits []lint.Edit) []byte {
	out := bytes.Clone(data)
	for i := len(edits) - 1; i >= 0; i-- {
		e := edits[i]
		out = append(append(append([]byte{}, out[:e.Span.Start]...), e.Text...), out[e.Span.End:]...)
	}
	return out
}

func TestCanonicalSourceEdits(t *testing.T) {
	tests := []struct{ name, input, want string }{
		{"nested blocks", "root:\n    values:\n        -   name:   'hello'\n            active: true\n", "root:\n  values:\n    - name: \"hello\"\n      active: true\n"},
		{"flow collections", "root: {names: ['hello', world], empty: {}, list: []}\n", "root:\n  names:\n    - \"hello\"\n    - world\n  empty: {}\n  list: []\n"},
		{"mixed quotes", "message: 'He said \"hello\"'\n", "message: 'He said \"hello\"'\n"},
		{"typed and escaped", "values: [true, null, 12, 1.2, 'true', 'null', \"a\\nb\"]\n", "values:\n  - true\n  - null\n  - 12\n  - 1.2\n  - \"true\"\n  - \"null\"\n  - \"a\\nb\"\n"},
		{"unicode crlf eof", "雪:   ['🌨']\r\nlast: yes", "雪:\r\n  - \"🌨\"\r\nlast: yes"},
		{"comments", "# head\nroot:\n    # child\n    value:   'hi' # attached\n\n# foot\n", "# head\nroot:\n    # child\n  value: \"hi\" # attached\n\n# foot\n"},
		{"blocks", "root:\n    literal: |-\n      hi\n      there\n    folded: >+\n      a\n\n      b\n", "root:\n  literal: |-\n    hi\n    there\n  folded: >+\n    a\n\n    b\n"},
		{"jinja", "value: '{{foo|default(''x'')}}'\n", "value: '{{foo|default(''x'')}}'\n"},
		{"documents", "---\na: 'x'\n...\n---\nb: [one]\n", "---\na: \"x\"\n...\n---\nb:\n  - one\n"},
		{"anchors tags merges", "base: &base {name: 'x'}\ncopy:\n    <<: *base\n    unsafe: !unsafe '{{x}}'\n", "base: &base\n  name: \"x\"\ncopy:\n  <<: *base\n  unsafe: !unsafe '{{x}}'\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			original := []byte(tt.input)
			plan, err := Plan(t.Context(), "vars.yml", original)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Status == "skipped" {
				t.Fatalf("skipped: %s", plan.Reason)
			}
			got := apply(original, plan.Edits)
			if string(got) != tt.want {
				t.Fatalf("got:\n%s\nwant:\n%s", got, tt.want)
			}
			if string(original) != tt.input {
				t.Fatal("mutated source")
			}
			second, err := Plan(t.Context(), "vars.yml", got)
			if err != nil {
				t.Fatal(err)
			}
			if second.Status != "unchanged" || len(second.Edits) != 0 {
				t.Fatalf("not idempotent: %+v", second)
			}
		})
	}
}

func TestCanonicalDeclinesUncertainSources(t *testing.T) {
	for _, input := range []string{"x: [broken\n", "a: 1\na: 2\n", "? [a, b]\n: value\n", "x: [one, # inside\n two]\n", "x: 1\r\ny: 2\n", string([]byte{0xff})} {
		plan, err := Plan(t.Context(), "vars.yml", []byte(input))
		if err != nil {
			t.Fatal(err)
		}
		if plan.Status != "skipped" || plan.Reason == "" || len(plan.Edits) != 0 {
			t.Errorf("input %q: %+v", input, plan)
		}
	}
}

func TestCanonicalProtectedSyntax(t *testing.T) {
	tests := []struct{ name, input, want string }{
		{"empty quoted and containers", "root: {empty: '', map: { }, list: [ ]}\n", "root:\n  empty: \"\"\n  map: {}\n  list: []\n"},
		{"flow root", "[{name: 'snow', items: [[a,b], []]}]\n", "- name: \"snow\"\n  items:\n    - - a\n      - b\n    - []\n"},
		{"indentless sequence", "root:\n- name: 'x'\n  value: [a]\n", "root:\n  - name: \"x\"\n    value:\n      - a\n"},
		{"null entries", "values:\n  -\n  - null\na:\nb: 'x'\n", "values:\n  -\n  - null\na:\nb: \"x\"\n"},
		{"protected escape choices", "values: ['it''s fine', 'a\\nb', \"a\\u0020b\", 'He said \"hello\"']\n", "values:\n  - 'it''s fine'\n  - 'a\\nb'\n  - \"a\\u0020b\"\n  - 'He said \"hello\"'\n"},
		{"tags on scalars", "v:   !!str 'true'\nn: !!int '12'\n", "v: !!str \"true\"\nn: !!int \"12\"\n"},
		{"anchored flow scalars", "v: [&a 'hello', *a, !!str 'yes']\n", "v:\n  - &a \"hello\"\n  - *a\n  - !!str \"yes\"\n"},
		{"empty anchored containers", "v: &v { }\nr: *v\n", "v: &v {}\nr: *v\n"},
		{"tagged flow", "v: !!map {name: 'x'}\n", "v: !!map\n  name: \"x\"\n"},
		{"block anchors", "v: &v\n    name: 'x'\nr: *v\n", "v: &v\n  name: \"x\"\nr: *v\n"},
		{"explicit block indent", "root:\n    value: |2- # keep\n      a\n        b\n", "root:\n  value: |2- # keep\n    a\n      b\n"},
		{"multiline quotes", "root:\n    text: 'first\n      second'\n    other: 'x'\n", "root:\n  text: 'first\n      second'\n  other: \"x\"\n"},
		{"multiline plain", "root:\n    text: first\n      second\n    other: 'x'\n", "root:\n  text: first\n      second\n  other: \"x\"\n"},
		{"jinja layout", "v: \"{{ a\n | combine(b) }}\"\n", "v: \"{{ a\n       | combine(b) }}\"\n"},
		{"jinja control markers", "v: '{{- x -}} {% if y %}yes{% endif %}'\n", "v: '{{- x -}} {% if y %}yes{% endif %}'\n"},
		{"raw jinja", "v: '{% raw %}{{ x }}{% endraw %}'\n", "v: '{% raw %}{{ x }}{% endraw %}'\n"},
		{"directive", "%YAML 1.1\n---\nv: 'x'\n...\n", "%YAML 1.1\n---\nv: \"x\"\n...\n"},
		{"blank lines", "v: 'x'\n\n\n\na: 'y'\n\n", "v: \"x\"\n\n\n\na: \"y\"\n\n"},
		{"section gap", "################################\n# Settings\n################################\n# variable docs\nv: 'x'\n", "################################\n# Settings\n################################\n\n# variable docs\nv: \"x\"\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := Plan(t.Context(), "vars.yml", []byte(tt.input))
			if err != nil || result.Status == "skipped" {
				t.Fatalf("plan: %+v, %v", result, err)
			}
			got := apply([]byte(tt.input), result.Edits)
			if string(got) != tt.want {
				t.Fatalf("got %q\nwant %q", got, tt.want)
			}
			second, err := Plan(t.Context(), "vars.yml", got)
			if err != nil || second.Status != "unchanged" {
				t.Fatalf("idempotence: %+v, %v", second, err)
			}
		})
	}
}

func TestCanonicalRejectsUnverifiableJinjaAndCommentMovement(t *testing.T) {
	for _, input := range []string{
		"v: '{{ incomplete'\nother: 'x'\n",
		"v: [one, two] # belongs to collection\nother: 'x'\n",
		"v: [one,\n 'first\n second']\n",
	} {
		result, err := Plan(t.Context(), "vars.yml", []byte(input))
		if err != nil || result.Status != "skipped" || result.Reason == "" || len(result.Edits) > 0 {
			t.Errorf("input %q: %+v, %v", input, result, err)
		}
	}
}

func TestCanonicalCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	result, err := Plan(ctx, "vars.yml", []byte("v: 'x'\n"))
	if !errors.Is(err, context.Canceled) || len(result.Edits) > 0 {
		t.Fatalf("cancellation: %+v, %v", result, err)
	}
}

func TestCanonicalDeclinesNewSourceLocalViolation(t *testing.T) {
	// Indenting this formerly indentless sequence adds two physical columns and
	// crosses the existing conditional-length limit despite equal YAML values.
	input := "v:\n- \"{{ '" + strings.Repeat("x", 136) + "' if x else y }}\"\n"
	result, err := Plan(t.Context(), "vars.yml", []byte(input))
	if err != nil || result.Status != "skipped" || !strings.Contains(result.Reason, "jinja-conditional-length") || len(result.Edits) > 0 {
		t.Fatalf("new violation: %+v, %v", result, err)
	}
}

func TestCanonicalCommittedFixtures(t *testing.T) {
	for _, tt := range []struct{ name, path string }{{"ordinary", "vars.yml"}, {"tasks", "roles/example/tasks/main.yml"}} {
		t.Run(tt.name, func(t *testing.T) {
			input, err := os.ReadFile("../lint/testdata/canonical/" + tt.name + ".input.yaml")
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile("../lint/testdata/canonical/" + tt.name + ".golden.yaml")
			if err != nil {
				t.Fatal(err)
			}
			result, err := Plan(t.Context(), tt.path, input)
			if err != nil || result.Status != "ready" {
				t.Fatalf("plan: %+v %v", result, err)
			}
			if got := apply(input, result.Edits); !bytes.Equal(got, want) {
				t.Fatalf("got:\n%s\nwant:\n%s", got, want)
			}
			result, err = Plan(t.Context(), tt.path, want)
			if err != nil || result.Status != "unchanged" || len(result.Edits) > 0 {
				t.Fatalf("canonical fixture changed: %+v %v", result, err)
			}
		})
	}
	input, err := os.ReadFile("../lint/testdata/canonical/unsupported.yaml")
	if err != nil {
		t.Fatal(err)
	}
	result, err := Plan(t.Context(), "vars.yml", input)
	if err != nil || result.Status != "skipped" || len(result.Edits) > 0 {
		t.Fatalf("unsupported fixture: %+v %v", result, err)
	}
}
