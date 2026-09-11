package report

import (
	"bytes"
	"strings"
	"testing"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/saltyorg/saltbox-lint/lint"
)

func TestHumanReportAnnotatesFindingsAndSummarizes(t *testing.T) {
	primary, _ := lint.Parse("roles/demo/tasks/main.yml", []byte("before: true\nvalue: wrong\nafter: true\n"))
	related, _ := lint.Parse("roles/demo/defaults/main.yml", []byte("value: default\n"))
	project := &lint.Project{Sources: map[string]*lint.Source{
		primary.Path: primary,
		related.Path: related,
	}}
	diagnostics := []lint.Diagnostic{{
		Path:     primary.Path,
		RuleID:   "example-rule",
		Severity: "error",
		Message:  "value must be enabled",
		Expected: "Use true.",
		Span:     lint.Span{Start: 20, End: 25},
		Related: []lint.RelatedLocation{{
			Path:    related.Path,
			Message: "default declared here",
			Span:    lint.Span{Start: 7, End: 14},
		}},
		Fix: &lint.Fix{Message: "replace value", Edits: []lint.Edit{{Span: lint.Span{Start: 20, End: 25}, Text: "true"}}},
	}}

	var out bytes.Buffer
	if err := Render(&out, project, diagnostics, Options{Format: "human"}); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"ERROR  example-rule",
		"roles/demo/tasks/main.yml:2:8",
		"value must be enabled",
		"1 | before: true",
		"2 | value: wrong",
		"|        ^^^^^",
		"3 | after: true",
		"Expected: Use true.",
		"Fix available: replace value",
		"Related:",
		"roles/demo/defaults/main.yml:1:8: default declared here",
		"Summary: 1 finding: 1 error; 1 file affected; fixes available for 1 finding.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("human report missing %q:\n%s", want, got)
		}
	}
}

func TestHumanReportSuppressesDuplicateExpectedAndHonorsActualEdits(t *testing.T) {
	source, _ := lint.Parse("a.yml", []byte("value: false\n"))
	project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	diagnostics := []lint.Diagnostic{
		{Path: source.Path, RuleID: "manual", Severity: "warning", Message: "Finish this value", Expected: "  Finish this value. \n", Span: lint.Span{Start: 7, End: 12}},
		{Path: source.Path, RuleID: "empty-fix", Severity: "notice", Message: "review this", Span: lint.Span{Start: 0, End: 5}, Fix: &lint.Fix{Message: "not really", Edits: nil}},
		{Path: source.Path, RuleID: "deletion", Severity: "info", Message: "remove this", Span: lint.Span{Start: 0, End: 5}, Fix: &lint.Fix{Message: "delete value", Edits: []lint.Edit{{Span: lint.Span{Start: 0, End: 5}}}}},
	}

	var out bytes.Buffer
	if err := Render(&out, project, diagnostics, Options{Format: "human"}); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if strings.Contains(got, "Expected:") {
		t.Fatalf("duplicate expected text was rendered:\n%s", got)
	}
	if strings.Contains(got, "not really") || strings.Count(got, "Fix available:") != 1 {
		t.Fatalf("only a diagnostic with an actual edit should appear fixable:\n%s", got)
	}
	if !strings.Contains(got, "Summary: 3 findings: 1 warning, 1 notice, 1 info; 1 file affected; fixes available for 1 finding.") {
		t.Fatalf("unexpected summary:\n%s", got)
	}
}

func TestHumanReportZeroFindingsIsExactAndMissingSourcesAreSafe(t *testing.T) {
	var out bytes.Buffer
	if err := Render(&out, &lint.Project{}, nil, Options{Format: "human"}); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "No findings.\n"; got != want {
		t.Fatalf("Render() = %q, want %q", got, want)
	}

	out.Reset()
	diagnostics := []lint.Diagnostic{{Path: "missing.yml", RuleID: "missing", Severity: "error", Message: "source missing", Span: lint.Span{Start: 50, End: 60}}}
	if err := Render(&out, &lint.Project{}, diagnostics, Options{Format: "human"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "missing.yml:1:1") || !strings.Contains(out.String(), "source unavailable") {
		t.Fatalf("missing source report is not useful:\n%s", &out)
	}
}

func TestHumanSourceMarkersUseDisplayCellsAndPreserveLineEndings(t *testing.T) {
	tests := []struct {
		name       string
		data       string
		start, end int
		line       string
		marker     string
	}{
		{name: "tab stops", data: "\tkey: bad\r\n", start: len("\tkey: "), end: len("\tkey: bad"), line: "1 |     key: bad", marker: "|          ^^^"},
		{name: "wide combining and emoji", data: "name: e\u0301😀bad\n", start: len("name: e\u0301😀"), end: len("name: e\u0301😀bad"), line: "1 | name: e\u0301😀bad", marker: "|          ^^^"},
		{name: "emoji sequence", data: "icon: 👩‍💻bad\n", start: len("icon: 👩‍💻"), end: len("icon: 👩‍💻bad"), line: "1 | icon: 👩‍💻bad", marker: "|         ^^^"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			source, _ := lint.Parse("a.yml", []byte(tt.data))
			project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
			diagnostics := []lint.Diagnostic{{Path: source.Path, RuleID: "alignment", Severity: "error", Message: "bad", Span: lint.Span{Start: tt.start, End: tt.end}}}
			var out bytes.Buffer
			if err := Render(&out, project, diagnostics, Options{Format: "human"}); err != nil {
				t.Fatal(err)
			}
			got := out.String()
			if !strings.Contains(got, tt.line) || !strings.Contains(got, tt.marker) || strings.Contains(got, "\r") {
				t.Fatalf("display alignment lost:\n%s", got)
			}
		})
	}
}

