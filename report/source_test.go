package report

import (
	"bytes"
	"strings"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestHumanExcerptPreservesLineEndingSemantics(t *testing.T) {
	for _, test := range []struct {
		name      string
		ending    string
		displayed string
	}{
		{name: "LF", ending: "\n", displayed: "key: bad"},
		{name: "CRLF", ending: "\r\n", displayed: "key: bad"},
		{name: "no final newline", displayed: "key: bad"},
		{name: "lone final CR", ending: "\r", displayed: `key: bad\r`},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := []byte("key: bad" + test.ending)
			source, _ := lint.Parse("a.yml", data)
			project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
			diagnostic := lint.Diagnostic{Path: source.Path, RuleID: "excerpt", Severity: "error", Message: "bad value", Span: lint.Span{Start: 5, End: 8}}

			var out bytes.Buffer
			if err := Render(&out, project, []lint.Diagnostic{diagnostic}, Options{Format: "human"}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "1 | "+test.displayed) {
				t.Fatalf("excerpt missing displayed source %q:\n%s", test.displayed, &out)
			}
			if !bytes.Equal(source.Data, data) {
				t.Fatalf("Render changed source bytes: got %q want %q", source.Data, data)
			}
		})
	}
}

func TestHumanComparisonPreservesLineEndingSemantics(t *testing.T) {
	for _, test := range []struct {
		name          string
		ending        string
		wantDisplayed string
		wantMarker    bool
	}{
		{name: "LF", ending: "\n", wantDisplayed: "key: bad", wantMarker: false},
		{name: "CRLF", ending: "\r\n", wantDisplayed: "key: bad", wantMarker: false},
		{name: "no final newline", wantDisplayed: "key: bad", wantMarker: true},
		{name: "lone final CR", ending: "\r", wantDisplayed: `key: bad\r`, wantMarker: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := []byte("key: bad" + test.ending)
			source, _ := lint.Parse("a.yml", data)
			project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
			diagnostic := lint.Diagnostic{
				Path: source.Path, RuleID: "comparison", Severity: "error", Message: "bad value",
				Span:    lint.Span{Start: 5, End: 8},
				Preview: &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: 5, End: 8}, Text: "good"}}},
			}

			var out bytes.Buffer
			if err := Render(&out, project, []lint.Diagnostic{diagnostic}, Options{Format: "human"}); err != nil {
				t.Fatal(err)
			}
			text := out.String()
			if !strings.Contains(text, "│ - "+test.wantDisplayed) || !strings.Contains(text, "│ + key: good") {
				t.Fatalf("comparison lost displayed source:\n%s", text)
			}
			marker := strings.Contains(text, `\ No newline at end of file`)
			if marker != test.wantMarker {
				t.Fatalf("missing-newline marker = %t, want %t:\n%s", marker, test.wantMarker, text)
			}
			if !bytes.Equal(source.Data, data) {
				t.Fatalf("Render changed source bytes: got %q want %q", source.Data, data)
			}
		})
	}
}
