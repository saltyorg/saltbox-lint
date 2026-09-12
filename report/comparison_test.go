package report

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/saltyorg/saltbox-lint/lint"
)

func TestHumanComparisonShowsExactProposalAndSharedReference(t *testing.T) {
	data := "before: true\nvalue: wrong\nafter: true\n"
	source, _ := lint.Parse("roles/demo/defaults/main.yml", []byte(data))
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	edit := lint.Edit{Span: lint.Span{Start: 20, End: 25}, Text: "right"}
	ds := []lint.Diagnostic{
		{Path: source.Path, RuleID: "first", Severity: "error", Message: "replace value", Span: edit.Span, Preview: &lint.Preview{Edits: []lint.Edit{edit}}},
		{Path: source.Path, RuleID: "second", Severity: "error", Message: "same proposal", Span: edit.Span, Preview: &lint.Preview{Edits: []lint.Edit{edit}}},
	}
	var out bytes.Buffer
	if err := Render(&out, p, ds, Options{Format: "human"}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Saltbox Lint", "--- current/roles/demo/defaults/main.yml", "+++ suggested/roles/demo/defaults/main.yml", "@@ -1,3 +1,3 @@", "2   │ - value: wrong", "  2 │ + value: right", "Suggestion shown above", "fixes available for 0 findings"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q:\n%s", want, &out)
		}
	}
	if got := strings.Count(out.String(), "Fix: This rule requires a manual change."); got != 2 {
		t.Fatalf("manual proposals need availability labels, including shared references: %s", &out)
	}
	if strings.Count(out.String(), "--- current/") != 1 {
		t.Fatalf("proposal duplicated:\n%s", &out)
	}
	if string(source.Data) != data {
		t.Fatal("source mutated")
	}
}

func TestHumanComparisonCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var out bytes.Buffer
	err := Render(&out, &lint.Project{}, []lint.Diagnostic{{Path: "a.yml", Message: "bad"}}, Options{Human: HumanOptions{Context: ctx}})
	if !errors.Is(err, context.Canceled) || out.Len() != 0 {
		t.Fatalf("cancellation = %v, output %q", err, &out)
	}
}

func TestComparisonHunksPreserveEOFAndLineCoordinates(t *testing.T) {
	tests := []struct {
		name, before, after string
		edits               []lint.Edit
		rows                string
	}{
		{"append same line", "key: old", "key: older", []lint.Edit{{Span: lint.Span{Start: 8, End: 8}, Text: "er"}}, "-1/0 +0/1"},
		{"final newline", "key: old", "key: old\n", []lint.Edit{{Span: lint.Span{Start: 8, End: 8}, Text: "\n"}}, "-1/0 +0/1"},
		{"remove final newline", "key: old\n", "key: old", []lint.Edit{{Span: lint.Span{Start: 8, End: 9}}}, "-1/0 +0/1"},
		{"insert blank line", "a: 1\nb: 2\n", "a: 1\n\nb: 2\n", []lint.Edit{{Span: lint.Span{Start: 5, End: 5}, Text: "\n"}}, " 1/1 +0/2  2/3"},
		{"delete complete line", "a: 1\nb: 2\nc: 3\n", "a: 1\nc: 3\n", []lint.Edit{{Span: lint.Span{Start: 5, End: 10}}}, " 1/1 -2/0  3/2"},
		{"empty source", "", "key: new\n", []lint.Edit{{Text: "key: new\n"}}, "+0/1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hunks := comparisonHunks([]byte(tt.before), []byte(tt.after), physicalLines([]byte(tt.before)), physicalLines([]byte(tt.after)), tt.edits)
			var rows []string
			for _, h := range hunks {
				for _, r := range h.rows {
					rows = append(rows, fmt.Sprintf("%c%d/%d", r.kind, r.old, r.new))
				}
			}
			if got := strings.Join(rows, " "); got != tt.rows {
				t.Fatalf("rows %q, want %q", got, tt.rows)
			}
		})
	}
}

