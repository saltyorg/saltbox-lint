// Package fuzztest supplies bounded inputs and source assertions to fuzz tests.
// It is imported only by tests and is absent from the shipped CLI.
package fuzztest

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"
)

const MaxBytes = 2048

// Bounded conservatively caps nesting at 64: every line and opening delimiter
// consumes one unit, even inside quoted text. Block nesting consumes lines;
// flow/expression nesting consumes delimiters. Size also bounds unary recursion.
func Bounded(data []byte) bool {
	if len(data) > MaxBytes {
		return false
	}
	depth := 1
	for _, b := range data {
		if b == '\n' || b == '[' || b == '{' || b == '(' {
			depth++
		}
	}
	return depth <= 64
}

// Seeds returns every committed source case, including the empty file.
func Seeds(f *testing.F, dir string) [][]byte {
	f.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		f.Fatal(err)
	}
	var seeds [][]byte
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			f.Fatal(err)
		}
		if !Bounded(data) {
			f.Fatalf("seed exceeds bounds: %s", entry.Name())
		}
		seeds = append(seeds, data)
	}
	if len(seeds) == 0 {
		f.Fatal("empty seed collection")
	}
	return seeds
}

func Span(t *testing.T, data []byte, start, end int) {
	t.Helper()
	if start < 0 || end < start || end > len(data) {
		t.Fatalf("span %d:%d outside %d bytes", start, end, len(data))
	}
}

// Boundary matches the editor's supported UTF-8 and CRLF edit boundaries.
func Boundary(data []byte, offset int) bool {
	return offset >= 0 && offset <= len(data) &&
		(offset == len(data) || utf8.RuneStart(data[offset])) &&
		!(offset > 0 && offset < len(data) && data[offset] == '\n' && data[offset-1] == '\r')
}

func Unchanged(t *testing.T, before, after []byte) {
	t.Helper()
	if !bytes.Equal(before, after) {
		t.Fatal("caller-owned source bytes changed")
	}
}
