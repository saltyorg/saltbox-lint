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
		fmt.Fprintf(&b, "%s:%d:%d: %s [%s] %s\n", concisePath(d.Path), pos.Line, pos.Column, singleLine(d.Severity), singleLine(d.RuleID), singleLine(d.Message))
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

// utf16Range adapts original half-open byte spans for UTF-16 consumers.
func utf16Range(s *lint.Source, span Span) Range {
	start, end := s.Position(span.Start), s.Position(span.End)
	return Range{Position{start.Line, utf16Column(s, span.Start)}, Position{end.Line, utf16Column(s, span.End)}}
}

// singleLine keeps each finding on one terminal-safe line with the same
// control notation as human output; ordinary Unicode remains literal.
func singleLine(s string) string { return escapeControls(s, false, nil) }

// concisePath also doubles backslashes, so a path spelling a literal escape
// such as `\n` stays distinguishable from an escaped control.
func concisePath(s string) string { return escapeControls(s, true, nil) }
