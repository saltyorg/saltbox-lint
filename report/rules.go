package report

import (
	"fmt"
	"html"
	"io"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
)

// RenderRule writes a detailed, human-readable rule explanation. Presentation
// choices must already be resolved by the caller in opts.
func RenderRule(w io.Writer, rule lint.Rule, opts HumanOptions) error {
	r, err := newHumanRenderer(w, nil, opts)
	if err != nil {
		return err
	}
	var b strings.Builder
	title := visibleText(rule.ID) + ": " + visibleText(rule.Summary)
	b.WriteString(r.styles.rule.Render(wrapVisible(title, r.width)))
	b.WriteString("\n\n")
	explanation, err := r.renderMarkdown(escapeMarkdown(rule.Explanation))
	if err != nil {
		return fmt.Errorf("render rule explanation: %w", err)
	}
	b.WriteString(explanation)
	b.WriteString("\n\n")
	kinds := make([]string, len(rule.Kinds))
	for i, kind := range rule.Kinds {
		kinds[i] = visibleText(string(kind))
	}
	if len(kinds) == 0 {
		kinds = []string{"none"}
	}
	fmt.Fprintf(&b, "%s %s\n", r.styles.label.Render("Source kinds:"), strings.Join(kinds, ", "))
	fmt.Fprintf(&b, "%s %s\n", r.styles.label.Render("Scope:"), visibleText(rule.Scope))
	fixable := "no"
	if rule.Fixable {
		fixable = "yes"
	}
	fmt.Fprintf(&b, "%s %s\n\n", r.styles.label.Render("Fixable:"), fixable)
	for _, example := range []struct {
		label string
		text  string
	}{{"Good example:", rule.GoodExample}, {"Bad example:", rule.BadExample}} {
		b.WriteString(r.styles.label.Render(example.label))
		b.WriteByte('\n')
		rendered, err := r.renderMarkdown(fencedCode("yaml", visibleSource(example.text)))
		if err != nil {
			return fmt.Errorf("render %s: %w", strings.TrimSuffix(strings.ToLower(example.label), ":"), err)
		}
		b.WriteString(rendered)
		b.WriteString("\n\n")
	}
	output := strings.TrimRight(b.String(), "\n") + "\n"
	_, err = io.WriteString(r.output, output)
	return err
}

func (r *humanRenderer) renderMarkdown(markdown string) (string, error) {
	output, err := r.markdown.Render(markdown)
	if err != nil {
		return "", err
	}
	return strings.Trim(output, "\n"), nil
}

func escapeMarkdown(text string) string {
	text = visibleText(text)
	text = html.EscapeString(text)
	return strings.NewReplacer(
		"\\", "\\\\",
		"`", "\\`",
		"*", "\\*",
		"_", "\\_",
		"[", "\\[",
		"]", "\\]",
		"(", "\\(",
		")", "\\)",
		"#", "\\#",
		"+", "\\+",
		"-", "\\-",
		".", "\\.",
		"!", "\\!",
		"|", "\\|",
		">", "\\>",
	).Replace(text)
}

func fencedCode(language, code string) string {
	backticks := maxRun(code, '`')
	tildes := maxRun(code, '~')
	character := '`'
	length := max(3, backticks+1)
	if max(3, tildes+1) < length {
		character = '~'
		length = max(3, tildes+1)
	}
	fence := strings.Repeat(string(character), length)
	return fence + language + "\n" + code + "\n" + fence + "\n"
}

func maxRun(text string, target rune) int {
	longest, current := 0, 0
	for _, char := range text {
		if char == target {
			current++
			longest = max(longest, current)
			continue
		}
		current = 0
	}
	return longest
}

func visibleSource(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = joinClusters(displayClusters(strings.TrimSuffix(line, "\r")))
	}
	return strings.Join(lines, "\n")
}
