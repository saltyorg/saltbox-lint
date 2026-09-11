package report

import (
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
	"github.com/saltyorg/saltbox-lint/lint"
)

const (
	defaultHumanWidth = 80
	maximumHumanWidth = 100
)

// ColorProfile describes the terminal color capability already resolved by
// the caller. Its zero value disables color.
type ColorProfile uint8

const (
	ColorNone ColorProfile = iota
	ColorANSI
	ColorANSI256
	ColorTrueColor
)

// HumanOptions contains presentation decisions made by the caller. The zero
// value renders deterministic, uncolored output at 80 columns.
type HumanOptions struct {
	Width        int
	ColorProfile ColorProfile
}

type humanRenderer struct {
	project  *lint.Project
	width    int
	styles   humanStyles
	markdown *glamour.TermRenderer
	lines    map[string][]sourceLine
}

func human(w io.Writer, p *lint.Project, ds []Diagnostic, opts HumanOptions) error {
	if len(ds) == 0 {
		_, err := io.WriteString(w, "No findings.\n")
		return err
	}
	r, err := newHumanRenderer(w, p, opts)
	if err != nil {
		return err
	}
	var b strings.Builder
	for i, d := range ds {
		if i > 0 {
			b.WriteString("\n")
		}
		if err := r.renderDiagnostic(&b, d); err != nil {
			return err
		}
	}
	b.WriteString("\n")
	b.WriteString(r.summary(ds))
	b.WriteByte('\n')
	_, err = io.WriteString(w, b.String())
	return err
}

func newHumanRenderer(w io.Writer, p *lint.Project, opts HumanOptions) (*humanRenderer, error) {
	width := opts.Width
	if width <= 0 {
		width = defaultHumanWidth
	}
	width = min(width, maximumHumanWidth)
	profile := termenvProfile(opts.ColorProfile)
	lip := lipgloss.NewRenderer(w, termenv.WithProfile(profile))
	lip.SetColorProfile(profile)
	lip.SetHasDarkBackground(false)
	markdown, err := glamour.NewTermRenderer(
		glamour.WithStyles(markdownStyles()),
		glamour.WithColorProfile(profile),
		glamour.WithWordWrap(width),
		glamour.WithPreservedNewLines(),
	)
	if err != nil {
		return nil, fmt.Errorf("create human markdown renderer: %w", err)
	}
	return &humanRenderer{project: p, width: width, styles: newHumanStyles(lip), markdown: markdown, lines: make(map[string][]sourceLine)}, nil
}

func termenvProfile(profile ColorProfile) termenv.Profile {
	switch profile {
	case ColorANSI:
		return termenv.ANSI
	case ColorANSI256:
		return termenv.ANSI256
	case ColorTrueColor:
		return termenv.TrueColor
	default:
		return termenv.Ascii
	}
}

func (r *humanRenderer) renderDiagnostic(b *strings.Builder, d Diagnostic) error {
	severity := strings.ToUpper(visibleText(d.Severity))
	header := r.styles.severity(d.Severity).Render(severity) + "  " + r.styles.rule.Render(visibleText(d.RuleID))
	b.WriteString(header)
	b.WriteByte('\n')
	fmt.Fprintf(b, "%s:%d:%d\n", visibleText(d.Path), d.Range.Start.Line, d.Range.Start.Column)
	message, err := r.renderMarkdown(escapeMarkdown(d.Message))
	if err != nil {
		return fmt.Errorf("render diagnostic message: %w", err)
	}
	b.WriteString(message)
	b.WriteString("\n\n")
	r.renderExcerpt(b, d.Location)
	if showExpected(d.Message, d.Expected) {
		expected, err := r.renderMarkdown(escapeMarkdown(d.Expected))
		if err != nil {
			return fmt.Errorf("render diagnostic expected text: %w", err)
		}
		fmt.Fprintf(b, "\n%s %s\n", r.styles.label.Render("Expected:"), expected)
	}
	if actualFix(d.Fix) {
		message := strings.TrimSpace(visibleText(d.Fix.Message))
		if message == "" {
			message = "edits can be applied to the saved file"
		}
		fmt.Fprintf(b, "%s %s\n", r.styles.fix.Render("Fix available:"), message)
	}
	if len(d.Related) > 0 {
		fmt.Fprintf(b, "%s\n", r.styles.label.Render("Related:"))
		for _, related := range d.Related {
			fmt.Fprintf(b, "  %s:%d:%d: %s\n", visibleText(related.Path), related.Range.Start.Line, related.Range.Start.Column, singleLine(visibleText(related.Message)))
			r.renderExcerpt(b, related.Location)
		}
	}
	return nil
}

func showExpected(message, expected string) bool {
	if strings.TrimSpace(expected) == "" {
		return false
	}
	normalize := func(s string) string {
		s = strings.TrimSpace(s)
		s = strings.TrimSuffix(s, ".")
		return strings.TrimSpace(s)
	}
	return normalize(message) != normalize(expected)
}

func actualFix(fix *Fix) bool {
	if fix == nil {
		return false
	}
	return slices.ContainsFunc(fix.Edits, func(edit Edit) bool {
		return edit.Span.Start != edit.Span.End || edit.Text != ""
	})
}

func (r *humanRenderer) summary(ds []Diagnostic) string {
	counts := make(map[string]int)
	paths := make(map[string]struct{})
	fixes := 0
	for _, d := range ds {
		counts[d.Severity]++
		paths[d.Path] = struct{}{}
		if actualFix(d.Fix) {
			fixes++
		}
	}
	severities := make([]string, 0, len(counts))
	for _, severity := range []string{"error", "warning", "notice", "info"} {
		if counts[severity] > 0 {
			severities = append(severities, countLabel(counts[severity], severity, severity+"s"))
			delete(counts, severity)
		}
	}
	extra := make([]string, 0, len(counts))
	for severity := range counts {
		extra = append(extra, severity)
	}
	slices.Sort(extra)
	for _, severity := range extra {
		severities = append(severities, countLabel(counts[severity], visibleText(severity), visibleText(severity)+"s"))
	}
	return fmt.Sprintf("Summary: %s: %s; %s affected; fixes available for %s.",
		countLabel(len(ds), "finding", "findings"), strings.Join(severities, ", "),
		countLabel(len(paths), "file", "files"), countLabel(fixes, "finding", "findings"))
}

func countLabel(count int, singular, plural string) string {
	if count == 1 {
		return fmt.Sprintf("%d %s", count, singular)
	}
	return fmt.Sprintf("%d %s", count, plural)
}
