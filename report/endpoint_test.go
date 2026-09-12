package report

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/saltyorg/saltbox-lint/lint"
)

func TestHumanEndpointCaretFitsFullFinalVisualRow(t *testing.T) {
	for _, width := range []int{8, 40, 80} {
		budget := width - 4
		for _, test := range []struct {
			name, text, ending string
			newlineSpan        bool
		}{
			{name: "ascii eof", text: strings.Repeat("a", budget)},
			{name: "unicode eof", text: strings.Repeat("界", budget/2)},
			{name: "wrapped final row", text: strings.Repeat("e\u0301", budget*2)},
			{name: "before newline", text: strings.Repeat("a", budget), ending: "\n"},
			{name: "newline span", text: strings.Repeat("a", budget), ending: "\n", newlineSpan: true},
			{name: "before crlf", text: strings.Repeat("a", budget), ending: "\r\n"},
		} {
			t.Run(fmt.Sprintf("%d/%s", width, test.name), func(t *testing.T) {
				source := &lint.Source{Path: "a.yml", Data: []byte(test.text + test.ending)}
				p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
				span := lint.Span{Start: len(test.text), End: len(test.text)}
				if test.newlineSpan {
					span.End++
				}
				var out bytes.Buffer
				if err := Render(&out, p, []lint.Diagnostic{{Path: source.Path, RuleID: "endpoint", Message: "endpoint", Span: span}}, Options{Human: HumanOptions{Width: width}}); err != nil {
					t.Fatal(err)
				}
				var recovered strings.Builder
				carets := 0
				for _, row := range strings.Split(out.String(), "\n") {
					if strings.HasPrefix(row, "1 | ") {
						recovered.WriteString(strings.TrimPrefix(row, "1 | "))
					}
					if strings.HasPrefix(row, "  ↪ ") {
						recovered.WriteString(strings.TrimPrefix(row, "  ↪ "))
					}
					if strings.HasPrefix(row, "  | ") {
						carets += strings.Count(row, "^")
					}
					if strings.Contains(row, " | ") || strings.Contains(row, " ↪ ") {
						if charmansi.StringWidth(row) > width {
							t.Fatalf("row exceeds terminal width %d: %q", width, row)
						}
					}
				}
				if recovered.String() != test.text || string(source.Data) != test.text+test.ending {
					t.Fatalf("source altered: %q", recovered.String())
				}
				if carets != 1 {
					t.Fatalf("endpoint carets=%d want1", carets)
				}
				if !strings.Contains(out.String(), "  ↪ \n  | ^\n") {
					t.Fatalf("missing empty continuation with endpoint caret:\n%s", &out)
				}
			})
		}
	}
}

func TestHumanEndpointCaretUsesExistingRoomOrTrailingEmptyLine(t *testing.T) {
	for _, test := range []struct{ name, data, want string }{
		{"spare room", "aaa", "1 | aaa\n  |    ^\n"},
		{"empty EOF after newline", "aaaa\n", "2 | \n  | ^\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := &lint.Source{Path: "a.yml", Data: []byte(test.data)}
			p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
			end := len(test.data)
			var out bytes.Buffer
			if err := Render(&out, p, []lint.Diagnostic{{Path: source.Path, RuleID: "endpoint", Message: "endpoint", Span: lint.Span{Start: end, End: end}}}, Options{Human: HumanOptions{Width: 8}}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), test.want) || strings.Contains(out.String(), "↪") {
				t.Fatalf("unnecessary continuation or wrong caret:\n%s", &out)
			}
		})
	}
}
