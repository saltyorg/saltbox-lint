package yamlindex

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/goccy/go-yaml/token"
)

// TokenLocation holds original byte offsets. Start and End trim surrounding
// ASCII whitespace; OriginEnd includes it. An empty origin uses rune coordinates
// for Start and End and leaves OriginEnd zero. Quoted bounds retain the quotes.
type TokenLocation struct {
	Start, End int
	OriginEnd  int
}

type originProjection bool

const (
	completeOrigins originProjection = false
	trimmedOrigins  originProjection = true
)

// LocateTokens locates ordered lexer tokens against their complete origins.
// Only whitespace may occur between tokens. Call before parsing, which can
// insert tokens and change linked token state. Returned records own no tokens.
func LocateTokens(source string, tokens token.Tokens) ([]TokenLocation, error) {
	return locateTokens(source, tokens, completeOrigins)
}

// Semantic indexing historically matches trimmed origins, accepting supplied
// tokens even when surrounding whitespace differs. That projection validates
// only Start and End; OriginEnd is unavailable (zero) for non-quoted tokens.
func locateTokens(source string, tokens token.Tokens, projection originProjection) ([]TokenLocation, error) {
	locations := make([]TokenLocation, len(tokens))
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
			locations[i] = TokenLocation{Start: start, End: end, OriginEnd: end}
			cursor = end
			continue
		}
		origin := t.Origin
		if projection == trimmedOrigins {
			origin = strings.Trim(origin, " \t\r\n")
		}
		if origin == "" {
			start := RuneOffset(source, lineStarts, t.Position)
			locations[i] = TokenLocation{Start: start, End: start}
			continue
		}
		gap := strings.Index(source[cursor:], origin)
		if gap < 0 || strings.TrimSpace(source[cursor:cursor+gap]) != "" {
			return nil, fmt.Errorf("cannot locate original YAML token at %v", t.Position)
		}
		start := cursor + gap
		left := len(origin) - len(strings.TrimLeft(origin, " \t\r\n"))
		right := len(strings.TrimRight(origin, " \t\r\n"))
		cursor = start + len(origin)
		locations[i] = TokenLocation{Start: start + left, End: start + max(left, right)}
		if projection == completeOrigins {
			locations[i].OriginEnd = cursor
		}
	}
	return locations, nil
}

// doubleQuotedRange finds boundaries only. The YAML lexer validates and decodes
// escapes. Skipping an escaped byte handles quotes, backslashes and newlines
// without interpreting Unicode escapes or relying on normalized token lengths.
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

// RuneOffset translates a lexer's one-based rune coordinate using byte line
// starts for the same source. It clamps columns at newlines and lines at EOF.
func RuneOffset(source string, lineStarts []int, position *token.Position) int {
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
