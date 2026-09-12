package renderer

import (
	"io"
	"strings"

	"github.com/frostybee/nuri/ast"
	"github.com/frostybee/nuri/theme"
)

const ansiReset = "\033[0m"

// RenderANSI writes ANSI-escaped highlighted code to w.
func RenderANSI(w io.Writer, result *ast.TokensResult, opts *ast.CodeToANSIOptions) error {
	aw := ansiWriter{
		w:         w,
		pal:       newPalette(opts.ColorDepth),
		defaultFG: result.FG,
	}
	return aw.render(result.Tokens)
}

type ansiWriter struct {
	w         io.Writer
	pal       *palette
	defaultFG string
}

func (aw *ansiWriter) render(lines [][]ast.ThemedToken) error {
	for i, tokLine := range lines {
		if i > 0 {
			if _, err := io.WriteString(aw.w, "\n"); err != nil {
				return err
			}
		}
		for _, tok := range tokLine {
			if err := aw.writeToken(tok); err != nil {
				return err
			}
		}
	}
	return nil
}

func (aw *ansiWriter) writeToken(tok ast.ThemedToken) error {
	esc := aw.buildEscape(tok.Color, tok.FontStyle)
	if esc == "" {
		_, err := io.WriteString(aw.w, tok.Content)
		return err
	}

	parts := strings.Split(tok.Content, "\n")
	for i, part := range parts {
		if i > 0 {
			if _, err := io.WriteString(aw.w, ansiReset+"\n"); err != nil {
				return err
			}
		}
		if part == "" && i < len(parts)-1 {
			continue
		}
		if part != "" || i == len(parts)-1 {
			if _, err := io.WriteString(aw.w, "\033["+esc+"m"+part+ansiReset); err != nil {
				return err
			}
		}
	}
	return nil
}

// buildEscape builds a combined SGR parameter string from color and font style.
// Returns empty string if there's nothing to emit.
func (aw *ansiWriter) buildEscape(color string, fs theme.FontStyle) string {
	if color == "" {
		color = aw.defaultFG
	}

	var parts []string

	if fs > 0 {
		if fs.Has(theme.FontStyleBold) {
			parts = append(parts, "1")
		}
		if fs.Has(theme.FontStyleItalic) {
			parts = append(parts, "3")
		}
		if fs.Has(theme.FontStyleUnderline) {
			parts = append(parts, "4")
		}
		if fs.Has(theme.FontStyleStrikethrough) {
			parts = append(parts, "9")
		}
	}

	if fg := aw.pal.resolveFG(color); fg != "" {
		parts = append(parts, fg)
	}

	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, ";")
}
