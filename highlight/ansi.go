package highlight

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
)

// ANSI renders already-tokenized tokens, preserving exact RGB and font styles.
// Callers select and safely shape visual rows before rendering. Adjacent equal
// styles share instructions, and each call ends with its active style reset.
func ANSI(tokens []nuri.ThemedToken) (string, error) {
	var out strings.Builder
	var active ansiStyle
	// Raw controls can alter terminal state or contain incomplete sequences. Keep
	// every original token boundary for such public inputs, without interpreting it.
	controls := false
	for _, token := range tokens {
		if !utf8.ValidString(token.Content) || strings.IndexFunc(token.Content, unicode.IsControl) >= 0 {
			controls = true
			break
		}
	}
	// The caller's ambient colors/fonts are unknown until our first styled token
	// resets them. That first boundary must survive even when adjacent styles match.
	reset := false
	for _, token := range tokens {
		style, err := tokenANSIStyle(token)
		if err != nil {
			return "", err
		}
		if style != active {
			if active != (ansiStyle{}) {
				out.WriteString("\x1b[0m")
			}
			style.writeStart(&out)
			active = style
		}
		out.WriteString(token.Content)
		if active != (ansiStyle{}) && (!reset || controls) {
			out.WriteString("\x1b[0m")
			active = ansiStyle{}
			reset = true
		}
	}
	if active != (ansiStyle{}) {
		out.WriteString("\x1b[0m")
	}
	return out.String(), nil
}

// RGB plus one keeps explicit black distinct from an unset terminal color.
// Unsupported and negative font flags do not emit instructions.
type ansiStyle struct {
	foreground, background uint32
	font                   theme.FontStyle
}

func tokenANSIStyle(token nuri.ThemedToken) (ansiStyle, error) {
	var style ansiStyle
	if token.FontStyle > 0 {
		style.font = token.FontStyle & (theme.FontStyleBold | theme.FontStyleItalic | theme.FontStyleUnderline | theme.FontStyleStrikethrough)
	}
	var err error
	style.foreground, err = ansiRGB(token.Color)
	if err != nil {
		return ansiStyle{}, err
	}
	style.background, err = ansiRGB(token.BgColor)
	return style, err
}

func ansiRGB(color string) (uint32, error) {
	if color == "" {
		return 0, nil
	}
	rgb := strings.TrimPrefix(color, "#")
	if len(rgb) != 6 {
		return 0, fmt.Errorf("unsupported RGB color %q", color)
	}
	value, err := strconv.ParseUint(rgb, 16, 24)
	if err != nil {
		return 0, fmt.Errorf("RGB color %q: %w", color, err)
	}
	return uint32(value) + 1, nil
}

func (style ansiStyle) writeStart(out *strings.Builder) {
	codes := make([]string, 0, 6)
	for _, font := range []struct {
		flag theme.FontStyle
		code string
	}{
		{theme.FontStyleBold, "1"}, {theme.FontStyleItalic, "3"}, {theme.FontStyleUnderline, "4"}, {theme.FontStyleStrikethrough, "9"},
	} {
		if style.font.Has(font.flag) {
			codes = append(codes, font.code)
		}
	}
	for _, color := range []struct {
		value  uint32
		prefix string
	}{{style.foreground, "38"}, {style.background, "48"}} {
		if color.value == 0 {
			continue
		}
		rgb := color.value - 1
		codes = append(codes, fmt.Sprintf("%s;2;%d;%d;%d", color.prefix, rgb>>16, (rgb>>8)&255, rgb&255))
	}
	if len(codes) > 0 {
		out.WriteString("\x1b[")
		out.WriteString(strings.Join(codes, ";"))
		out.WriteByte('m')
	}
}
