package lint

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

// These are the 29 code points admitted by the installed Jinja lexer's Python
// \\s pattern. Keep the expected set independent of the Go scanner predicate.
const templateWhitespace = "\t\n\v\f\r\x1c\x1d\x1e\x1f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"

func TestTemplateJinjaWhitespace(t *testing.T) {
	for _, r := range templateWhitespace {
		t.Run(fmt.Sprintf("U+%04X", r), func(t *testing.T) {
			w := string(r)
			for _, body := range []string{
				"{% raw" + w + "%}{{ unmatched{% endraw %}",
				"{%" + w + "raw" + w + "-%}{{ unmatched{% nonsense %}{%+" + w + "endraw" + w + "+%}",
				"{% if" + w + "enabled %}yes{% else" + w + "%}no{% endif" + w + "%}",
				"{% block" + w + "title %}yes{% endblock" + w + "title" + w + "%}",
				"{% macro" + w + "render(" + w + "x" + w + "=" + w + "'text'" + w + ") %}{{ x }}{% endmacro" + w + "%}{% call" + w + "render(value) %}x{% endcall" + w + "%}",
				"{%- set" + w + "value" + w + "=" + w + "'" + w + "}}' -%}{{-" + w + "value" + w + "-}}",
				"{#" + w + "{{ unmatched {% #}{{" + w + "value" + w + "==" + w + "1" + w + "}}",
			} {
				data := []byte("😀\r\n\t " + body + "  ")
				source, _ := Parse("roles/demo/templates/config", data)
				scan := scanTemplate(source)
				if len(scan.diagnostics) != 0 || len(scan.reasons) != 0 || observedSource(source).ParseState != "static-template" {
					t.Fatalf("valid whitespace %q fabricated errors or partial coverage: %+v", body, scan)
				}
				if !bytes.Equal(data, source.Data) {
					t.Fatal("template bytes changed")
				}
				for _, e := range scan.expressions {
					for _, token := range e.Tokens {
						if !utf8.Valid(data[token.Span.Start:token.Span.End]) || string(data[token.Span.Start:token.Span.End]) != token.Text {
							t.Fatalf("lost original UTF-8 token span: %+v", token)
						}
					}
				}
			}
		})
	}
}

func TestTemplateHeaderWhitespaceAndNonspaceControls(t *testing.T) {
	for _, w := range []string{"\f", "\v", "\x1c\x1f", "\u00a0\u2003"} {
		text := "#jinja2:" + w + "variable_start_string" + w + ":\f'[['\f," + w + "variable_end_string" + w + ":\f']]'\f\n[[" + w + "value" + w + "]]"
		source, _ := Parse("header.j2", []byte(text))
		if scan := scanTemplate(source); len(scan.reasons) != 0 || len(scan.diagnostics) != 0 || len(scan.expressions) != 1 {
			t.Fatalf("valid header whitespace %q: %+v", w, scan)
		}
		text = "#jinja2:variable_start_string:'" + w + "[['\n{{ unfinished"
		source, _ = Parse("header.j2", []byte(text))
		if scan := scanTemplate(source); len(scan.diagnostics) != 0 || !strings.Contains(strings.Join(scan.reasons, ";"), "delimiter size or whitespace") {
			t.Fatalf("unsupported whitespace delimiter fabricated grammar: %+v", scan)
		}
	}
	for _, r := range templateWhitespace {
		if r == '\n' {
			continue // The header's physical newline terminates its value.
		}
		for _, value := range []string{"True", "'[ ['"} {
			key := "trim_blocks"
			if value != "True" {
				key = "variable_start_string"
			}
			text := "#jinja2:" + key + ":" + string(r) + value + string(r) + "\n"
			source, _ := Parse("header.j2", []byte(text))
			scan := scanTemplate(source)
			accepted := strings.ContainsRune(" \t\r\f", r)
			if len(scan.diagnostics) != 0 || (len(scan.reasons) == 0) != accepted {
				t.Fatalf("Python literal whitespace U+%04X %q: %+v", r, value, scan)
			}
		}
	}
	for _, tc := range []struct{ input, errorText, partial string }{
		{"{% raw! %}{{ unmatched{% endraw %}", "does not accept arguments", ""},
		{"{% if enabled %}x{% endif! %}", "invalid", ""},
		{"{% raw\u200b%}{{ unmatched{% endraw %}", "", "Unicode source boundaries"},
		{"{% if enabled %}x{% endif\u2060%}", "", "Unicode source boundaries"},
		{"{{ value\ufeff }}", "", "Unicode source boundaries"},
		{"{{ value! }}", "", "expression grammar"},
	} {
		source, _ := Parse("control.j2", []byte(tc.input))
		scan := scanTemplate(source)
		if tc.errorText == "" && len(scan.diagnostics) != 0 || tc.errorText != "" && !slices.ContainsFunc(scan.diagnostics, func(d Diagnostic) bool { return strings.Contains(d.Message, tc.errorText) }) {
			t.Fatalf("nonspace control %q: %+v", tc.input, scan)
		}
		if tc.partial != "" && !strings.Contains(strings.Join(scan.reasons, ";"), tc.partial) {
			t.Fatalf("missing partial reason for %q: %+v", tc.input, scan)
		}
	}
}

