package format

import (
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestIndependentVerificationRejectsSemanticMutations(t *testing.T) {
	for _, tt := range []struct{ name, before, after string }{
		{"type", "v: 'true'\n", "v: true\n"},
		{"value", "v: 'x'\n", "v: 'y'\n"},
		{"order", "a: 1\nb: 2\n", "b: 2\na: 1\n"},
		{"anchor", "a: &a 1\nb: *a\n", "a: &b 1\nb: *b\n"},
		{"alias target", "a: &a 1\nb: &b 1\nc: *a\n", "a: &a 1\nb: &b 1\nc: *b\n"},
		{"tag", "a: !unsafe x\n", "a: x\n"},
		{"comment owner", "a: 1 # allow\nb: 2\n", "a: 1\nb: 2 # allow\n"},
		{"comment placement", "a: 1 # allow\n", "# allow\na: 1\n"},
		{"literal value", "a: |-\n  a  b\n", "a: |-\n  a b\n"},
		{"block style", "a: |-\n  value\n", "a: >-\n  value\n"},
		{"chomping", "a: |-\n  value\n", "a: |\n  value\n"},
		{"document marker", "---\na: 1\n", "a: 1\n"},
		{"jinja literal", "a: \"{{ 'a  b' }}\"\n", "a: \"{{ 'a b' }}\"\n"},
		{"jinja control", "a: '{{- x -}}'\n", "a: '{{ x }}'\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			a, ad := lint.Parse("vars.yml", []byte(tt.before))
			b, bd := lint.Parse("vars.yml", []byte(tt.after))
			if len(ad)+len(bd) > 0 {
				t.Fatalf("invalid fixture: %v, %v", ad, bd)
			}
			if err := verify(t.Context(), a, b, false); err == nil {
				t.Fatal("accepted a semantic mutation")
			}
		})
	}
}

func TestDiagnosticVerificationDoesNotTradeViolationsBetweenOwners(t *testing.T) {
	scalar := "- \"{{ '" + strings.Repeat("x", 134) + "' if x else y }}\"\n"
	before, _ := lint.Parse("vars.yml", []byte("a:\n    "+scalar+"b:\n"+scalar))
	after, _ := lint.Parse("vars.yml", []byte("a:\n  "+scalar+"b:\n    "+scalar))
	if err := verifyDiagnostics(t.Context(), before, after); err == nil {
		t.Fatal("a removed violation hid a new violation on another value")
	}
}

func TestSectionCommentBaselineProtectsNeighboringComments(t *testing.T) {
	banner := "################################\n# Settings\n################################\n"
	before, _ := lint.Parse("vars.yml", []byte(banner+"# variable docs\na: 1 # saltbox-lint allow cmd-shell\nb: 2\n"))
	after, _ := lint.Parse("vars.yml", []byte(banner+"\n# variable docs\na: 1\nb: 2 # saltbox-lint allow cmd-shell\n"))
	if err := verify(t.Context(), before, after, true); err == nil {
		t.Fatal("section baseline allowed suppression comment movement")
	}
	after, _ = lint.Parse("vars.yml", []byte(banner+"\na: 1 # saltbox-lint allow cmd-shell\n# variable docs\nb: 2\n"))
	if err := verify(t.Context(), before, after, true); err == nil {
		t.Fatal("section baseline allowed documentation comment movement")
	}
}

func TestVerificationProtectsLexicalScalarSpelling(t *testing.T) {
	for _, tt := range []struct{ name, before, after string }{
		{"escape spelling", "v: \"a\\x20b\"\n", "v: \"a b\"\n"},
		{"plain spelling", "v: hello\n", "v: \"hello\"\n"},
		{"mixed quotes", "v: 'He said \"hello\"'\n", "v: \"He said \\\"hello\\\"\"\n"},
		{"chomp spelling", "v: |+\n  hello\n", "v: |\n  hello\n"},
		{"literal trailing blank lines", "v: |-\n  hello\n\n", "v: |-\n  hello\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			before, ad := lint.Parse("vars.yml", []byte(tt.before))
			after, bd := lint.Parse("vars.yml", []byte(tt.after))
			if len(ad)+len(bd) > 0 {
				t.Fatalf("invalid fixtures: %v %v", ad, bd)
			}
			if err := verify(t.Context(), before, after, false); err == nil {
				t.Fatal("accepted protected spelling change")
			}
		})
	}
}
