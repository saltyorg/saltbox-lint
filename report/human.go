package report

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"unicode/utf16"

	"github.com/saltyorg/saltbox-lint/lint"
)

func human(w io.Writer, p *lint.Project, ds []Diagnostic, concise bool) error {
	var b strings.Builder
	for _, d := range ds {
		pos := d.Range.Start
		if concise {
			pos.Column = utf16Column(p.Sources[d.Path], d.Span.Start)
		}
		fmt.Fprintf(&b, "%s:%d:%d: %s [%s] %s\n", singleLine(d.Path), pos.Line, pos.Column, singleLine(d.Severity), singleLine(d.RuleID), singleLine(d.Message))
		if concise {
			continue
		}
		if s := p.Sources[d.Path]; s != nil {
			lines := strings.Split(string(s.Data), "\n")
			if pos.Line > 0 && pos.Line <= len(lines) {
				fmt.Fprintf(&b, "  %d | %s\n", pos.Line, strings.TrimSuffix(lines[pos.Line-1], "\r"))
				fmt.Fprintf(&b, "    | %s^\n", strings.Repeat(" ", max(0, pos.Column-1)))
			}
		}
		if d.Expected != "" {
			fmt.Fprintf(&b, "  Expected: %s\n", strings.ReplaceAll(d.Expected, "\n", "\n    "))
		}
		for _, r := range d.Related {
			fmt.Fprintf(&b, "  Related: %s:%d:%d: %s\n", singleLine(r.Path), r.Range.Start.Line, r.Range.Start.Column, singleLine(r.Message))
		}
	}
	if len(ds) == 0 && !concise {
		b.WriteString("No findings.\n")
	}
	_, err := io.WriteString(w, b.String())
	return err
}
func utf16Column(s *lint.Source, offset int) int {
	if s == nil {
		return 1
	}
	offset = min(max(offset, 0), len(s.Data))
	start := bytes.LastIndexByte(s.Data[:offset], '\n') + 1
	return 1 + len(utf16.Encode([]rune(string(s.Data[start:offset]))))
}
func singleLine(s string) string { return strings.NewReplacer("\r", "\\r", "\n", "\\n").Replace(s) }