func TestHumanComparisonColorAndSafeFallback(t *testing.T) {
	data := "- name: Test\n  ansible.builtin.debug:\n    msg: '{{ example }}'\n  tags: restart_web\n"
	source, _ := lint.Parse("roles/demo/tasks/main.yml", []byte(data))
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	start := strings.Index(data, "restart_web")
	d := lint.Diagnostic{Path: source.Path, RuleID: "ansible-tag-name", Severity: "error", Message: "Use kebab-case", Span: lint.Span{Start: start, End: start + 11}, Preview: &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: start, End: start + 11}, Text: "restart-web"}}}}
	for _, theme := range []Theme{ThemeDark, ThemeLight} {
		t.Run(fmt.Sprint(theme), func(t *testing.T) {
			var out bytes.Buffer
			if err := Render(&out, p, []lint.Diagnostic{d}, Options{Human: HumanOptions{Theme: theme, ColorProfile: ColorTrueColor, Context: t.Context()}}); err != nil {
				t.Fatal(err)
			}
			want := []string{"48;2;58;44;50", "48;2;44;58;50", "38;2;229;192;123"}
			if theme == ThemeLight {
				want = []string{"48;2;243;230;230", "48;2;230;239;231"}
			}
			for _, color := range want {
				if !strings.Contains(out.String(), color) {
					t.Errorf("missing theme color %s", color)
				}
			}
			if !strings.Contains(charmansi.Strip(out.String()), "+   tags: restart-web") {
				t.Fatalf("source lost: %s", &out)
			}
		})
	}
	bad, _ := lint.Parse("bad.yml", []byte("key: [\nvalue: \x1b]8;;bad\a\n"))
	p.Sources[bad.Path] = bad
	var out bytes.Buffer
	d = lint.Diagnostic{Path: bad.Path, RuleID: "yaml-syntax", Severity: "error", Message: "bad source", Expected: "Close the sequence", Span: lint.Span{Start: 0, End: 3}}
	if err := Render(&out, p, []lint.Diagnostic{d}, Options{Human: HumanOptions{ColorProfile: ColorTrueColor}}); err != nil {
		t.Fatal(err)
	}
	plain := charmansi.Strip(out.String())
	if !strings.Contains(plain, "\\x1b") || !strings.Contains(plain, "Expected: Close the sequence") || strings.Contains(out.String(), "\x1b]8") {
		t.Fatalf("unsafe or missing fallback %q", out.String())
	}
}

func TestHumanComparisonLargeFileStaysCompact(t *testing.T) {
	data := strings.Repeat("# context\n", 100000) + "key: old\n"
	source, _ := lint.Parse("a.yml", []byte(data))
	start := strings.Index(data, "old")
	d := lint.Diagnostic{Path: source.Path, RuleID: "manual", Severity: "error", Message: "Change value", Span: lint.Span{Start: start, End: start + 3}, Preview: &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: start, End: start + 3}, Text: "new"}}}}
	var out bytes.Buffer
	if err := Render(&out, &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}, []lint.Diagnostic{d}, Options{}); err != nil {
		t.Fatal(err)
	}
	if out.Len() > 3000 || !strings.Contains(out.String(), "100001        │ - key: old") || !strings.Contains(out.String(), "       100001 │ + key: new") {
		t.Fatalf("not compact/correct: %s", &out)
	}
}

func TestComparisonWrapsAndRetainsContextIndentation(t *testing.T) {
	data := "first: " + strings.Repeat("x", 40) + "BAD\nsecond:                  context\n"
	source, _ := lint.Parse("a.yml", []byte(data))
	start := strings.Index(data, "BAD")
	d := lint.Diagnostic{Path: source.Path, RuleID: "manual", Severity: "error", Message: "replace", Span: lint.Span{Start: start, End: start + 3}, Preview: &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: start, End: start + 3}, Text: "NEW"}}}}
	var out bytes.Buffer
	if err := Render(&out, &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}, []lint.Diagnostic{d}, Options{Human: HumanOptions{Width: 40}}); err != nil {
		t.Fatal(err)
	}
	var contextLine string
	for _, line := range strings.Split(out.String(), "\n") {
		if strings.Contains(line, "2 2 │") {
			contextLine = line
		}
	}
	if contextLine != "2 2 │   second:                  context" {
		t.Fatalf("context indentation changed: %s", &out)
	}
}

func TestHumanComparisonUsesRealRulePreviews(t *testing.T) {
	taskData := "- name: Test\n  ansible.builtin.debug:\n    msg: '{{ example }}'\n  when: enabled and ready\n  tags: restart_web\n"
	defaultsData := "################################\n# Settings\n################################\nweb_role_enabled: true\n"
	task, _ := lint.Parse("roles/web/tasks/main.yml", []byte(taskData))
	defaults, _ := lint.Parse("roles/web/defaults/main.yml", []byte(defaultsData))
	p := &lint.Project{Sources: map[string]*lint.Source{task.Path: task, defaults.Path: defaults}, Selected: map[string]bool{task.Path: true, defaults.Path: true}}
	var rules []lint.Rule
	for _, rule := range lint.Rules() {
		if rule.ID == "ansible-when-list" || rule.ID == "ansible-tag-name" || rule.ID == "section-spacing" {
			rules = append(rules, rule)
		}
	}
	ds := lint.Analyze(p, rules)
	if len(ds) != 3 {
		t.Fatalf("want three real findings: %+v", ds)
	}
	var out bytes.Buffer
	if err := Render(&out, p, ds, Options{}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"│ +   when:", "│ +     - enabled", "│ +     - ready", "│ +   tags: restart-web", "  4 │ + ", "fixes available for 1 finding"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q: %s", want, &out)
		}
	}
	if got := strings.Count(out.String(), "Fix: This rule requires a manual change."); got != 2 || strings.Count(out.String(), "Fix available:") != 1 {
		t.Fatalf("manual and automatic availability labels incorrect: %s", &out)
	}
	if strings.Count(out.String(), "--- current/") != 3 {
		t.Fatalf("missing independent comparisons: %s", &out)
	}
}

