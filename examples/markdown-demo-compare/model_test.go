package compare

import (
	"strings"
	"testing"
	"unicode/utf8"

	v4highlight "saltbox-lint-markdown-demo-v4/highlight"
)

func TestDemoCarriesFindingsAndSourceLocations(t *testing.T) {
	report, err := Demo()
	if err != nil {
		t.Fatal(err)
	}
	if report.Title != "Saltbox Lint" {
		t.Fatalf("Title = %q, want Saltbox Lint", report.Title)
	}
	if got, want := report.Summary, (Summary{Errors: 3, Files: 2, AutomaticFixes: 1}); got != want {
		t.Fatalf("Summary = %#v, want %#v", got, want)
	}
	if len(report.Findings) != 3 {
		t.Fatalf("findings = %d, want 3", len(report.Findings))
	}

	wants := []struct {
		rule, path, prefix, explanation, fix string
		line, column                         int
		current, suggested                   LineRange
		automatic                            bool
	}{
		{"ansible-when-list", "roles/web/tasks/main.yml", "(", "Split this conjunction into separate `when` items.", "This rule requires a manual change.", 102, 9, LineRange{99, 102}, LineRange{99, 104}, false},
		{"ansible-tag-name", "roles/web/tasks/main.yml", "restart_web", "Use a kebab-case tag: replace `restart_web` with `restart-web`.", "This rule requires a manual change.", 148, 7, LineRange{144, 149}, LineRange{144, 149}, false},
		{"section-spacing", "roles/web/defaults/main.yml", "web_role_enabled", "Add a blank line between the section banner and its variables.", "An automatic formatting fix is available with `check --fix`.", 10, 1, LineRange{7, 13}, LineRange{7, 14}, true},
	}
	for i, want := range wants {
		finding := report.Findings[i]
		if finding.Ordinal != i+1 || finding.Total != 3 || finding.Rule != want.rule || finding.Location.Path != want.path || finding.Location.Line != want.line || finding.Location.Column != want.column {
			t.Errorf("finding %d identity = %#v", i, finding)
		}
		if finding.Explanation != want.explanation || finding.Fix.Description != want.fix || finding.Fix.Automatic != want.automatic {
			t.Errorf("finding %d explanation/fix = %q / %#v", i, finding.Explanation, finding.Fix)
		}
		if finding.Current.Document.SourcePath != want.path || finding.Suggested.Document.SourcePath != want.path {
			t.Errorf("finding %d paths differ from location", i)
		}
		if finding.Current.Lines != want.current || finding.Suggested.Lines != want.suggested {
			t.Errorf("finding %d ranges = %#v / %#v", i, finding.Current.Lines, finding.Suggested.Lines)
		}
		assertPrefixAt(t, finding.Current.Document.Source, want.line, want.column, want.prefix)
		assertReconstruction(t, finding.Current.Document.Source, finding.Suggested.Document.Source, finding.Diff)
	}

	groups := report.FileGroups()
	if len(groups) != 2 {
		t.Fatalf("file groups = %#v, want 2", groups)
	}
	if groups[0].SourcePath != "roles/web/tasks/main.yml" || len(groups[0].Findings) != 2 {
		t.Errorf("first file group = %#v", groups[0])
	}
	if groups[1].SourcePath != "roles/web/defaults/main.yml" || len(groups[1].Findings) != 1 {
		t.Errorf("second file group = %#v", groups[1])
	}
}

func TestDocumentHighlightUsesCompleteSourceAndMetadata(t *testing.T) {
	report, err := Demo()
	if err != nil {
		t.Fatal(err)
	}
	highlighter, err := v4highlight.New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := highlighter.Close(t.Context()); err != nil {
			t.Errorf("close highlighter: %v", err)
		}
	}()

	document := report.Findings[0].Current.Document
	result, err := document.Highlight(t.Context(), highlighter, "one-dark-pro")
	if err != nil {
		t.Fatal(err)
	}
	if result.SourcePath != document.SourcePath {
		t.Fatalf("SourcePath = %q, want %q", result.SourcePath, document.SourcePath)
	}
	if got, want := len(result.Combined.Tokens), 155; got != want {
		t.Fatalf("highlighted lines = %d, want complete document's %d", got, want)
	}
}

func assertPrefixAt(t *testing.T, source string, line, column int, want string) {
	t.Helper()
	lines := strings.Split(source, "\n")
	if line > len(lines) {
		t.Fatalf("source has %d lines, want line %d", len(lines), line)
	}
	runes := []rune(lines[line-1])
	if column < 1 || column > len(runes) {
		t.Fatalf("line %d has %d columns, want column %d", line, utf8.RuneCountInString(lines[line-1]), column)
	}
	if !strings.HasPrefix(string(runes[column-1:]), want) {
		t.Fatalf("source %d:%d = %q, want prefix %q", line, column, string(runes[column-1:]), want)
	}
}
