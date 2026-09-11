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
