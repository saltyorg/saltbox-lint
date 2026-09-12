package format

import (
	"context"
	"fmt"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
)

// Value equivalence alone cannot protect escape spelling, mixed quotes, or
// chomping markers whose effects happen to be equal for this particular value.
func verifyScalarSyntax(ctx context.Context, before, after *lint.Source) error {
	var visit func(*lint.Node, *lint.Node) error
	visit = func(a, b *lint.Node) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if a.Kind != "mapping" && a.Kind != "sequence" {
			old := string(before.Data[a.Span.Start:a.Span.End])
			current := string(after.Data[b.Span.Start:b.Span.End])
			if a.Style == "literal" || a.Style == "folded" {
				if !blockSpellingEqual(blockRaw(before, a), blockRaw(after, b)) {
					return fmt.Errorf("protected block scalar spelling changed")
				}
			} else if current != old && current != canonicalScalar(a, old) {
				return fmt.Errorf("protected scalar spelling changed")
			}
		}
		for i, e := range a.Entries {
			if err := visit(e.Key, b.Entries[i].Key); err != nil {
				return err
			}
			if err := visit(e.Value, b.Entries[i].Value); err != nil {
				return err
			}
		}
		for i, n := range a.Items {
			if err := visit(n, b.Items[i]); err != nil {
				return err
			}
		}
		return nil
	}
	for i, n := range before.Documents {
		if err := visit(n, after.Documents[i]); err != nil {
			return err
		}
	}
	return nil
}

// Structural indentation may shift every nonblank body line by one uniform
// amount. Preserve header bytes, line endings, blank lines, and relative data.
func blockSpellingEqual(before, after string) bool {
	a, b := strings.Split(before, "\n"), strings.Split(after, "\n")
	if len(a) != len(b) || a[0] != b[0] {
		return false
	}
	delta, haveDelta := 0, false
	for i := 1; i < len(a); i++ {
		old, current := strings.TrimLeft(a[i], " "), strings.TrimLeft(b[i], " ")
		if old != current {
			return false
		}
		if old == "" || old == "\r" {
			if a[i] != b[i] {
				return false
			}
			continue
		}
		difference := (len(b[i]) - len(current)) - (len(a[i]) - len(old))
		if haveDelta && difference != delta {
			return false
		}
		delta, haveDelta = difference, true
	}
	return true
}

// Complete lexer origins can include indentation before the next structural
// token. That suffix belongs to the next source line, not the scalar's data.
func blockRaw(source *lint.Source, n *lint.Node) string {
	raw := string(source.Data[n.Span.Start:n.Span.End])
	last := strings.LastIndexByte(raw, '\n')
	if n.Span.End < len(source.Data) && last >= 0 && strings.Trim(raw[last+1:], " ") == "" {
		return raw[:last+1]
	}
	return raw
}
