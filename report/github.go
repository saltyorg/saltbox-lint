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
	workspace := resolvedDirectory(opts.GitHub.Workspace)
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
		path := githubPath(relativeSource(workspace, p.Root, d.Path))
		message := githubText(d.Message)
		if d.Expected != "" {
			message += "\nExpected: " + githubText(d.Expected)
		}
		for _, r := range d.Related {
			message += fmt.Sprintf("\nRelated: %s:%d:%d: %s", githubPath(relativeSource(workspace, p.Root, r.Path)), r.Range.Start.Line, r.Range.Start.Column, githubText(r.Message))
		}
		location := fmt.Sprintf("line=%d,endLine=%d", d.Range.Start.Line, end.Line)
		// The runner accepts columns only for a single-line annotation.
		if d.Range.Start.Line == end.Line {
			location = fmt.Sprintf("line=%d,col=%d,endLine=%d,endColumn=%d", d.Range.Start.Line, d.Range.Start.Column, end.Line, end.Column)
		}
		fmt.Fprintf(&b, "::%s file=%s,%s,title=%s::%s\n", level, property(path), location, property(githubText(d.RuleID)), commandData(message))
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

// workflowEncoded identifies controls that workflow-command escaping already
// round-trips exactly (%0D and %0A).
func workflowEncoded(char rune) bool { return char == '\r' || char == '\n' }

// githubText makes terminal, C1 and bidirectional controls visible with the
// human-output notation. CR and LF keep their spec-defined %0D/%0A encoding.
func githubText(s string) string { return escapeControls(s, false, workflowEncoded) }

// githubPath keeps annotation paths attachable: GitHub matches file= against
// the checkout path after decoding workflow escapes, so a path whose only
// controls are CR/LF is emitted exactly, backslashes included. Any other
// control cannot be written to the log raw, and its visible escape can no
// longer match the checkout path, so such a path is escaped completely with
// doubled backslashes like concise output, keeping its escapes unambiguous.
func githubPath(path string) string {
	if !needsEscape(path, workflowEncoded) {
		return path
	}
	return escapeControls(path, true, workflowEncoded)
}

// resolvedDirectory spells a workspace or repository directory the same way
// Load resolves Project.Root, so a symlinked spelling such as
// GITHUB_WORKSPACE=/ws with /ws -> /real still yields workspace-relative
// paths. A directory that cannot be resolved keeps its original spelling.
func resolvedDirectory(path string) string {
	if path == "" {
		return ""
	}
	if resolved, err := lint.ResolvePath(path); err == nil {
		return resolved
	}
	return path
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
	root := resolvedDirectory(gh.RepositoryRoot)
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
