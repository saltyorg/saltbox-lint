package renderer

import (
	"fmt"
	"strings"

	"github.com/frostybee/nuri/ast"
	"github.com/frostybee/nuri/theme"
)

// BuildTree converts a TokensResult into an HTML element tree, applying
// decorations and transformer hooks.
func BuildTree(result *ast.TokensResult, opts *ast.CodeToHTMLOptions) *ast.Element {
	hasFocus := len(opts.FocusLines) > 0
	multiTheme := len(result.ThemeNames) > 0
	defaultColor := opts.DefaultColor == nil || *opts.DefaultColor

	// Build <pre>.
	preStyles := make(map[string]string)
	var preClasses []string
	if multiTheme {
		preClasses = []string{"nuri", "nuri-themes"}
		for _, k := range result.ThemeNames {
			preClasses = append(preClasses, k)
		}
		if defaultColor {
			preStyles["background-color"] = result.BG
			preStyles["color"] = result.FG
		}
		for _, k := range result.ThemeNames {
			if bg, ok := result.ThemeBG[k]; ok {
				preStyles[fmt.Sprintf("--nuri-%s-bg", k)] = bg
			}
			if fg, ok := result.ThemeFG[k]; ok {
				preStyles[fmt.Sprintf("--nuri-%s", k)] = fg
			}
		}
	} else {
		preClasses = []string{"nuri", result.ThemeName}
		preStyles["background-color"] = result.BG
		preStyles["color"] = result.FG
	}

	pre := &ast.Element{
		Tag:     "pre",
		Classes: preClasses,
		Attrs: map[string]string{
			"tabindex": "0",
		},
	}
	if opts.ClassMap != nil && len(preStyles) > 0 {
		pre.AddClass(opts.ClassMap.Get(preStyles))
	} else {
		pre.Styles = preStyles
	}
	if hasFocus {
		pre.AddClass("has-focused")
	}
	if opts.PreClass != "" {
		pre.AddClass(opts.PreClass)
	}
	for k, v := range opts.PreAttrs {
		pre.SetAttr(k, v)
	}

	// Build <code>.
	codeEl := &ast.Element{Tag: "code"}
	if opts.CodeClass != "" {
		codeEl.AddClass(opts.CodeClass)
	}
	for k, v := range opts.CodeAttrs {
		codeEl.SetAttr(k, v)
	}

	// Build lines.
	for i, tokLine := range result.Tokens {
		if i > 0 {
			codeEl.Children = append(codeEl.Children, &ast.Text{Content: "\n"})
		}
		lineNum := i + 1

		lineEl := &ast.Element{
			Tag:     "span",
			Classes: []string{"line"},
		}

		if ast.InRanges(opts.HighlightLines, lineNum) {
			lineEl.AddClass("highlighted")
		}
		if hasFocus {
			if ast.InRanges(opts.FocusLines, lineNum) {
				lineEl.AddClass("focused")
			} else {
				lineEl.AddClass("dimmed")
			}
		}
		if ast.InRanges(opts.InsertedLines, lineNum) {
			lineEl.AddClass("diff")
			lineEl.AddClass("add")
		}
		if ast.InRanges(opts.DeletedLines, lineNum) {
			lineEl.AddClass("diff")
			lineEl.AddClass("remove")
		}

		byteCol := 0
		for _, tok := range tokLine {
			var styles map[string]string
			if multiTheme {
				styles = TokenStylesMulti(tok, defaultColor)
			} else {
				styles = TokenStyles(tok)
			}
			spanEl := &ast.Element{Tag: "span"}
			if opts.ClassMap != nil && len(styles) > 0 {
				spanEl.AddClass(opts.ClassMap.Get(styles))
			} else {
				spanEl.Styles = styles
			}
			spanEl.Children = append(spanEl.Children, &ast.Text{Content: tok.Content})

			for _, tr := range opts.Transformers {
				if s := tr.Span(spanEl, lineNum, byteCol, lineEl, tok); s != nil {
					spanEl = s
				}
			}

			lineEl.Children = append(lineEl.Children, spanEl)
			byteCol += len(tok.Content)
		}

		for _, tr := range opts.Transformers {
			if l := tr.Line(lineEl, lineNum); l != nil {
				lineEl = l
			}
		}

		codeEl.Children = append(codeEl.Children, lineEl)
	}

	for _, tr := range opts.Transformers {
		if c := tr.Code(codeEl); c != nil {
			codeEl = c
		}
	}

	pre.Children = append(pre.Children, codeEl)

	for _, tr := range opts.Transformers {
		if p := tr.Pre(pre); p != nil {
			pre = p
		}
	}

	for _, tr := range opts.Transformers {
		if r := tr.Root(pre); r != nil {
			pre = r
		}
	}

	return pre
}

// TokenStyles converts a token's style into an inline style map (single-theme).
func TokenStyles(tok ast.ThemedToken) map[string]string {
	styles := make(map[string]string)
	if tok.Color != "" {
		styles["color"] = tok.Color
	}
	if tok.BgColor != "" {
		styles["background-color"] = tok.BgColor
	}
	for k, v := range FontStyleCSS(tok.FontStyle) {
		styles[k] = v
	}
	return styles
}

// TokenStylesMulti converts a token's style into a combined style map (multi-theme).
func TokenStylesMulti(tok ast.ThemedToken, defaultColor bool) map[string]string {
	styles := make(map[string]string)
	if defaultColor {
		if tok.Color != "" {
			styles["color"] = tok.Color
		}
		if tok.BgColor != "" {
			styles["background-color"] = tok.BgColor
		}
		for k, v := range FontStyleCSS(tok.FontStyle) {
			styles[k] = v
		}
	}
	for key, ts := range tok.ThemeStyles {
		if ts.Color != "" {
			styles[fmt.Sprintf("--nuri-%s", key)] = ts.Color
		}
		if ts.BgColor != "" {
			styles[fmt.Sprintf("--nuri-%s-bg", key)] = ts.BgColor
		}
		for prop, val := range FontStyleCSS(ts.FontStyle) {
			styles[fmt.Sprintf("--nuri-%s-%s", key, prop)] = val
		}
	}
	return styles
}

// FontStyleCSS converts a FontStyle bitmask to CSS property map.
func FontStyleCSS(fs theme.FontStyle) map[string]string {
	if fs <= 0 {
		return nil
	}
	m := make(map[string]string)
	if fs.Has(theme.FontStyleItalic) {
		m["font-style"] = "italic"
	}
	if fs.Has(theme.FontStyleBold) {
		m["font-weight"] = "bold"
	}
	var decs []string
	if fs.Has(theme.FontStyleUnderline) {
		decs = append(decs, "underline")
	}
	if fs.Has(theme.FontStyleStrikethrough) {
		decs = append(decs, "line-through")
	}
	if len(decs) > 0 {
		m["text-decoration"] = strings.Join(decs, " ")
	}
	return m
}
