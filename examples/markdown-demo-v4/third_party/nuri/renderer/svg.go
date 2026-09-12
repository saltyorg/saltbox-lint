package renderer

import (
	"fmt"
	"io"
	"strings"

	"github.com/frostybee/nuri/ast"
	"github.com/frostybee/nuri/theme"
)

const (
	svgDefaultFontFamily = "Consolas, Monaco, Lucida Console, Liberation Mono, DejaVu Sans Mono, monospace"
	svgDefaultFontSize   = 14.0
	svgDefaultLineHeight = 1.2
	svgDefaultPadX       = 16.0
	svgDefaultPadY       = 16.0
	svgDefaultTabWidth   = 4
	svgDefaultCorner     = 8.0
	svgCharWidthRatio    = 0.6
)

var svgEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	"\"", "&quot;",
	" ", "&#160;",
)

// RenderSVG writes highlighted code as a self-contained SVG document to w.
func RenderSVG(w io.Writer, result *ast.TokensResult, opts *ast.CodeToSVGOptions) error {
	o := svgDefaults(opts)

	charWidth := o.FontSize * svgCharWidthRatio
	lineHeightPx := o.FontSize * o.LineHeight
	maxCols := svgMaxCols(result.Tokens, o.TabWidth)

	width := o.PadX*2 + float64(maxCols)*charWidth
	height := o.PadY*2 + float64(len(result.Tokens))*lineHeightPx

	ws := func(s string) error {
		_, err := io.WriteString(w, s)
		return err
	}
	wf := func(format string, args ...any) error {
		_, err := fmt.Fprintf(w, format, args...)
		return err
	}

	if err := wf(`<svg xmlns="http://www.w3.org/2000/svg" width="%.0fpx" height="%.0fpx" viewBox="0 0 %.0f %.0f" font-family="%s" font-size="%.0fpx">`,
		width, height, width, height, svgEscapeAttr(o.FontFamily), o.FontSize); err != nil {
		return err
	}

	showBg := o.ShowBackground == nil || *o.ShowBackground
	if showBg && result.BG != "" {
		if err := wf(`<rect width="100%%" height="100%%" fill="%s" rx="%.0f"/>`,
			svgEscapeAttr(result.BG), o.CornerRadius); err != nil {
			return err
		}
	}

	fg := result.FG
	if fg == "" {
		fg = "#000000"
	}
	if err := wf(`<g fill="%s">`, svgEscapeAttr(fg)); err != nil {
		return err
	}

	tabSpaces := strings.Repeat("&#160;", o.TabWidth)

	for i, line := range result.Tokens {
		y := o.PadY + o.FontSize + float64(i)*lineHeightPx
		if err := wf(`<text x="%.0f" y="%.1f" xml:space="preserve">`, o.PadX, y); err != nil {
			return err
		}
		for _, tok := range line {
			content := svgEscaper.Replace(tok.Content)
			content = strings.ReplaceAll(content, "\t", tabSpaces)

			attrs := svgTokenAttrs(tok, fg)
			if attrs != "" {
				if err := wf("<tspan %s>%s</tspan>", attrs, content); err != nil {
					return err
				}
			} else {
				if err := ws(content); err != nil {
					return err
				}
			}
		}
		if err := ws("</text>"); err != nil {
			return err
		}
	}

	if err := ws("</g></svg>"); err != nil {
		return err
	}
	return nil
}

func svgTokenAttrs(tok ast.ThemedToken, defaultFG string) string {
	var parts []string

	if tok.Color != "" && tok.Color != defaultFG {
		parts = append(parts, fmt.Sprintf(`fill="%s"`, svgEscapeAttr(tok.Color)))
	}

	fs := tok.FontStyle
	if fs > 0 {
		if fs.Has(theme.FontStyleBold) {
			parts = append(parts, `font-weight="bold"`)
		}
		if fs.Has(theme.FontStyleItalic) {
			parts = append(parts, `font-style="italic"`)
		}
		var deco []string
		if fs.Has(theme.FontStyleUnderline) {
			deco = append(deco, "underline")
		}
		if fs.Has(theme.FontStyleStrikethrough) {
			deco = append(deco, "line-through")
		}
		if len(deco) > 0 {
			parts = append(parts, fmt.Sprintf(`text-decoration="%s"`, strings.Join(deco, " ")))
		}
	}

	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, " ")
}

func svgMaxCols(lines [][]ast.ThemedToken, tabWidth int) int {
	max := 0
	for _, line := range lines {
		cols := 0
		for _, tok := range line {
			for _, r := range tok.Content {
				if r == '\t' {
					cols += tabWidth
				} else {
					cols++
				}
			}
		}
		if cols > max {
			max = cols
		}
	}
	return max
}

func svgDefaults(opts *ast.CodeToSVGOptions) ast.CodeToSVGOptions {
	o := *opts
	if o.FontFamily == "" {
		o.FontFamily = svgDefaultFontFamily
	}
	if o.FontSize == 0 {
		o.FontSize = svgDefaultFontSize
	}
	if o.LineHeight == 0 {
		o.LineHeight = svgDefaultLineHeight
	}
	if o.PadX == 0 {
		o.PadX = svgDefaultPadX
	}
	if o.PadY == 0 {
		o.PadY = svgDefaultPadY
	}
	if o.TabWidth == 0 {
		o.TabWidth = svgDefaultTabWidth
	}
	if o.CornerRadius == 0 {
		o.CornerRadius = svgDefaultCorner
	}
	return o
}

func svgEscapeAttr(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}