func TestHumanHighlightingUsesLoadedRoleCollections(t *testing.T) {
	source, _ := lint.Parse("roles/demo/tasks/main.yml", []byte("- collections: [community.general]\n  docker_container:\n    name: demo\n"))
	meta, _ := lint.Parse("roles/demo/meta/main.yml", []byte("collections:\n  - community.docker\n"))
	p := &lint.Project{Sources: map[string]*lint.Source{source.Path: source, meta.Path: meta}}
	r, err := newHumanRenderer(&bytes.Buffer{}, p, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	if got := r.roleCollections(source.Path); !slices.Equal(got, []string{"community.docker"}) {
		t.Fatalf("loaded metadata = %v", got)
	}
	if got := r.roleCollections("roles/other/tasks/main.yml"); len(got) != 0 {
		t.Fatalf("unrelated metadata = %v", got)
	}
	delete(p.Sources, meta.Path)
	if got := r.roleCollections(source.Path); len(got) != 0 {
		t.Fatalf("missing metadata = %v", got)
	}
}

func TestComparisonHunksReconstructSuggestedBytes(t *testing.T) {
	// Exercise the result as a patch consumer would, independently of the edit
	// window builder, including deletions and newline-only changes.
	before := "a: 1\r\nb: '😀'\r\nc: three\nlast: yes"
	replacements := []string{"", "x", "\n", "\r\n", "one\ntwo\n"}
	for start := 0; start <= len(before); start++ {
		for end := start; end <= len(before); end++ {
			if start < len(before) && !utf8.RuneStart(before[start]) || end < len(before) && !utf8.RuneStart(before[end]) {
				continue
			}
			for _, replacement := range replacements {
				after := before[:start] + replacement + before[end:]
				edits := []lint.Edit{{Span: lint.Span{Start: start, End: end}, Text: replacement}}
				hunks := comparisonHunks([]byte(before), []byte(after), physicalLines([]byte(before)), physicalLines([]byte(after)), edits)
				oldLines := strings.SplitAfter(before, "\n")
				newLines := strings.SplitAfter(after, "\n")
				var output strings.Builder
				cursor := 0
				for _, h := range hunks {
					first := h.oldStart - 1
					if h.oldCount == 0 {
						first = h.oldStart
					}
					for cursor < first {
						output.WriteString(oldLines[cursor])
						cursor++
					}
					for _, row := range h.rows {
						if row.new > 0 {
							output.WriteString(newLines[row.new-1])
						}
					}
					cursor += h.oldCount
				}
				for cursor < len(oldLines) {
					output.WriteString(oldLines[cursor])
					cursor++
				}
				if output.String() != after {
					t.Fatalf("edit [%d,%d) %q reconstructed %q, want %q", start, end, replacement, output.String(), after)
				}
			}
		}
	}
}

func TestHumanComparisonGuttersAcrossDecimalBoundaries(t *testing.T) {
	for _, number := range []int{9, 99, 999} {
		t.Run(fmt.Sprint(number), func(t *testing.T) {
			data := strings.Repeat("# comment\n", number-1) + "key: old\n"
			source, _ := lint.Parse("a.yml", []byte(data))
			start := len(data) - len("key: old\n")
			d := lint.Diagnostic{Path: source.Path, Severity: "error", RuleID: "blank-line", Span: lint.Span{Start: start, End: start}, Preview: &lint.Preview{Edits: []lint.Edit{{Span: lint.Span{Start: start, End: start}, Text: "\n"}}}}
			var out bytes.Buffer
			if err := Render(&out, &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}, []lint.Diagnostic{d}, Options{}); err != nil {
				t.Fatal(err)
			}
			digits := len(strconv.Itoa(number + 1))
			blank := fmt.Sprintf("%*s %*d │ + ", digits, "", digits, number)
			context := fmt.Sprintf("%*d %*d │   key: old", digits, number, digits, number+1)
			if !strings.Contains(out.String(), blank) || !strings.Contains(out.String(), context) {
				t.Fatalf("gutter alignment lost: %s", &out)
			}
		})
	}
}
