package report

import (
	"bytes"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
)

// diffContext is the number of unchanged lines shown around each change, and
// diffEditLimit bounds the Myers search before falling back to replacing the
// remaining differing range as one block.
const (
	diffContext   = 3
	diffEditLimit = 1000
)

// Diff emits minimal unified hunks with three context lines per changed file,
// retaining original line endings and the missing-final-newline marker. It
// never writes source files.
func Diff(w io.Writer, changes []lint.Change) error {
	var b strings.Builder
	for _, change := range changes {
		if bytes.Equal(change.Before, change.After) {
			continue
		}
		fmt.Fprintf(&b, "--- %s\n+++ %s\n", diffPath("a/"+change.Path), diffPath("b/"+change.Path))
		writeHunks(&b, diffOps(diffLines(change.Before), diffLines(change.After)))
	}
	_, err := io.WriteString(w, b.String())
	return err
}

type diffOp struct {
	kind byte // ' ', '-' or '+'
	line string
}

// diffOps returns the full line edit script from before to after. Lines retain
// their terminators, so line-ending and final-newline changes are edits.
func diffOps(before, after []string) []diffOp {
	prefix := 0
	for prefix < len(before) && prefix < len(after) && before[prefix] == after[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(before)-prefix && suffix < len(after)-prefix && before[len(before)-1-suffix] == after[len(after)-1-suffix] {
		suffix++
	}
	ops := make([]diffOp, 0, len(before)+len(after)-prefix-suffix)
	for _, line := range before[:prefix] {
		ops = append(ops, diffOp{' ', line})
	}
	a, c := before[prefix:len(before)-suffix], after[prefix:len(after)-suffix]
	if middle, ok := myers(a, c, diffEditLimit); ok {
		ops = append(ops, middle...)
	} else {
		for _, line := range a {
			ops = append(ops, diffOp{'-', line})
		}
		for _, line := range c {
			ops = append(ops, diffOp{'+', line})
		}
	}
	for _, line := range before[len(before)-suffix:] {
		ops = append(ops, diffOp{' ', line})
	}
	return ops
}

// myers computes a shortest edit script, reporting false when it needs more
// than limit insertions and deletions.
func myers(a, b []string, limit int) ([]diffOp, bool) {
	n, m := len(a), len(b)
	if n == 0 || m == 0 {
		ops := make([]diffOp, 0, n+m)
		for _, line := range a {
			ops = append(ops, diffOp{'-', line})
		}
		for _, line := range b {
			ops = append(ops, diffOp{'+', line})
		}
		return ops, true
	}
	maxD := min(n+m, limit)
	offset := maxD + 1
	v := make([]int, 2*offset+1)
	// trace[d] holds v for diagonals -d..d after step d.
	var trace [][]int
	for d := 0; d <= maxD; d++ {
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[offset+k-1] < v[offset+k+1]) {
				x = v[offset+k+1]
			} else {
				x = v[offset+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x++
				y++
			}
			v[offset+k] = x
			if x >= n && y >= m {
				return myersPath(a, b, trace, d), true
			}
		}
		trace = append(trace, append([]int(nil), v[offset-d:offset+d+1]...))
	}
	return nil, false
}

func myersPath(a, b []string, trace [][]int, final int) []diffOp {
	ops := make([]diffOp, 0, len(a)+len(b))
	x, y := len(a), len(b)
	for d := final; d > 0; d-- {
		prev := trace[d-1]
		at := func(k int) int { return prev[k+d-1] }
		k := x - y
		prevK := k - 1
		if k == -d || (k != d && at(k-1) < at(k+1)) {
			prevK = k + 1
		}
		prevX := at(prevK)
		prevY := prevX - prevK
		for x > prevX && y > prevY {
			x--
			y--
			ops = append(ops, diffOp{' ', a[x]})
		}
		if x == prevX {
			y--
			ops = append(ops, diffOp{'+', b[y]})
		} else {
			x--
			ops = append(ops, diffOp{'-', a[x]})
		}
	}
	for x > 0 {
		x--
		ops = append(ops, diffOp{' ', a[x]})
	}
	slices.Reverse(ops)
	return ops
}

// writeHunks groups edits with diffContext surrounding lines, merging hunks
// whose unchanged gap is at most twice the context.
func writeHunks(b *strings.Builder, ops []diffOp) {
	oldLine, newLine := 0, 0
	oldAt := make([]int, len(ops)+1)
	newAt := make([]int, len(ops)+1)
	for i, op := range ops {
		oldAt[i], newAt[i] = oldLine, newLine
		if op.kind != '+' {
			oldLine++
		}
		if op.kind != '-' {
			newLine++
		}
	}
	oldAt[len(ops)], newAt[len(ops)] = oldLine, newLine
	for i := 0; i < len(ops); {
		if ops[i].kind == ' ' {
			i++
			continue
		}
		start := max(0, i-diffContext)
		end := i
		for j := i; j < len(ops); j++ {
			if ops[j].kind == ' ' {
				continue
			}
			if j-end-1 > 2*diffContext {
				break
			}
			end = j
		}
		stop := min(len(ops), end+1+diffContext)
		oldCount, newCount := oldAt[stop]-oldAt[start], newAt[stop]-newAt[start]
		oldStart, newStart := oldAt[start], newAt[start]
		if oldCount > 0 {
			oldStart++
		}
		if newCount > 0 {
			newStart++
		}
		fmt.Fprintf(b, "@@ -%d,%d +%d,%d @@\n", oldStart, oldCount, newStart, newCount)
		for _, op := range ops[start:stop] {
			b.WriteByte(op.kind)
			b.WriteString(op.line)
			if !strings.HasSuffix(op.line, "\n") {
				b.WriteString("\n\\ No newline at end of file\n")
			}
		}
		i = stop
	}
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
	quoted := false
	for i := 0; i < len(path); i++ {
		c := path[i]
		if c <= ' ' || c >= 0x7f || c == '"' || c == '\\' {
			quoted = true
			break
		}
	}
	if !quoted {
		return path
	}
	var b strings.Builder
	b.Grow(len(path) + 2)
	b.WriteByte('"')
	for i := 0; i < len(path); i++ {
		c := path[i]
		switch {
		case c == '"' || c == '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		case c < ' ' || c >= 0x7f:
			fmt.Fprintf(&b, "\\%03o", c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}
