package tokenizer

import (
	"context"
	"fmt"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
)

// matchResult holds the winning match from a pattern search.
type matchResult struct {
	match       *oniguruma.Match
	rule        grammar.Rule
	ruleGrammar *grammar.Grammar
}

// findNextMatch runs the entry's scanner and returns the leftmost match, or
// nil if no pattern matches. Memoized compile/scanner errors surface here,
// in the same loop position where the uncached path produced them.
func findNextMatch(
	ctx context.Context,
	entry *memoEntry,
	line []byte,
	pos int,
	options oniguruma.SearchOptions,
) (*matchResult, error) {
	if entry.err != nil {
		return nil, entry.err
	}
	if len(entry.rules) == 0 {
		return nil, nil
	}

	m, err := entry.scanner.FindNextMatchCtx(ctx, line, pos, options)
	if err != nil {
		return nil, fmt.Errorf("tokenizer: find match: %w", err)
	}
	if m == nil {
		return nil, nil
	}

	return &matchResult{
		match:       m,
		rule:        entry.rules[m.Index].Rule,
		ruleGrammar: entry.rules[m.Index].Grammar,
	}, nil
}
