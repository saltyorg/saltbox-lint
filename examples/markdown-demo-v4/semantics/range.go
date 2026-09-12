package semantics

import (
	"bytes"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/goccy/go-yaml/token"
)

type sourceIndex struct {
	data       []byte
	lineStarts []int
	spans      map[*token.Token]byteRange
	tokens     token.Tokens
}

type byteRange struct {
	start int
	end   int
}

func indexSource(source string, tokens token.Tokens) (*sourceIndex, error) {
	index := &sourceIndex{
		data:       []byte(source),
		lineStarts: []int{0},
		spans:      make(map[*token.Token]byteRange),
		tokens:     tokens,
	}
	for offset, b := range index.data {
		if b == '\n' {
			index.lineStarts = append(index.lineStarts, offset+1)
		}
	}
	if err := index.locateTokens(tokens); err != nil {
		return nil, err
	}
	return index, nil
}

// The lexer reports rune coordinates and normalizes double-quoted escapes.
// Match its ordered token origins against the original bytes to retain exact
// ranges, including quotes. Only whitespace may occur before the next origin.
func (s *sourceIndex) locateTokens(tokens token.Tokens) error {
	cursor := 0
	for _, sourceToken := range tokens {
		if sourceToken.Type == token.DoubleQuoteType {
			span, ok := doubleQuotedRange(s.data, cursor)
			if !ok {
				return fmt.Errorf("cannot locate double-quoted YAML scalar at byte %d", cursor)
			}
			s.spans[sourceToken] = span
			cursor = span.end
			continue
		}
		if sourceToken.Origin == "" {
			continue
		}
		lexeme := []byte(strings.Trim(sourceToken.Origin, " \t\r\n"))
		if len(lexeme) == 0 {
			continue
		}
		gap := bytes.Index(s.data[cursor:], lexeme)
		if gap < 0 || len(bytes.TrimSpace(s.data[cursor:cursor+gap])) != 0 {
			return fmt.Errorf("cannot locate original YAML token at %v", sourceToken.Position)
		}
		start := cursor + gap
		s.spans[sourceToken] = byteRange{start: start, end: start + len(lexeme)}
		cursor = start + len(lexeme)
	}
	return nil
}

func doubleQuotedRange(data []byte, cursor int) (byteRange, bool) {
	start := cursor
	for start < len(data) && strings.ContainsRune(" \t\r\n", rune(data[start])) {
		start++
	}
	if start >= len(data) || data[start] != '"' {
		return byteRange{}, false
	}
	for end := start + 1; end < len(data); end++ {
		switch data[end] {
		case '\\':
			end++
		case '"':
			return byteRange{start: start, end: end + 1}, true
		}
	}
	return byteRange{}, false
}

func (s *sourceIndex) tokenRange(sourceToken *token.Token) byteRange {
	if sourceToken == nil {
		return byteRange{}
	}
	if span, ok := s.spans[sourceToken]; ok {
		return span
	}
	start := s.offset(sourceToken.Position)
	if sourceToken.Type == token.ImplicitNullType {
		return byteRange{start: start, end: start}
	}
	raw := strings.Trim(sourceToken.Origin, " \t\r\n")
	return byteRange{start: start, end: min(start+len(raw), len(s.data))}
}

func (s *sourceIndex) scalarRange(line, column int, value string) (byteRange, bool) {
	index := -1
	for candidateIndex, candidate := range s.tokens {
		if candidate.Position != nil && candidate.Position.Line == line && candidate.Position.Column == column {
			index = candidateIndex
			break
		}
	}
	if index < 0 {
		return byteRange{}, false
	}

	for index < len(s.tokens) {
		switch s.tokens[index].Type {
		case token.TagType:
			index++
		case token.AnchorType:
			// The scalar immediately after '&' names the anchor; the following
			// token starts the anchored value.
			index += 2
		default:
			candidate := s.tokens[index]
			if candidate.Value != value {
				return byteRange{}, false
			}
			span := s.tokenRange(candidate)
			return span, span.end > span.start
		}
	}
	return byteRange{}, false
}

func (s *sourceIndex) offset(position *token.Position) int {
	if position == nil || position.Line < 1 {
		return 0
	}
	if position.Line > len(s.lineStarts) {
		return len(s.data)
	}
	offset := s.lineStarts[position.Line-1]
	for column := 1; column < position.Column && offset < len(s.data) && s.data[offset] != '\n'; column++ {
		_, size := utf8.DecodeRune(s.data[offset:])
		offset += size
	}
	return offset
}
