package compare

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"charm.land/glamour/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/frostybee/nuri"
	v4 "saltbox-lint-markdown-demo-v4/highlight"
)

// Mode selects only how the same report's changes are presented.
type Mode string

const (
	Unified Mode = "unified"
	Guided  Mode = "guided"
)

// Render composes prose with Glamour and code directly from complete-document
// v4 tokens. Patch metadata and presentation padding never enter the tokenizer.
func Render(ctx context.Context, report Report, mode Mode, theme themeChoice, h *v4.Highlighter) (string, error) {
	if mode != Unified && mode != Guided {
		return "", fmt.Errorf("unknown comparison mode %q", mode)
	}
	style, syntaxTheme, gutter, err := presentationStyle(theme)
	if err != nil {
		return "", err
	}
	prose, err := glamour.NewTermRenderer(glamour.WithStyles(style))
	if err != nil {
		return "", fmt.Errorf("create prose renderer: %w", err)
	}
	r := reportRenderer{prose: prose, mode: mode, palette: changeColors(theme), gutter: fmt.Sprintf("#%02X%02X%02X", gutter[0], gutter[1], gutter[2])}
	for _, f := range report.Findings {
		r.width = max(r.width, len(strconv.Itoa(max(f.Current.Lines.Last, f.Suggested.Lines.Last))))
	}
	if err := r.markdown("# " + report.Title + "\n"); err != nil {
		return "", err
	}
	for _, group := range report.FileGroups() {
		if err := r.markdown("## " + group.SourcePath + "\n"); err != nil {
			return "", err
		}
		for _, finding := range group.Findings {
			if err := r.finding(ctx, finding, h, syntaxTheme); err != nil {
				return "", err
			}
		}
	}
	s := report.Summary
	fixNoun := "findings"
	if s.AutomaticFixes == 1 {
		fixNoun = "finding"
	}
	if err := r.markdown(fmt.Sprintf("**%d errors in %d files.** An automatic fix is available for **%d %s**.\n", s.Errors, s.Files, s.AutomaticFixes, fixNoun)); err != nil {
		return "", err
	}
	return r.out.String(), nil
}

type reportRenderer struct {
	out     strings.Builder
	prose   *glamour.TermRenderer
	mode    Mode
	palette changePalette
	gutter  string
	width   int
}

func (r *reportRenderer) markdown(source string) error {
	rendered, err := r.prose.Render(source)
	if err != nil {
		return fmt.Errorf("render prose: %w", err)
	}
	r.out.WriteString(rendered)
	return nil
}

func (r *reportRenderer) finding(ctx context.Context, f Finding, h *v4.Highlighter, theme string) error {
	explanation := f.Explanation
	if r.mode == Guided {
		explanation = guidance(f)
	}
	heading := fmt.Sprintf("### Error %d of %d · %s\n\n**Location:** `%s:%d:%d`\n\n%s\n", f.Ordinal, f.Total, f.Rule, f.Location.Path, f.Location.Line, f.Location.Column, explanation)
	if err := r.markdown(heading); err != nil {
		return err
	}
	// Classification sees both entire sources before either excerpt is selected.
	before, err := f.Current.Document.Highlight(ctx, h, theme)
	if err != nil {
		return fmt.Errorf("current source: %w", err)
	}
	after, err := f.Suggested.Document.Highlight(ctx, h, theme)
	if err != nil {
		return fmt.Errorf("suggested source: %w", err)
	}
	for _, side := range []struct {
		excerpt Excerpt
		tokens  *nuri.TokensResult
	}{{f.Current, before.Combined}, {f.Suggested, after.Combined}} {
		if side.excerpt.Lines.First < 1 || side.excerpt.Lines.Last < side.excerpt.Lines.First || side.excerpt.Lines.Last > len(side.tokens.Tokens) {
			return fmt.Errorf("invalid excerpt range %d-%d", side.excerpt.Lines.First, side.excerpt.Lines.Last)
		}
	}
	if r.mode == Unified {
		if err := r.unified(f, before.Combined, after.Combined); err != nil {
			return err
		}
	} else {
		if err := r.guided(f, before.Combined, after.Combined); err != nil {
			return err
		}
	}
	return r.markdown("\n**Fix:** " + f.Fix.Description + "\n\n---\n")
}

