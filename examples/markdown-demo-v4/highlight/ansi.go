package highlight

import (
	"fmt"
	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"strconv"
	"strings"
)

// ANSI renders already-tokenized tokens, preserving exact RGB and font styles.
// Callers select excerpt lines only after Highlight has processed the full file.
func ANSI(tokens []nuri.ThemedToken) (string, error) {
	var out strings.Builder
	for _, token := range tokens {
		codes := []string{}
		for _, style := range []struct {
			flag theme.FontStyle
			code string
		}{{theme.FontStyleBold, "1"}, {theme.FontStyleItalic, "3"}, {theme.FontStyleUnderline, "4"}, {theme.FontStyleStrikethrough, "9"}} {
			if token.FontStyle > 0 && token.FontStyle.Has(style.flag) {
				codes = append(codes, style.code)
			}
		}
		for _, color := range []struct{ rgb, prefix string }{{token.Color, "38"}, {token.BgColor, "48"}} {
			if color.rgb == "" {
				continue
			}
			rgb := strings.TrimPrefix(color.rgb, "#")
			if len(rgb) != 6 {
				return "", fmt.Errorf("unsupported RGB color %q", color.rgb)
			}
			value, err := strconv.ParseUint(rgb, 16, 24)
			if err != nil {
				return "", fmt.Errorf("RGB color %q: %w", color.rgb, err)
			}
			codes = append(codes, fmt.Sprintf("%s;2;%d;%d;%d", color.prefix, value>>16, (value>>8)&255, value&255))
		}
		if len(codes) > 0 {
			out.WriteString("\x1b[" + strings.Join(codes, ";") + "m")
		}
		out.WriteString(token.Content)
		if len(codes) > 0 {
			out.WriteString("\x1b[0m")
		}
	}
	return out.String(), nil
}
