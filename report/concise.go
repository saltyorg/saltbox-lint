package report

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"unicode/utf16"

	"github.com/saltyorg/saltbox-lint/lint"
)

// concise preserves the stable, one-diagnostic-per-line machine format.
func concise(w io.Writer, p *lint.Project, ds []Diagnostic) error {
	var b strings.Builder
	for _, d := range ds {
		pos := d.Range.Start
		pos.Column = utf16Column(p.Sources[d.Path], d.Span.Start)
		fmt.Fprintf(&b, "%s:%d:%d: %s [%s] %s\n", singleLine(d.Path), pos.Line, pos.Column, singleLine(d.Severity), singleLine(d.RuleID), singleLine(d.Message))
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

func singleLine(s string) string {
	return strings.NewReplacer("\r", "\\r", "\n", "\\n").Replace(s)
}
