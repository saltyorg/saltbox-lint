package lint

import (
	"strings"
	"testing"
)

func jinjaSource(t *testing.T, input string) *Source {
	t.Helper()
	s, ds := Parse("values.yml", []byte(input))
	if len(ds) != 0 {
		t.Fatalf("parse: %+v", ds)
	}
	return s
}

func TestExpressionsDecodeYAMLAndRetainSourceSpans(t *testing.T) {
	for _, input := range []string{
		"value: '{{ lookup(''role_var'', ''_x'', role=''example'') }}'\n",
		"value: \"{{ lookup(\\\"role_var\\\", \\\"_x\\\", role=\\\"example\\\") }}\"\n",
	} {
		s := jinjaSource(t, input)
		es := Expressions(s)
		if len(es) != 1 || !es[0].Complete {
			t.Fatalf("expressions: %+v", es)
		}
		cs := Calls(es[0], "lookup")
		if len(cs) != 1 || len(cs[0].Arguments) != 3 || cs[0].Arguments[2].Name != "role" {
			t.Fatalf("calls: %+v", cs)
		}
		tok := cs[0].Arguments[2].Tokens[0]
		if tok.Kind != "string" || strings.Trim(tok.Text, "\"'") != "example" {
			t.Fatalf("literal: %+v", tok)
		}
		raw := string(s.Data[tok.Span.Start:tok.Span.End])
		if raw != "''example''" && raw != "\\\"example\\\"" {
			t.Fatalf("raw literal: %q", raw)
		}
	}
	s := jinjaSource(t, "value: '{{ ''svm'' }}'\n")
	if es := Expressions(s); len(es) != 1 || es[0].Tokens[0].Kind != "string" || es[0].Tokens[0].Text != "'svm'" {
		t.Fatalf("literal: %+v", es)
	}
}

func TestExpressionsIgnoreCommentsRawUnsafeAndRespectDelimiters(t *testing.T) {
	s := jinjaSource(t, `# {{ ignored }}
a: !unsafe '{{ ignored }}'
b: "{# {{ ignored }} #}{% raw %}{{ ignored }}{% endraw %}{{ {'x': '}}', 'y': lookup('a', nested(1, 2), flag=True)} }}"
c: '{% set x = lookup("a") %}'
d: '{{ incomplete('
`)
	es := Expressions(s)
	if len(es) != 3 || es[0].Kind != "output" || !es[0].Complete || es[1].Kind != "statement" || !es[1].Complete || es[2].Complete {
		t.Fatalf("expressions: %+v", es)
	}
	cs := Calls(es[0], "lookup")
	if len(cs) != 1 || len(cs[0].Arguments) != 3 || cs[0].Arguments[2].Name != "flag" {
		t.Fatalf("calls: %+v", cs)
	}
}

func TestCallsFindNestedCallsWithoutStringFalsePositives(t *testing.T) {
	es := Expressions(jinjaSource(t, `v: "{{ lookup('a', lookup('b', {'x': [1, 2]}), note='lookup(fake)') }}"`))
	cs := Calls(es[0], "lookup")
	if len(cs) != 2 || len(cs[0].Arguments) != 3 || len(cs[1].Arguments) != 2 {
		t.Fatalf("calls: %+v", cs)
	}
}

func TestExpressionMappingThroughFoldingEscapesAndUTF8(t *testing.T) {
	for _, tc := range []struct{ input, raw, text string }{
		{"v: >-\n  {{ lookup(\n       'a  b') }}\n", "'a  b'", "'a  b'"},
		{"v: \"é {{ lookup('\\u0061') }}\"\n", "'\\u0061'", "'a'"},
		{"v: \"{{ lookup('a\\\n  b') }}\"\n", "'a\\\n  b'", "'ab'"},
		{"v: \"{{ lookup('a\n  b') }}\"\n", "'a\n  b'", "'a b'"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			s := jinjaSource(t, tc.input)
			es := Expressions(s)
			if len(es) != 1 {
				t.Fatalf("expressions: %+v", es)
			}
			calls := Calls(es[0], "lookup")
			if len(calls) != 1 || len(calls[0].Arguments) != 1 {
				t.Fatalf("calls: %+v", calls)
			}
			tok := calls[0].Arguments[0].Tokens[0]
			if tok.Text != tc.text || string(s.Data[tok.Span.Start:tok.Span.End]) != tc.raw {
				t.Fatalf("token %+v raw=%q", tok, s.Data[tok.Span.Start:tok.Span.End])
			}
		})
	}
}
func TestWhitespaceControlAndRawCommentMarkers(t *testing.T) {
	s := jinjaSource(t, "# {% raw %}\nv: \"{{- lookup('a') -}} {# ignored #} {%+ set v = lookup('b') +%}\"\n")
	es := Expressions(s)
	if len(es) != 2 || !es[0].Complete || !es[1].Complete {
		t.Fatalf("expressions: %+v", es)
	}
	for i, e := range es {
		if len(Calls(e, "lookup")) != 1 {
			t.Fatalf("expression %d calls: %+v", i, Calls(e, "lookup"))
		}
	}
	if string(s.Data[es[0].Span.Start:es[0].Span.End]) != "{{- lookup('a') -}}" {
		t.Fatalf("control span: %+v", es[0].Span)
	}
}

func TestNumericTokensKeepExponentAndBasePrefixesAtomic(t *testing.T) {
	es := Expressions(jinjaSource(t, "v: '{{ [1e3, 1.2e-3, 0xff, 0o17, 0b11, 1_000] }}'\n"))
	var numbers []string
	for _, tok := range es[0].Tokens {
		if tok.Kind == "number" {
			numbers = append(numbers, tok.Text)
		}
	}
	want := []string{"1e3", "1.2e-3", "0xff", "0o17", "0b11", "1_000"}
	if len(numbers) != len(want) {
		t.Fatalf("numbers: %q", numbers)
	}
	for i := range want {
		if numbers[i] != want[i] {
			t.Fatalf("numbers: %q want %q", numbers, want)
		}
	}
}

func TestUnavailableScalarMappingCannotExposeGuessedTokenSpans(t *testing.T) {
	s := jinjaSource(t, "v: '{{ a\n | f }}'\n")
	// Model an unavailable/stale scalar adaptation at the public Source boundary.
	s.Documents[0].Get("v").Value = "{{ another\n | f }}"
	es := Expressions(s)
	if len(es) != 1 || es[0].Complete || len(es[0].Tokens) > 0 {
		t.Fatalf("guessed token mapping exposed: %+v", es)
	}
	ds := checkLayout(nil, s)
	if len(ds) != 1 || ds[0].Expected == "" || ds[0].Fix != nil {
		t.Fatalf("unavailable mapping diagnostic: %+v", ds)
	}
}