func TestTemplateWhitespaceReferenceSelectionPreservesBytes(t *testing.T) {
	root := t.TempDir()
	name := "roles/alpha/templates/config"
	text := "😀\r\n😀{% if\fenabled %}{{\u2003lookup\v('role_var',\u00a0'_port',\x1crole\x1f=\u3000'beta')\u202f}}{% endif\f%}  "
	filename := putFile(t, root, name, text)
	putFile(t, root, "roles/alpha/defaults/main.yml", "alpha_role_value: true\n")
	putFile(t, root, "roles/beta/defaults/main.yml", "beta_role_port: 1234\n")
	for _, paths := range [][]string{{filename}, {root, filename}} {
		refs, err := References(t.Context(), Options{Root: root, Paths: paths})
		if err != nil || len(refs.References) != 1 || refs.References[0].State != "resolved" || refs.References[0].Location.Path != name {
			t.Fatalf("selection %v: %+v %v", paths, refs, err)
		}
	}
	for _, op := range []string{"definition", "hover", "references", "completion"} {
		q, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Source: []byte(text), Operation: op, Offset: strings.Index(text, "_port") + 2})
		if err != nil {
			t.Fatal(err)
		}
		if op == "completion" {
			if q.State != "unavailable" || len(q.Completions) != 0 {
				t.Fatalf("template completion became writable: %+v", q)
			}
			continue
		}
		if q.State != "resolved" || len(q.Declarations) != 1 || q.Origin == nil || q.Origin.Line != 2 || q.Origin.Column != 21 || q.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(text))) {
			t.Fatalf("lost query reference or original coordinates: %+v", q)
		}
		if q.Origin.Text != "lookup\v('role_var',\u00a0'_port',\x1crole\x1f=\u3000'beta')" || text[q.Origin.Span.Start:q.Origin.Span.End] != q.Origin.Text {
			t.Fatalf("lost original half-open UTF-8 call span: %+v", q.Origin)
		}
	}
	if after, err := os.ReadFile(filename); err != nil || string(after) != text {
		t.Fatal("template file changed")
	}
}

func TestYAMLExpressionWhitespaceRemainsStable(t *testing.T) {
	for _, w := range []string{"\f", "\v", "\x1c", "\u00a0", "\u2003"} {
		expressions := scanExpressions("{{ value" + w + "}}")
		if len(expressions) != 1 || len(expressions[0].Tokens) <= 1 || expressions[0].Tokens[0].Text != "value" {
			t.Fatalf("changed existing YAML expression tokens for %q: %+v", w, expressions)
		}
	}
}
