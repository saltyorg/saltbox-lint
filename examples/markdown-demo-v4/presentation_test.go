package main

import (
	"context"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/frostybee/nuri"
	runtimehighlight "saltbox-lint-markdown-demo-v4/highlight"
)

type recordingHighlighter struct {
	sources []string
	themes  []string
}

type observingHighlighter struct {
	inner  sourceHighlighter
	result *nuri.TokensResult
}

func (h *observingHighlighter) Highlight(ctx context.Context, source, theme string, options runtimehighlight.DocumentOptions) (*nuri.TokensResult, error) {
	result, err := h.inner.Highlight(ctx, source, theme, options)
	if err == nil {
		h.result = result
	}
	return result, err
}

func (h *recordingHighlighter) Highlight(_ context.Context, source, theme string, options runtimehighlight.DocumentOptions) (*nuri.TokensResult, error) {
	h.sources = append(h.sources, source)
	h.themes = append(h.themes, theme)

	lines := strings.Split(strings.TrimSuffix(source, "\n"), "\n")
	tokens := make([][]nuri.ThemedToken, len(lines))
	for i, line := range lines {
		tokens[i] = []nuri.ThemedToken{{Content: line, Color: "#61AFEF"}}
	}
	return &nuri.TokensResult{Tokens: tokens}, nil
}

func TestRenderMarkdownHighlightsCompleteSourceAndPreservesExcerpt(t *testing.T) {
	fullSource := strings.Join([]string{
		"---",
		"fixture: true",
		"one: 1",
		"two: 2",
		"three: 3",
		"four: 4",
		"five: 5",
		"six: 6",
		"- name: Déployer café",
		"\tansible.builtin.debug:",
		"",
		"  when: enabled",
	}, "\n") + "\n"
	excerpt := "- name: Déployer café\n\tansible.builtin.debug:\n\n  when: enabled\n"
	markdown := "# Fixture\n\n```saltbox-ansible\n" + excerpt + "```\n"
	h := &recordingHighlighter{}

	rendered, err := renderMarkdown(t.Context(), markdown, h, []codeBlock{{
		Source:    fullSource,
		FirstLine: 9,
		LastLine:  12,
	}}, darkTheme)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.sources) != 1 || h.sources[0] != fullSource {
		t.Fatalf("highlighter source = %#v, want complete source %#v", h.sources, fullSource)
	}
	if len(h.themes) != 1 || h.themes[0] != "one-dark-pro" {
		t.Fatalf("highlighter themes = %#v, want one-dark-pro", h.themes)
	}

	plain := stripANSI(rendered)
	for _, want := range []string{
		" 9 │ - name: Déployer café",
		"10 │ \tansible.builtin.debug:",
		"11 │ ",
		"12 │   when: enabled",
	} {
		if !strings.Contains(plain, want) {
			t.Errorf("rendered output missing %q:\n%s", want, plain)
		}
	}
}

func TestGutterWidthCrossesDecimalBoundaries(t *testing.T) {
	for _, test := range []struct {
		name        string
		first, last int
		want        int
	}{
		{"9_to_10", 9, 10, 2},
		{"99_to_100", 99, 100, 3},
		{"999_to_1000", 999, 1000, 4},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := displayedGutterWidth([]codeBlock{{FirstLine: test.first, LastLine: test.last}})
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("displayedGutterWidth() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestRenderMarkdownUsesRuntimeThemeColors(t *testing.T) {
	fullSource := "---\nwhen: enabled\n"
	markdown := "```saltbox-ansible\nwhen: enabled\n```\n"
	blocks := []codeBlock{{Source: fullSource, FirstLine: 2, LastLine: 2}}

	h, err := newRuntimeHighlighter(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())

	dark, err := renderMarkdown(t.Context(), markdown, h, blocks, darkTheme)
	if err != nil {
		t.Fatal(err)
	}
	light, err := renderMarkdown(t.Context(), markdown, h, blocks, lightTheme)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dark, "\x1b[38;2;224;108;117mwhen") {
		t.Fatalf("dark output lacks One Dark Pro ordinary-property token: %q", dark)
	}
	if !strings.Contains(light, "\x1b[38;2;64;120;242mwhen") {
		t.Fatalf("light output lacks One Light when token: %q", light)
	}
}

func TestRenderMarkdownPreservesMultilineStateFromOutsideExcerpt(t *testing.T) {
	sourceBytes, err := os.ReadFile("highlight/testdata/compatibility.yaml")
	if err != nil {
		t.Fatal(err)
	}
	source := string(sourceBytes)
	excerpt, err := sourceLines(source, 14, 14)
	if err != nil {
		t.Fatal(err)
	}
	markdown := "```saltbox-ansible\n" + excerpt + "```\n"
	runtime, err := newRuntimeHighlighter(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(t.Context())
	observer := &observingHighlighter{inner: runtime}

	rendered, err := renderMarkdown(t.Context(), markdown, observer, []codeBlock{{
		Source: source, FirstLine: 14, LastLine: 14,
	}}, darkTheme)
	if err != nil {
		t.Fatal(err)
	}
	if observer.result == nil || len(observer.result.Tokens) < 14 || len(observer.result.Tokens[13]) != 1 {
		t.Fatalf("unexpected highlighted multiline line: %+v", observer.result)
	}
	token := observer.result.Tokens[13][0]
	if token.Content != "        when: this stays literal" || token.Color != "#98c379" || !slices.Contains(token.Scopes, "string.unquoted.block.ansible") {
		t.Fatalf("multiline token = %+v", token)
	}
	if !strings.Contains(rendered, "\x1b[38;2;152;195;121m        when: this stays literal") {
		t.Fatalf("rendered multiline token lacks One Dark Pro string color: %q", rendered)
	}
}

var ansiPattern = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`)

func stripANSI(value string) string {
	return ansiPattern.ReplaceAllString(value, "")
}

// A lexical-only adapter leaves a known module red. Excerpt-only classification
// treats msg as an ordinary property. Both must use the full task source.
func TestRuntimePresentationUsesFullDocumentSemanticContext(t *testing.T) {
	source := "- debug:\n    msg: 'café'\n"
	h, err := newRuntimeHighlighter(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	rendered, err := renderMarkdown(t.Context(), "```saltbox-ansible\n    msg: 'café'\n```\n", h, []codeBlock{{Source: source, FirstLine: 2, LastLine: 2}}, darkTheme)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rendered, "\x1b[38;2;97;175;239mmsg") {
		t.Fatalf("documented option did not receive semantic blue: %q", rendered)
	}
}
