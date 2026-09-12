// Package yamlindex maps YAML scalar coordinates to immutable original byte ranges.
// Lint validation and semantic presentation keep their independent parsers while
// sharing the lexer's source identity and exact quoted/decorated scalar bounds.
package yamlindex

import (
	"github.com/goccy/go-yaml/lexer"
	"github.com/goccy/go-yaml/token"
)

type coordinate struct{ line, column int }
type scalar struct {
	value      string
	start, end int
}

// Index owns only immutable text and value records, never mutable lexer tokens.
// It is safe for concurrent readers and retains no parser tree or token links.
type Index struct {
	source  string
	scalars map[coordinate]scalar
}

// Scan indexes the original text using the same lexer as source validation.
func Scan(source string) (*Index, error) { return FromTokens(source, lexer.Tokenize(source)) }

// FromTokens snapshots tokens from an existing lexical pass. Call it before
// parsing, because the parser can insert tokens and change linked token state.
func FromTokens(source string, tokens token.Tokens) (*Index, error) {
	spans, err := locateTokens(source, tokens, trimmedOrigins)
	if err != nil {
		return nil, err
	}
	index := &Index{source: source, scalars: make(map[coordinate]scalar, len(tokens))}
	targets := make([]int, len(tokens)+2)
	targets[len(tokens)], targets[len(tokens)+1] = len(tokens), len(tokens)
	for i := len(tokens) - 1; i >= 0; i-- {
		switch tokens[i].Type {
		case token.TagType:
			targets[i] = targets[i+1]
		case token.AnchorType:
			targets[i] = targets[i+2]
		default:
			targets[i] = i
		}
	}
	for i, t := range tokens {
		if t.Position == nil {
			continue
		}
		position := coordinate{t.Position.Line, t.Position.Column}
		if _, exists := index.scalars[position]; exists {
			continue
		}
		entry := scalar{}
		if target := targets[i]; target < len(tokens) {
			location := spans[target]
			entry = scalar{value: tokens[target].Value, start: location.Start, end: location.End}
		}
		index.scalars[position] = entry
	}
	return index, nil
}

// Source returns the complete immutable source, including every YAML document.
func (s *Index) Source() string { return s.source }

// ScalarRange resolves a YAML parser's rune coordinates, excluding tag and
// anchor prefixes but retaining scalar quotes. The value must also match.
func (s *Index) ScalarRange(line, column int, value string) (start, end int, ok bool) {
	entry, ok := s.scalars[coordinate{line, column}]
	return entry.start, entry.end, ok && entry.value == value && entry.end > entry.start
}
