package ansi

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/frostybee/nuri/theme"
)

// Standard 16 ANSI colors (0-7 normal, 8-15 bright).
var ansi16 = [16]string{
	"#000000", "#cd3131", "#0dbc79", "#e5e510",
	"#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
	"#666666", "#f14c4c", "#23d18b", "#f5f543",
	"#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
}

// Style holds the visual attributes parsed from ANSI SGR codes.
type Style struct {
	FG        string
	BG        string
	FontStyle theme.FontStyle
}

// Token is a styled span of text with ANSI escapes stripped.
type Token struct {
	Content string
	Style   Style
}

// Tokenize parses ANSI escape sequences from code and returns per-line
// token lists. Escape sequences are stripped from Content; their effects
// are reflected in Style. State carries across line boundaries.
func Tokenize(code string) [][]Token {
	var (
		lines   [][]Token
		current []Token
		buf     strings.Builder
		style   Style
	)

	flush := func() {
		if buf.Len() > 0 {
			current = append(current, Token{Content: buf.String(), Style: style})
			buf.Reset()
		}
	}

	i := 0
	for i < len(code) {
		if code[i] == '\n' {
			flush()
			lines = append(lines, current)
			current = nil
			i++
			continue
		}

		if code[i] == '\x1b' && i+1 < len(code) && code[i+1] == '[' {
			flush()
			end := strings.IndexByte(code[i+2:], 'm')
			if end < 0 {
				i++
				continue
			}
			params := code[i+2 : i+2+end]
			style = applySGR(params, style)
			i = i + 2 + end + 1
			continue
		}

		buf.WriteByte(code[i])
		i++
	}

	flush()
	if len(current) > 0 || len(lines) > 0 {
		lines = append(lines, current)
	}

	return lines
}

func applySGR(params string, s Style) Style {
	if params == "" {
		return Style{}
	}
	codes := strings.Split(params, ";")
	for i := 0; i < len(codes); i++ {
		n, err := strconv.Atoi(codes[i])
		if err != nil {
			continue
		}
		switch {
		case n == 0:
			s = Style{}
		case n == 1:
			s.FontStyle |= theme.FontStyleBold
		case n == 3:
			s.FontStyle |= theme.FontStyleItalic
		case n == 4:
			s.FontStyle |= theme.FontStyleUnderline
		case n == 9:
			s.FontStyle |= theme.FontStyleStrikethrough
		case n == 22:
			s.FontStyle &^= theme.FontStyleBold
		case n == 23:
			s.FontStyle &^= theme.FontStyleItalic
		case n == 24:
			s.FontStyle &^= theme.FontStyleUnderline
		case n == 29:
			s.FontStyle &^= theme.FontStyleStrikethrough
		case n >= 30 && n <= 37:
			s.FG = ansi16[n-30]
		case n == 39:
			s.FG = ""
		case n >= 40 && n <= 47:
			s.BG = ansi16[n-40]
		case n == 49:
			s.BG = ""
		case n >= 90 && n <= 97:
			s.FG = ansi16[n-90+8]
		case n >= 100 && n <= 107:
			s.BG = ansi16[n-100+8]
		case (n == 38 || n == 48) && i+1 < len(codes):
			mode, _ := strconv.Atoi(codes[i+1])
			if mode == 5 && i+2 < len(codes) {
				idx, _ := strconv.Atoi(codes[i+2])
				color := color256(idx)
				if n == 38 {
					s.FG = color
				} else {
					s.BG = color
				}
				i += 2
			} else if mode == 2 && i+4 < len(codes) {
				r, _ := strconv.Atoi(codes[i+2])
				g, _ := strconv.Atoi(codes[i+3])
				b, _ := strconv.Atoi(codes[i+4])
				color := fmt.Sprintf("#%02x%02x%02x", clamp(r), clamp(g), clamp(b))
				if n == 38 {
					s.FG = color
				} else {
					s.BG = color
				}
				i += 4
			}
		}
	}
	return s
}

func color256(idx int) string {
	if idx < 0 || idx > 255 {
		return ""
	}
	if idx < 16 {
		return ansi16[idx]
	}
	if idx < 232 {
		idx -= 16
		r := (idx / 36) * 51
		g := ((idx % 36) / 6) * 51
		b := (idx % 6) * 51
		return fmt.Sprintf("#%02x%02x%02x", r, g, b)
	}
	v := (idx-232)*10 + 8
	return fmt.Sprintf("#%02x%02x%02x", v, v, v)
}

func clamp(v int) int {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return v
}
