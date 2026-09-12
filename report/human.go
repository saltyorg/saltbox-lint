package report

import (
	"context"
	"fmt"
	"io"
	"slices"
	"strings"

	"charm.land/glamour/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/saltyorg/saltbox-lint/lint"
)

const (
	defaultHumanWidth = 80
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

// Theme is a resolved terminal background choice. Its zero value is dark.
type Theme uint8

const (
	ThemeDark Theme = iota
	ThemeLight
)

// HumanOptions contains presentation decisions made by the caller. The zero
// value renders deterministic, uncolored output at 80 columns.
type HumanOptions struct {
	Width        int
	ColorProfile ColorProfile
	Theme        Theme
	// Context governs rendering work. Nil uses context.Background.
	Context context.Context
}

type humanRenderer struct {
	project                   *lint.Project
	width                     int
	styles                    humanStyles
	markdown                  *glamour.TermRenderer
	output                    io.Writer
	lines                     map[string][]sourceLine
	ctx                       context.Context
	color                     bool
	themeName, removed, added string
	highlights                *highlightSession
	tokens                    map[documentKey]cachedDocumentTokens
	prepared                  cachedDisplayDocument
	proposals                 map[[32]byte]string
}

func human(w io.Writer, p *lint.Project, ds []Diagnostic, opts HumanOptions) error {
	return humanWithWorkerLimit(w, p, ds, opts, defaultHumanWorkerLimit())
}

func humanWithWorkerLimit(w io.Writer, p *lint.Project, ds []Diagnostic, opts HumanOptions, workerLimit int) error {
	if opts.Context != nil {
		if err := opts.Context.Err(); err != nil {
			return err
		}
	}
	if len(ds) == 0 {
		_, err := io.WriteString(w, "No findings.\n")
		return err
	}
	ctx := opts.Context
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	opts.Context = ctx
	groups, parallel := contiguousDiagnosticGroups(ds)
	workers := 1
	if parallel {
		workers = min(max(1, workerLimit), len(groups))
	}
	session := newHighlightSession(ctx, workers)
	r, err := newHumanRendererWithSession(w, p, opts, session)
	if err != nil {
		return err
	}
	defer r.close()
	if err := r.ctx.Err(); err != nil {
		return err
	}
	title, err := r.renderMarkdown("# Saltbox Lint\n")
	if err != nil {
		return err
	}
	if err := r.write(title + "\n\n"); err != nil {
		return err
	}
	if workers == 1 {
		err = r.renderSequentialFindings(ds)
	} else {
		err = r.renderParallelFiles(groups, opts, workers, cancel)
	}
	if err != nil {
		return err
	}
	if err := r.ctx.Err(); err != nil {
		return err
	}
	return r.write("\n" + r.summary(ds) + "\n")
}

func (r *humanRenderer) renderSequentialFindings(ds []Diagnostic) error {
	previousPath := ""
	for i, d := range ds {
		if err := r.renderFindingSection(d, i, i == 0 || d.Path != previousPath, r.write); err != nil {
			return err
		}
		previousPath = d.Path
	}
	return nil
}

func (r *humanRenderer) renderFindingSection(d Diagnostic, index int, heading bool, emit func(string) error) error {
	b := &fragmentWriter{ctx: r.ctx, emit: emit}
	if heading {
		if index > 0 {
			_, _ = b.WriteString("\n\n")
		}
		_, _ = b.WriteString(strings.Repeat("━", r.width) + "\n")
		rendered, err := r.renderMarkdown("## " + escapeMarkdown(d.Path) + "\n")
		if err != nil {
			return err
		}
		_, _ = b.WriteString(rendered + "\n" + strings.Repeat("━", r.width) + "\n\n")
	} else if index > 0 {
		_, _ = b.WriteString("\n" + strings.Repeat("─", r.width) + "\n\n")
	}
	if err := r.renderDiagnostic(b, d); err != nil {
		return err
	}
	return b.flush()
}

func (r *humanRenderer) write(section string) error {
	if err := r.ctx.Err(); err != nil {
		return err
	}
	_, err := io.WriteString(r.output, section)
	return err
}

func newHumanRenderer(w io.Writer, p *lint.Project, opts HumanOptions) (*humanRenderer, error) {
	ctx := opts.Context
	if ctx == nil {
		ctx = context.Background()
	}
	return newHumanRendererWithSession(w, p, opts, newHighlightSession(ctx, 1))
}

func newHumanRendererWithSession(w io.Writer, p *lint.Project, opts HumanOptions, highlights *highlightSession) (*humanRenderer, error) {
	ctx := opts.Context
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	width := opts.Width
	if width <= 0 {
		width = defaultHumanWidth
	}
	markdown, err := glamour.NewTermRenderer(
		glamour.WithStyles(humanMarkdownStyles(opts.Theme)),
		glamour.WithWordWrap(width),
		glamour.WithPreservedNewLines(),
	)
	if err != nil {
		return nil, fmt.Errorf("create human markdown renderer: %w", err)
	}
	output := &colorprofile.Writer{Forward: checkedWriter{w}, Profile: outputProfile(opts.ColorProfile)}
	themeName, removed, added := "one-dark-pro", "#3A2C32", "#2C3A32"
	if opts.Theme == ThemeLight {
		themeName, removed, added = "one-light", "#F3E6E6", "#E6EFE7"
	}
	return &humanRenderer{project: p, width: width, styles: newHumanStyles(), markdown: markdown, output: output, lines: make(map[string][]sourceLine), ctx: ctx, color: opts.ColorProfile != ColorNone, themeName: themeName, removed: removed, added: added, highlights: highlights, tokens: make(map[documentKey]cachedDocumentTokens), proposals: make(map[[32]byte]string)}, nil
}

func outputProfile(profile ColorProfile) colorprofile.Profile {
	switch profile {
	case ColorANSI:
		return colorprofile.ANSI
	case ColorANSI256:
		return colorprofile.ANSI256
	case ColorTrueColor:
		return colorprofile.TrueColor
	default:
		return colorprofile.NoTTY
	}
}

func (r *humanRenderer) renderDiagnostic(b textWriter, d Diagnostic) error {
	if err := outputError(b); err != nil {
		return err
	}
	severity := strings.ToUpper(visibleText(d.Severity))
	header := r.styles.severity(d.Severity).Render(severity) + "  " + r.styles.rule.Render(visibleText(d.RuleID))
	_, _ = b.WriteString(header)
	_ = b.WriteByte('\n')
	_, _ = fmt.Fprintf(b, "%s:%d:%d\n", visibleText(d.Path), d.Range.Start.Line, d.Range.Start.Column)
	message, err := r.renderMarkdown(escapeMarkdown(d.Message))
	if err != nil {
		return fmt.Errorf("render diagnostic message: %w", err)
	}
	_, _ = b.WriteString(message)
	_, _ = b.WriteString("\n\n")
	if err := outputError(b); err != nil {
		return err
	}
	compared := r.renderComparison(b, d)
	if !compared {
		r.renderExcerpt(b, d.Location)
	}
	if err := outputError(b); err != nil {
		return err
	}
	if !compared && showExpected(d.Message, d.Expected) {
		expected, err := r.renderMarkdown(escapeMarkdown(d.Expected))
		if err != nil {
			return fmt.Errorf("render diagnostic expected text: %w", err)
		}
		_, _ = fmt.Fprintf(b, "\n%s %s\n", r.styles.label.Render("Expected:"), expected)
	}
	_ = b.WriteByte('\n')
	if actualFix(d.Fix) {
		message := strings.TrimSpace(visibleText(d.Fix.Message))
		if message == "" {
			message = "edits can be applied to the saved file"
		}
		_, _ = fmt.Fprintf(b, "%s %s\n", r.styles.fix.Render("Fix available:"), message)
	} else {
		_, _ = fmt.Fprintf(b, "%s This rule requires a manual change.\n", r.styles.label.Render("Fix:"))
	}
	if len(d.Related) > 0 {
		_, _ = fmt.Fprintf(b, "\n%s\n", r.styles.label.Render("Related:"))
		for i, related := range d.Related {
			if i > 0 {
				_ = b.WriteByte('\n')
			}
			_, _ = fmt.Fprintf(b, "  %s:%d:%d: %s\n", visibleText(related.Path), related.Range.Start.Line, related.Range.Start.Column, singleLine(visibleText(related.Message)))
			r.renderExcerpt(b, related.Location)
		}
	}
	if err := outputError(b); err != nil {
		return err
	}
	return r.ctx.Err()
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