func TestHumanSourceExcerptHandlesInsertionEOFAndLongMultilineSpans(t *testing.T) {
	data := []byte("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight")
	source, _ := lint.Parse("a.yml", data)
	project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	tests := []struct {
		name string
		span lint.Span
		want []string
	}{
		{name: "insertion", span: lint.Span{Start: 4, End: 4}, want: []string{"a.yml:2:1", "2 | two", "| ^"}},
		{name: "end of file", span: lint.Span{Start: len(data), End: len(data)}, want: []string{"a.yml:8:6", "8 | eight", "|      ^"}},
		{name: "long multiline", span: lint.Span{Start: 4, End: len(data) - 1}, want: []string{"1 | one", "… 2 lines omitted …", "8 | eight"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			diagnostics := []lint.Diagnostic{{Path: source.Path, RuleID: "span", Severity: "error", Message: "bad", Span: tt.span}}
			var out bytes.Buffer
			if err := Render(&out, project, diagnostics, Options{Format: "human"}); err != nil {
				t.Fatal(err)
			}
			for _, want := range tt.want {
				if !strings.Contains(out.String(), want) {
					t.Errorf("excerpt missing %q:\n%s", want, &out)
				}
			}
			if tt.name == "long multiline" {
				sourceLines := 0
				for _, line := range strings.Split(out.String(), "\n") {
					trimmed := strings.TrimSpace(line)
					if len(trimmed) > 0 && trimmed[0] >= '0' && trimmed[0] <= '9' && strings.Contains(line, " | ") {
						sourceLines++
					}
				}
				if sourceLines != 6 {
					t.Fatalf("source excerpt has %d lines, want 6:\n%s", sourceLines, &out)
				}
			}
		})
	}
}

func TestHumanSourceExcerptCropsLongLinesAroundFinding(t *testing.T) {
	for _, line := range []string{
		"0123456789abcdefghijTARGETklmnopqrstuvwxyz",
		strings.Repeat("界", 20) + "👩‍💻TARGET" + strings.Repeat("界", 20),
	} {
		source, _ := lint.Parse("a.yml", []byte(line+"\n"))
		start := strings.Index(line, "TARGET")
		project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
		diagnostics := []lint.Diagnostic{{Path: source.Path, RuleID: "crop", Severity: "error", Message: "bad", Span: lint.Span{Start: start, End: start + len("TARGET")}}}
		var out bytes.Buffer
		if err := Render(&out, project, diagnostics, Options{Format: "human", Human: HumanOptions{Width: 24}}); err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(out.String(), "\n")
		for i, rendered := range lines {
			if !strings.Contains(rendered, "1 | ") {
				continue
			}
			if !strings.Contains(rendered, "…") || !strings.Contains(rendered, "TARGET") {
				t.Fatalf("finding was not retained in cropped line: %q", rendered)
			}
			if width := charmansi.StringWidth(rendered); width > 24 {
				t.Fatalf("cropped line width = %d, want <= 24: %q", width, rendered)
			}
			sourceText := strings.TrimPrefix(rendered, "1 | ")
			markerText := strings.TrimPrefix(lines[i+1], "  | ")
			if charmansi.StringWidth(sourceText[:strings.Index(sourceText, "TARGET")]) != strings.Index(markerText, "^") {
				t.Fatalf("cropped marker does not begin below TARGET:\n%s\n%s", rendered, lines[i+1])
			}
		}
	}
}