func guidance(f Finding) string {
	switch f.Rule {
	case "ansible-when-list":
		return "Put each condition on its own line."
	case "ansible-tag-name":
		return "Change restart_web to restart-web."
	case "section-spacing":
		return "Add a blank line above web_role_enabled."
	default:
		return f.Explanation
	}
}

func inRange(line int, lines LineRange) bool { return line >= lines.First && line <= lines.Last }

func (r *reportRenderer) unified(f Finding, before, after *nuri.TokensResult) error {
	fmt.Fprintf(&r.out, "  --- current/%s\n  +++ suggested/%s\n  @@ -%d,%d +%d,%d @@\n", f.Current.Document.SourcePath, f.Suggested.Document.SourcePath, f.Current.Lines.First, f.Current.Lines.Last-f.Current.Lines.First+1, f.Suggested.Lines.First, f.Suggested.Lines.Last-f.Suggested.Lines.First+1)
	for _, row := range f.Diff {
		if !inRange(row.BeforeLine, f.Current.Lines) && !inRange(row.AfterLine, f.Suggested.Lines) {
			continue
		}
		marker, background := " ", ""
		var tokens []nuri.ThemedToken
		switch row.Kind {
		case Removal:
			marker, background, tokens = "-", r.palette.removed, before.Tokens[row.BeforeLine-1]
		case Addition:
			marker, background, tokens = "+", r.palette.added, after.Tokens[row.AfterLine-1]
		case Context:
			tokens = before.Tokens[row.BeforeLine-1]
		}
		prefix := fmt.Sprintf("%*s %*s │ %s ", r.width, lineNumber(row.BeforeLine), r.width, lineNumber(row.AfterLine), marker)
		if err := r.codeLine(prefix, tokens, Emphasis{WholeLine: background != ""}, background); err != nil {
			return err
		}
	}
	return nil
}

func lineNumber(line int) string {
	if line == 0 {
		return ""
	}
	return strconv.Itoa(line)
}

func (r *reportRenderer) guided(f Finding, before, after *nuri.TokensResult) error {
	for _, side := range []struct {
		label     string
		excerpt   Excerpt
		tokens    *nuri.TokensResult
		suggested bool
	}{{"Current", f.Current, before, false}, {"Suggested", f.Suggested, after, true}} {
		if err := r.markdown("#### " + side.label + "\n"); err != nil {
			return err
		}
		for line := side.excerpt.Lines.First; line <= side.excerpt.Lines.Last; line++ {
			var emphasis Emphasis
			for _, row := range f.Diff {
				if side.suggested && row.Kind == Addition && row.AfterLine == line || !side.suggested && row.Kind == Removal && row.BeforeLine == line {
					emphasis = row.Emphasis
					break
				}
			}
			if err := r.codeLine(fmt.Sprintf("%*d │ ", r.width, line), side.tokens.Tokens[line-1], emphasis, r.palette.guided); err != nil {
				return err
			}
		}
	}
	for _, row := range f.Diff {
		if row.Kind == Addition && row.BlankLine && inRange(row.AfterLine, f.Suggested.Lines) {
			if err := r.markdown(fmt.Sprintf("\nSuggested line %d is the new blank line.\n", row.AfterLine)); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *reportRenderer) codeLine(prefix string, tokens []nuri.ThemedToken, emphasis Emphasis, background string) error {
	gutter, err := v4.ANSI([]nuri.ThemedToken{{Content: "  " + prefix, Color: r.gutter}})
	if err != nil {
		return err
	}
	line, err := v4.ANSI(decorate(tokens, emphasis, background))
	if err != nil {
		return err
	}
	r.out.WriteString(gutter)
	r.out.WriteString(line)
	// A separately styled padding segment makes blank/full-line bands visible;
	// it is never part of the source token slice or its byte offsets.
	if emphasis.WholeLine {
		padding, err := v4.ANSI([]nuri.ThemedToken{{Content: strings.Repeat(" ", max(1, 64-ansi.StringWidth(line))), BgColor: background}})
		if err != nil {
			return err
		}
		r.out.WriteString(padding)
	}
	r.out.WriteByte('\n')
	return nil
}
