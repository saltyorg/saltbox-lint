package report

import (
	"bytes"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestConciseFormatPreservesStableBytesAndEmptyOutput(t *testing.T) {
	path := "a\n.yml"
	source := &lint.Source{Path: path, Data: []byte("😀x\n")}
	project := &lint.Project{Sources: map[string]*lint.Source{path: source}}
	diagnostics := []lint.Diagnostic{{Path: path, RuleID: "rule\nline", Severity: "error\rlevel", Message: "bad\r\nvalue", Span: lint.Span{Start: len("😀"), End: len("😀x")}}}

	var out bytes.Buffer
	if err := Render(&out, project, diagnostics, Options{Format: "concise", Human: HumanOptions{Width: 1, ColorProfile: ColorTrueColor}}); err != nil {
		t.Fatal(err)
	}
	want := "a\\n.yml:1:3: error\\rlevel [rule\\nline] bad\\r\\nvalue\n"
	if out.String() != want {
		t.Fatalf("concise output changed:\n got %q\nwant %q", out.String(), want)
	}

	out.Reset()
	if err := Render(&out, project, nil, Options{Format: "concise"}); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("clean concise output = %q, want empty", &out)
	}
}

func TestConciseEscapesTerminalControlsUnambiguously(t *testing.T) {
	path := "roles/x y,z:ü\x1b[31mR\\n\u202e界.yml"
	source := &lint.Source{Path: path, Data: []byte("😀x\n")}
	project := &lint.Project{Sources: map[string]*lint.Source{path: source}}
	diagnostics := []lint.Diagnostic{{Path: path, RuleID: "rule\a", Severity: "error", Message: "bad\u009b\u2066\xff\tü界 \\n", Span: lint.Span{Start: len("😀"), End: len("😀x")}}}

	var out bytes.Buffer
	if err := Render(&out, project, diagnostics, Options{Format: "concise"}); err != nil {
		t.Fatal(err)
	}
	// Paths double literal backslashes; messages keep them as prose.
	want := "roles/x y,z:ü\\x1b[31mR\\\\n\\u202e界.yml:1:3: error [rule\\x07] bad\\u009b\\u2066\\xff\\tü界 \\n\n"
	if out.String() != want {
		t.Fatalf("concise controls:\n got %q\nwant %q", out.String(), want)
	}
}