func TestHumanSourceExcerptUsesOneViewportForAdjacentIndentation(t *testing.T) {
	first := "key: " + strings.Repeat("x", 40) + "BAD"
	second := strings.Repeat(" ", 25) + "context"
	source, _ := lint.Parse("a.yml", []byte(first+"\n"+second+"\n"))
	start := strings.Index(first, "BAD")
	project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	diagnostics := []lint.Diagnostic{{Path: source.Path, RuleID: "indent", Severity: "error", Message: "bad indentation", Span: lint.Span{Start: start, End: start + len("BAD")}}}

	var out bytes.Buffer
	if err := Render(&out, project, diagnostics, Options{Format: "human", Human: HumanOptions{Width: 40}}); err != nil {
		t.Fatal(err)
	}
	var firstDisplay, secondDisplay string
	for _, line := range strings.Split(out.String(), "\n") {
		if strings.Contains(line, "1 | ") {
			firstDisplay = strings.TrimPrefix(line, "1 | ")
		}
		if strings.Contains(line, "2 | ") {
			secondDisplay = strings.TrimPrefix(line, "2 | ")
		}
	}
	if !strings.HasPrefix(firstDisplay, "…") || !strings.HasPrefix(secondDisplay, "…") {
		t.Fatalf("adjacent lines did not use the same cropped origin:\n%s", &out)
	}
	firstIndex := strings.Index(firstDisplay, "BAD")
	secondIndex := strings.Index(secondDisplay, "context")
	if firstIndex < 0 || secondIndex < 0 {
		t.Fatalf("cropped lines lost inspected tokens:\n%s", &out)
	}
	firstColumn := charmansi.StringWidth(firstDisplay[:firstIndex])
	secondColumn := charmansi.StringWidth(secondDisplay[:secondIndex])
	if got, want := firstColumn-secondColumn, strings.Index(first, "BAD")-strings.Index(second, "context"); got != want {
		t.Fatalf("displayed indentation delta = %d, want %d:\n%s", got, want, &out)
	}
}

func TestHumanReportSanitizesTerminalControlsAndKeepsOrder(t *testing.T) {
	path := "a\x1b[31m.yml"
	source := &lint.Source{Path: path, Data: []byte("value: \x1b]8;;bad\aevil\x1b]8;;\a\n")}
	project := &lint.Project{Sources: map[string]*lint.Source{path: source}}
	diagnostics := []lint.Diagnostic{
		{Path: path, RuleID: "first\x1b", Severity: "error", Message: "message *literal* [link](target) <tag> `tick`\x1b[2J", Expected: "keep _underscores_ literal", Span: lint.Span{Start: 7, End: 8}},
		{Path: path, RuleID: "second", Severity: "warning", Message: "later", Span: lint.Span{Start: 7, End: 8}},
	}
	var plain, color bytes.Buffer
	if err := Render(&plain, project, diagnostics, Options{Format: "human"}); err != nil {
		t.Fatal(err)
	}
	if strings.ContainsRune(plain.String(), '\x1b') || !strings.Contains(plain.String(), "\\x1b") {
		t.Fatalf("terminal controls were not made visible:\n%q", &plain)
	}
	for _, literal := range []string{"*literal*", "[link](target)", "<tag>", "`tick`", "Expected: keep _underscores_ literal"} {
		if !strings.Contains(plain.String(), literal) {
			t.Errorf("literal Markdown %q was interpreted:\n%s", literal, &plain)
		}
	}
	if strings.Count(plain.String(), "first\\x1b") != 1 || strings.Index(plain.String(), "first\\x1b") > strings.Index(plain.String(), "second") {
		t.Fatalf("diagnostics duplicated or reordered:\n%s", &plain)
	}
	if err := Render(&color, project, diagnostics[:1], Options{Format: "human", Human: HumanOptions{ColorProfile: ColorANSI}}); err != nil {
		t.Fatal(err)
	}
	if !strings.ContainsRune(color.String(), '\x1b') {
		t.Fatalf("explicit color profile produced no ANSI styling: %q", &color)
	}
}

func TestHumanReportRendersYAMLSyntaxDiagnostics(t *testing.T) {
	source, diagnostics := lint.Parse("bad.yml", []byte("value: [\n"))
	if len(diagnostics) == 0 {
		t.Fatal("fixture should be invalid YAML")
	}
	var out bytes.Buffer
	if err := Render(&out, &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}, diagnostics, Options{Format: "human", Human: HumanOptions{Width: 1}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "yaml-syntax") || !strings.Contains(out.String(), "sequence end") || !strings.Contains(out.String(), "token") || !strings.Contains(out.String(), ": [") {
		t.Fatalf("syntax diagnostic was not rendered:\n%s", &out)
	}
}
