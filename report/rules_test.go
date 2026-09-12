package report

import (
	"bytes"
	"strings"
	"testing"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/saltyorg/saltbox-lint/lint"
)

func TestRenderRuleShowsMetadataExplanationAndExamples(t *testing.T) {
	rule := lint.Rule{
		ID:          "example-rule",
		Summary:     "Prefer literal syntax",
		Explanation: "Keep *stars*, [links](target), <tags>, `ticks`, and \\slashes literal.",
		Kinds:       []lint.Kind{lint.Tasks, lint.Defaults},
		Scope:       "role",
		Fixable:     true,
		GoodExample: "value: '{{ safe }}'\n# ``` remains source",
		BadExample:  "value: [\n# ~~~~ remains source",
	}
	var out bytes.Buffer
	if err := RenderRule(&out, rule, HumanOptions{}); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"example-rule: Prefer literal syntax",
		"Keep *stars*, [links](target), <tags>, `ticks`, and \\slashes literal.",
		"Source kinds: tasks, defaults",
		"Scope: role",
		"Fixable: yes",
		"Good example:",
		"value: '{{ safe }}'",
		"# ``` remains source",
		"Bad example:",
		"value: [",
		"# ~~~~ remains source",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rule output missing %q:\n%s", want, got)
		}
	}
	if strings.ContainsRune(got, '\x1b') {
		t.Fatalf("zero options emitted terminal styling: %q", got)
	}
}

func TestRenderRuleSanitizesControlsAndUsesExplicitColorProfile(t *testing.T) {
	rule := lint.Rule{
		ID:          "unsafe\x1b[2J",
		Summary:     "summary\x1b]8;;target\a",
		Explanation: "explain\x1b[31m",
		GoodExample: "key: \x1b[32mvalue",
		BadExample:  "key: [",
	}
	var plainOut bytes.Buffer
	if err := RenderRule(&plainOut, rule, HumanOptions{}); err != nil {
		t.Fatal(err)
	}
	if strings.ContainsRune(plainOut.String(), '\x1b') || !strings.Contains(plainOut.String(), "\\x1b") || !strings.Contains(plainOut.String(), "\\x07") {
		t.Fatalf("source controls were not rendered visibly: %q", &plainOut)
	}

	var out bytes.Buffer
	if err := RenderRule(&out, rule, HumanOptions{Width: 200, ColorProfile: ColorANSI}); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if !strings.ContainsRune(got, '\x1b') {
		t.Fatal("explicit color profile produced no ANSI styling")
	}
	plain := charmansi.Strip(got)
	for _, line := range strings.Split(plain, "\n") {
		if charmansi.StringWidth(line) > 200 {
			t.Fatalf("requested width was not applied to line %q", line)
		}
	}
}

func TestRenderRulePreservesLiteralTildesInExplanation(t *testing.T) {
	explanation := "keep ~single~ and ~~double~~ plus lone~tail"
	rule := lint.Rule{ID: "tildes", Summary: "literal prose", Explanation: explanation}
	for _, profile := range []ColorProfile{ColorNone, ColorANSI} {
		var out bytes.Buffer
		if err := RenderRule(&out, rule, HumanOptions{ColorProfile: profile}); err != nil {
			t.Fatal(err)
		}
		plain := charmansi.Strip(out.String())
		if !strings.Contains(plain, explanation) {
			t.Fatalf("profile %d changed literal tildes:\n%s", profile, plain)
		}
	}
}

func TestRenderRulePropagatesOutputErrors(t *testing.T) {
	if err := RenderRule(brokenWriter{}, lint.Rule{ID: "example", Summary: "summary"}, HumanOptions{}); err == nil {
		t.Fatal("RenderRule ignored output failure")
	}
}
