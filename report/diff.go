package report

import (
	"bytes"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode"

	"github.com/saltyorg/saltbox-lint/lint"
)

// Diff emits one unified hunk per changed file, retaining original line endings
// and the missing-final-newline marker. It never writes source files.
func Diff(w io.Writer, changes []lint.Change) error {
	var b strings.Builder
	for _, change := range changes {
		if bytes.Equal(change.Before, change.After) {
			continue
		}
		before, after := diffLines(change.Before), diffLines(change.After)
		fmt.Fprintf(&b, "--- %s\n+++ %s\n", diffPath("a/"+change.Path), diffPath("b/"+change.Path))
		oldStart, newStart := 1, 1
		if len(before) == 0 {
			oldStart = 0
		}
		if len(after) == 0 {
			newStart = 0
		}
		fmt.Fprintf(&b, "@@ -%d,%d +%d,%d @@\n", oldStart, len(before), newStart, len(after))
		for _, part := range []struct {
			prefix string
			lines  []string
		}{{"-", before}, {"+", after}} {
			for _, line := range part.lines {
				b.WriteString(part.prefix)
				b.WriteString(line)
				if !strings.HasSuffix(line, "\n") {
					b.WriteString("\n\\ No newline at end of file\n")
				}
			}
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}
func diffLines(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	lines := strings.SplitAfter(string(data), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}
func diffPath(path string) string {
	if strings.ContainsFunc(path, func(r rune) bool { return unicode.IsSpace(r) || r == '"' || r == '\\' }) {
		return strconv.Quote(path)
	}
	return path
}
