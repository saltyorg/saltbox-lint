// Package yamlindex maps YAML scalar coordinates to immutable original byte ranges.
// Lint validation and semantic presentation keep their independent parsers while
// sharing the lexer's source identity and exact quoted/decorated scalar bounds.
package yamlindex

import (
	"fmt"
	"strings"
	"unicode/utf8"

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
	spans, err := locate(source, tokens)
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
			entry = spans[target]
			entry.value = tokens[target].Value
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

func locate(source string, tokens token.Tokens) ([]scalar, error) {
	spans := make([]scalar, len(tokens))
	lineStarts := []int{0}
	for offset, b := range source {
		if b == '\n' {
			lineStarts = append(lineStarts, offset+1)
		}
	}
	cursor := 0
	for i, t := range tokens {
		if t.Type == token.DoubleQuoteType {
			start, end, ok := doubleQuotedRange(source, cursor)
			if !ok {
				return nil, fmt.Errorf("cannot locate double-quoted YAML scalar at byte %d", cursor)
			}
			spans[i] = scalar{start: start, end: end}
			cursor = end
			continue
		}
		lexeme := strings.Trim(t.Origin, " \t\r\n")
		if lexeme != "" {
			gap := strings.Index(source[cursor:], lexeme)
			if gap < 0 || strings.TrimSpace(source[cursor:cursor+gap]) != "" {
				return nil, fmt.Errorf("cannot locate original YAML token at %v", t.Position)
			}
			start := cursor + gap
			cursor = start + len(lexeme)
			spans[i] = scalar{start: start, end: cursor}
			continue
		}
		start := offset(source, lineStarts, t.Position)
		spans[i] = scalar{start: start, end: start}
	}
	return spans, nil
}

func doubleQuotedRange(source string, cursor int) (int, int, bool) {
	start := cursor
	for start < len(source) && strings.ContainsRune(" \t\r\n", rune(source[start])) {
		start++
	}
	if start >= len(source) || source[start] != '"' {
		return 0, 0, false
	}
	for end := start + 1; end < len(source); end++ {
		switch source[end] {
		case '\\':
			end++
		case '"':
			return start, end + 1, true
		}
	}
	return 0, 0, false
}

func offset(source string, lineStarts []int, position *token.Position) int {
	if position == nil || position.Line < 1 {
		return 0
	}
	if position.Line > len(lineStarts) {
		return len(source)
	}
	start := lineStarts[position.Line-1]
	for col := 1; col < position.Column && start < len(source) && source[start] != '\n'; col++ {
		_, size := utf8.DecodeRuneInString(source[start:])
		start += size
	}
	return start
}
