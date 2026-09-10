package report

import (
	"fmt"
	"html"
	"io"
	"net/url"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/saltyorg/saltbox-lint/lint"
)

// GitHub describes the checked source repository, which may be nested inside
// Workspace. RepositoryRoot defaults to Project.Root. Commit should be a SHA.
type GitHub struct{ Workspace, RepositoryRoot, Repository, Commit, ServerURL string }

func githubReport(w io.Writer, p *lint.Project, ds []Diagnostic, opts Options) error {
	var b strings.Builder
	for _, d := range ds {
		end := d.Range.Start
		if d.Span.End > d.Span.Start {
			s := p.Sources[d.Path]
			if s != nil {
				offset := min(d.Span.End, len(s.Data))
				_, size := utf8.DecodeLastRune(s.Data[:offset])
				pos := s.Position(max(d.Span.Start, offset-size))
				end = Position{pos.Line, pos.Column}
			}
		}
		level := "error"
		if d.Severity == "warning" {
			level = "warning"
		}
		if d.Severity == "notice" || d.Severity == "info" {
			level = "notice"
		}
		path := relativeSource(opts.GitHub.Workspace, p.Root, d.Path)
		message := d.Message
		if d.Expected != "" {
			message += "\nExpected: " + d.Expected
		}
		for _, r := range d.Related {
			message += fmt.Sprintf("\nRelated: %s:%d:%d: %s", relativeSource(opts.GitHub.Workspace, p.Root, r.Path), r.Range.Start.Line, r.Range.Start.Column, r.Message)
		}
		fmt.Fprintf(&b, "::%s file=%s,line=%d,col=%d,endLine=%d,endColumn=%d,title=%s::%s\n", level, property(path), d.Range.Start.Line, d.Range.Start.Column, end.Line, end.Column, property(d.RuleID), commandData(message))
	}
	if _, err := io.WriteString(w, b.String()); err != nil {
		return err
	}
	if opts.Summary != nil {
		return githubSummary(opts.Summary, p, ds, opts.GitHub)
	}
	return nil
}
func commandData(s string) string {
	return strings.NewReplacer("%", "%25", "\r", "%0D", "\n", "%0A").Replace(s)
}
func property(s string) string {
	return strings.NewReplacer(",", "%2C", ":", "%3A").Replace(commandData(s))
}
func relativeSource(base, root, path string) string {
	if base == "" {
		return path
	}
	rel, err := filepath.Rel(base, filepath.Join(root, filepath.FromSlash(path)))
	if err != nil {
		return path
	}
	return filepath.ToSlash(rel)
}

// Each append is limited to 64 KiB and 100 findings. Omitted findings remain in
// annotations/JSON; the summary explicitly identifies its own truncation.
func githubSummary(w io.Writer, p *lint.Project, ds []Diagnostic, gh GitHub) error {
	var b strings.Builder
	fmt.Fprintf(&b, "## Saltbox Lint\n\n%d finding(s).\n\n", len(ds))
	if len(ds) == 0 {
		b.WriteString("No findings.\n\n")
	}
	count := 0
	if len(ds) > 0 {
		b.WriteString("| Location | Rule | Message | Expected |\n| --- | --- | --- | --- |\n")
		for _, d := range ds {
			if count == 100 {
				break
			}
			label := fmt.Sprintf("%s:%d:%d", d.Path, d.Range.Start.Line, d.Range.Start.Column)
			loc := cell(label)
			if link := sourceLink(p, d, gh); link != "" {
				loc = "<a href=\"" + html.EscapeString(link) + "\">" + loc + "</a>"
			}
			row := fmt.Sprintf("| %s | %s | %s | %s |\n", loc, cell(d.RuleID), cell(d.Message), cell(d.Expected))
			if b.Len()+len(row) > 65000 {
				break
			}
			b.WriteString(row)
			count++
		}
	}
	if count < len(ds) {
		fmt.Fprintf(&b, "\n%d additional finding(s) omitted from this summary.\n", len(ds)-count)
	}
	b.WriteString("\n")
	_, err := io.WriteString(w, b.String())
	return err
}
func cell(s string) string {
	if len(s) > 2000 {
		s = string([]rune(s)[:min(500, utf8.RuneCountInString(s))]) + "…"
	}
	s = html.EscapeString(s)
	return strings.NewReplacer("|", "&#124;", "[", "&#91;", "]", "&#93;", "*", "&#42;", "_", "&#95;", "`", "&#96;", "\\", "&#92;", "\r", "&#13;", "\n", "<br>").Replace(s)
}
func sourceLink(p *lint.Project, d Diagnostic, gh GitHub) string {
	if gh.Repository == "" || gh.Commit == "" {
		return ""
	}
	server := gh.ServerURL
	if server == "" {
		server = "https://github.com"
	}
	u, err := url.Parse(server)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return ""
	}
	root := gh.RepositoryRoot
	if root == "" {
		root = p.Root
	}
	path := relativeSource(root, p.Root, d.Path)
	if path == ".." || strings.HasPrefix(path, "../") {
		return ""
	}
	return strings.TrimRight(server, "/") + "/" + escapeSegments(gh.Repository) + "/blob/" + url.PathEscape(gh.Commit) + "/" + escapeSegments(path) + fmt.Sprintf("#L%d", d.Range.Start.Line)
}
func escapeSegments(s string) string {
	parts := strings.Split(s, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}
