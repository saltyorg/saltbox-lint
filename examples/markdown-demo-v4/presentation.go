package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"charm.land/glamour/v2"
	"charm.land/glamour/v2/ansi"
	"charm.land/glamour/v2/styles"
	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/frostybee/nuri"

	runtimehighlight "saltbox-lint-markdown-demo-v4/highlight"
)

type themeChoice string

const (
	darkTheme  themeChoice = "dark"
	lightTheme themeChoice = "light"
)

type codeBlock struct {
	Source              string
	SourcePath          string
	Collections         []string
	FirstLine, LastLine int
}

type sourceHighlighter interface {
	Highlight(context.Context, string, string, runtimehighlight.DocumentOptions) (*nuri.TokensResult, error)
}

type runtimeHighlighter struct{ *runtimehighlight.Highlighter }

func newRuntimeHighlighter(ctx context.Context) (*runtimeHighlighter, error) {
	h, err := runtimehighlight.New(ctx)
	if err != nil {
		return nil, err
	}
	return &runtimeHighlighter{h}, nil
}
func (h *runtimeHighlighter) Highlight(ctx context.Context, source, theme string, options runtimehighlight.DocumentOptions) (*nuri.TokensResult, error) {
	result, err := h.HighlightDocument(ctx, source, theme, options)
	if err != nil {
		return nil, err
	}
	return result.Combined, nil
}

var (
	registerLexer sync.Once
	formatterID   atomic.Uint64
)

func renderMarkdown(ctx context.Context, markdown string, highlighter sourceHighlighter, blocks []codeBlock, theme themeChoice) (string, error) {
	style, themeName, gutter, err := presentationStyle(theme)
	if err != nil {
		return "", err
	}
	width, err := displayedGutterWidth(blocks)
	if err != nil {
		return "", err
	}

	registerLexer.Do(func() {
		lexers.Register(chroma.MustNewLexer(&chroma.Config{
			Name:    "Saltbox Ansible passthrough",
			Aliases: []string{"saltbox-ansible"},
		}, lexers.PlaintextRules))
	})
	formatterName := fmt.Sprintf("saltbox-runtime-%d", formatterID.Add(1))
	formatter := &runtimeFormatter{
		ctx:         ctx,
		highlighter: highlighter,
		blocks:      blocks,
		themeName:   themeName,
		gutter:      gutter,
		gutterWidth: width,
	}
	formatters.Register(formatterName, formatter)

	renderer, err := glamour.NewTermRenderer(
		glamour.WithStyles(style),
		glamour.WithChromaFormatter(formatterName),
	)
	if err != nil {
		return "", fmt.Errorf("create Markdown renderer: %w", err)
	}
	rendered, err := renderer.Render(markdown)
	if err != nil {
		return "", fmt.Errorf("render Markdown: %w", err)
	}
	if formatter.next != len(blocks) {
		return "", fmt.Errorf("rendered %d code blocks, want %d", formatter.next, len(blocks))
	}
	return rendered, nil
}

type runtimeFormatter struct {
	ctx         context.Context
	highlighter sourceHighlighter
	blocks      []codeBlock
	themeName   string
	gutter      [3]uint8
	gutterWidth int
	next        int
}

func (f *runtimeFormatter) Format(w io.Writer, _ *chroma.Style, iterator chroma.Iterator) error {
	if f.next >= len(f.blocks) {
		return fmt.Errorf("Markdown contains more code blocks than source metadata")
	}
	block := f.blocks[f.next]
	f.next++

	var displayed strings.Builder
	for token := iterator(); token != chroma.EOF; token = iterator() {
		displayed.WriteString(token.Value)
	}
	want, err := sourceLines(block.Source, block.FirstLine, block.LastLine)
	if err != nil {
		return err
	}
	if displayed.String() != want {
		return fmt.Errorf("code block %d does not match source lines %d-%d", f.next, block.FirstLine, block.LastLine)
	}

	result, err := f.highlighter.Highlight(f.ctx, block.Source, f.themeName, runtimehighlight.DocumentOptions{SourcePath: block.SourcePath, Collections: block.Collections})
	if err != nil {
		return fmt.Errorf("highlight code block %d: %w", f.next, err)
	}
	if block.LastLine > len(result.Tokens) {
		return fmt.Errorf("code block %d ends at line %d, but highlighter returned %d lines", f.next, block.LastLine, len(result.Tokens))
	}
	for lineNumber := block.FirstLine; lineNumber <= block.LastLine; lineNumber++ {
		if _, err := fmt.Fprintf(w, "\x1b[38;2;%d;%d;%dm%*d │\x1b[0m ",
			f.gutter[0], f.gutter[1], f.gutter[2], f.gutterWidth, lineNumber); err != nil {
			return err
		}
		line, err := runtimehighlight.ANSI(result.Tokens[lineNumber-1])
		if err != nil {
			return fmt.Errorf("format code block %d line %d: %w", f.next, lineNumber, err)
		}
		if _, err := io.WriteString(w, line+"\n"); err != nil {
			return err
		}
	}
	return nil
}

func sourceLines(source string, first, last int) (string, error) {
	if first < 1 || last < first {
		return "", fmt.Errorf("invalid displayed source range %d-%d", first, last)
	}
	lines := strings.SplitAfter(source, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if last > len(lines) {
		return "", fmt.Errorf("source range %d-%d exceeds %d lines", first, last, len(lines))
	}
	return strings.Join(lines[first-1:last], ""), nil
}

func displayedGutterWidth(blocks []codeBlock) (int, error) {
	if len(blocks) == 0 {
		return 0, fmt.Errorf("no source metadata for Markdown code blocks")
	}
	last := 0
	for _, block := range blocks {
		if block.FirstLine < 1 || block.LastLine < block.FirstLine {
			return 0, fmt.Errorf("invalid displayed source range %d-%d", block.FirstLine, block.LastLine)
		}
		last = max(last, block.LastLine)
	}
	return len(strconv.Itoa(last)), nil
}

func presentationStyle(theme themeChoice) (styleConfig ansi.StyleConfig, themeName string, gutter [3]uint8, err error) {
	foreground, heading, failure := "#ABB2BF", "#61AFEF", "#E06C75"
	styleConfig = styles.DarkStyleConfig
	switch theme {
	case darkTheme:
		gutter = [3]uint8{99, 109, 131}
	case lightTheme:
		foreground, heading, failure = "#383A42", "#4078F2", "#E45649"
		styleConfig = styles.LightStyleConfig
		themeName = "one-light"
		gutter = [3]uint8{105, 108, 119}
	default:
		return ansi.StyleConfig{}, "", [3]uint8{}, fmt.Errorf("unsupported presentation theme %q", theme)
	}
	if themeName == "" {
		themeName = "one-dark-pro"
	}
	styleConfig.Document.Color = &foreground
	styleConfig.Heading.Color = &heading
	styleConfig.H2.Prefix = ""
	styleConfig.H3.Prefix = ""
	styleConfig.H3.Color = &failure
	styleConfig.H4.Prefix = ""
	styleConfig.H4.Color = &foreground
	styleConfig.HorizontalRule.Color = stringPointer(fmt.Sprintf("#%02X%02X%02X", gutter[0], gutter[1], gutter[2]))
	styleConfig.HorizontalRule.Format = "\n" + strings.Repeat("─", 72) + "\n"
	return styleConfig, themeName, gutter, nil
}

func stringPointer(value string) *string { return &value }
