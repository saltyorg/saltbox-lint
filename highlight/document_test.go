package highlight

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"github.com/saltyorg/saltbox-lint/highlight/semantics"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

var benchmarkDisplayTokens *nuri.TokensResult

//go:embed semantics/testdata/demo-tasks.yml
var benchmarkValidSource string

func BenchmarkLegacyDisplayTokens(b *testing.B) {
	h, err := New(b.Context())
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		if err := h.Close(context.WithoutCancel(b.Context())); err != nil {
			b.Errorf("close highlighter: %v", err)
		}
	})

	for _, test := range []struct {
		name, source, theme string
		throughLine         int
	}{
		{name: "dark", source: benchmarkValidSource, theme: "one-dark-pro", throughLine: 8},
		{name: "light", source: benchmarkValidSource, theme: "one-light", throughLine: 8},
		{name: "malformed", source: "- debug:\n    msg: hello\n  broken: [\n", theme: "one-dark-pro", throughLine: 3},
	} {
		b.Run(test.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				result, err := h.HighlightDocumentThroughLine(b.Context(), test.source, test.theme, DocumentOptions{SourcePath: "roles/demo/tasks/main.yml"}, test.throughLine)
				if err == nil {
					benchmarkDisplayTokens = result.Combined
					continue
				}
				benchmarkDisplayTokens, err = h.HighlightThroughLine(b.Context(), test.source, test.theme, test.throughLine)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkHighlightDisplayThroughLine(b *testing.B) {
	h, err := New(b.Context())
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		if err := h.Close(context.WithoutCancel(b.Context())); err != nil {
			b.Errorf("close highlighter: %v", err)
		}
	})

	for _, test := range []struct {
		name, source, theme string
		throughLine         int
	}{
		{name: "dark", source: benchmarkValidSource, theme: "one-dark-pro", throughLine: 8},
		{name: "light", source: benchmarkValidSource, theme: "one-light", throughLine: 8},
		{name: "malformed", source: "- debug:\n    msg: hello\n  broken: [\n", theme: "one-dark-pro", throughLine: 3},
	} {
		b.Run(test.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				benchmarkDisplayTokens, err = h.HighlightDisplayThroughLine(b.Context(), test.source, test.theme, DocumentOptions{SourcePath: "roles/demo/tasks/main.yml"}, test.throughLine)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestHighlightDisplayThroughLineMatchesThemeAndKeepsEvidenceComplete(t *testing.T) {
	const source = "- name: decorated play\n  hosts: all\n  vars:\n    custom: true\n  tasks:\n    - name: decorated task\n      docker_container:\n        name: demo\n      when: enabled\n  post_tasks: []\n"
	opts := DocumentOptions{SourcePath: "roles/demo/tasks/main.yml", Collections: []string{"community.docker"}}
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)

	for _, test := range []struct {
		name            string
		semanticEnabled bool
		colors          map[string]string
	}{
		{name: "one-dark-pro", semanticEnabled: true, colors: map[string]string{"docker_container": "#E5C07B", "name": "#61AFEF", "when": "#C678DD", "custom": "#E06C75"}},
		{name: "one-light", semanticEnabled: false, colors: map[string]string{"docker_container": "#C18401", "name": "#4078F2", "when": "#A626A4", "custom": "#E45649"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			evidence, err := h.HighlightDocumentThroughLine(t.Context(), source, test.name, opts, 9)
			if err != nil {
				t.Fatal(err)
			}
			display, err := h.HighlightDisplayThroughLine(t.Context(), source, test.name, opts, 9)
			if err != nil {
				t.Fatal(err)
			}
			if evidence.SourcePath != opts.SourcePath || evidence.SemanticEnabled != test.semanticEnabled {
				t.Fatalf("evidence metadata = path %q, semantic enabled %v", evidence.SourcePath, evidence.SemanticEnabled)
			}
			if len(display.Tokens) != 9 {
				t.Fatalf("display rows = %d, want prefix extent 9", len(display.Tokens))
			}
			wantLines := strings.Split(strings.TrimSuffix(sourcePrefixThroughLine(source, 9), "\n"), "\n")
			if got := joinedTokenLines(display); !reflect.DeepEqual(got, wantLines) {
				t.Fatalf("display text = %#v, want %#v", got, wantLines)
			}
			moduleStart := strings.Index(source, "docker_container")
			if !slices.ContainsFunc(evidence.SemanticTokens, func(token semantics.Token) bool {
				return token.Start == moduleStart && token.End == moduleStart+len("docker_container") && token.Type == semantics.Class
			}) {
				t.Fatalf("collections metadata did not classify module: %+v", evidence.SemanticTokens)
			}
			prefixEnd := len(sourcePrefixThroughLine(source, 9))
			if !slices.ContainsFunc(evidence.SemanticTokens, func(token semantics.Token) bool { return token.Start >= prefixEnd }) {
				t.Fatalf("evidence omitted semantic tokens beyond display prefix: %+v", evidence.SemanticTokens)
			}
			assertTokenColor(t, display.Tokens[6], "docker_container", test.colors["docker_container"])
			assertTokenColor(t, display.Tokens[7], "name", test.colors["name"])
			assertTokenColor(t, display.Tokens[8], "when", test.colors["when"])
			assertTokenColor(t, display.Tokens[3], "custom", test.colors["custom"])
			if test.semanticEnabled {
				if !reflect.DeepEqual(display, evidence.Combined) {
					t.Fatal("enabled theme display differs from evidence combination")
				}
				return
			}
			if !reflect.DeepEqual(evidence.Combined, evidence.Lexical) {
				t.Fatal("configuredByTheme evidence no longer reports disabled One Light overlay")
			}
			if reflect.DeepEqual(display, evidence.Lexical) {
				t.Fatal("One Light display omitted semantic Ansible distinctions")
			}
		})
	}
}

func TestHighlightDisplayThroughLineReturnsLexicalTokensOnSemanticError(t *testing.T) {
	const source = "- debug:\n    msg: hello\n  broken: [\n"
	const sourcePath = "roles/broken/tasks/main.yml"
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)

	for _, name := range []string{"one-dark-pro", "one-light"} {
		t.Run(name, func(t *testing.T) {
			lexical, err := h.HighlightThroughLine(t.Context(), source, name, 3)
			if err != nil {
				t.Fatal(err)
			}
			display, err := h.HighlightDisplayThroughLine(t.Context(), source, name, DocumentOptions{SourcePath: sourcePath}, 3)
			if err != nil {
				t.Fatalf("display rejected lexically valid source: %v", err)
			}
			if !reflect.DeepEqual(display, lexical) {
				t.Fatal("semantic fallback changed lexical token colors or cells")
			}
			if result, err := h.HighlightDocumentThroughLine(t.Context(), source, name, DocumentOptions{SourcePath: sourcePath}, 3); result != nil || err == nil || !strings.Contains(err.Error(), "semantic source \""+sourcePath+"\"") {
				t.Fatalf("evidence result = %#v, error = %v", result, err)
			}
		})
	}
}

func TestHighlightDisplayThroughLinePropagatesCancellationAndLexicalErrors(t *testing.T) {
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if result, err := h.HighlightDisplayThroughLine(ctx, "key: value\n", "one-dark-pro", DocumentOptions{}, 1); result != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled display result = %#v, error = %v", result, err)
	}
	if result, err := h.HighlightDisplayThroughLine(t.Context(), "key: value\n", "missing-theme", DocumentOptions{}, 1); result != nil || err == nil {
		t.Fatalf("invalid lexical theme result = %#v, error = %v", result, err)
	}
}

func joinedTokenLines(result *nuri.TokensResult) []string {
	lines := make([]string, len(result.Tokens))
	for lineNumber, line := range result.Tokens {
		var joined strings.Builder
		for _, token := range line {
			joined.WriteString(token.Content)
		}
		lines[lineNumber] = joined.String()
	}
	return lines
}

func assertTokenColor(t *testing.T, tokens []nuri.ThemedToken, content, color string) {
	t.Helper()
	for _, token := range tokens {
		if token.Content == content {
			if !strings.EqualFold(token.Color, color) {
				t.Fatalf("token %q color = %q, want %q", content, token.Color, color)
			}
			return
		}
	}
	t.Fatalf("token %q is missing from %+v", content, tokens)
}

func TestHighlightDocumentThroughLineMatchesCompletePrefixAndKeepsFullSemantics(t *testing.T) {
	source := "- name: demo\r\n  ansible.builtin.debug:\r\n    msg: |-\r\n      {{ value }}\r\n      continuation\r\n  when: enabled\r\n- name: tail\r\n  ansible.builtin.debug: {msg: '{{ unseen }}'}"
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)

	complete, err := h.HighlightDocument(t.Context(), source, "one-dark-pro", DocumentOptions{SourcePath: "roles/demo/tasks/main.yml"})
	if err != nil {
		t.Fatal(err)
	}
	for _, throughLine := range []int{1, 4, 5, 7, 99} {
		t.Run(fmt.Sprint(throughLine), func(t *testing.T) {
			got, err := h.HighlightDocumentThroughLine(t.Context(), source, "one-dark-pro", DocumentOptions{SourcePath: "roles/demo/tasks/main.yml"}, throughLine)
			if err != nil {
				t.Fatal(err)
			}
			wantLines := min(throughLine, len(complete.Lexical.Tokens))
			if !reflect.DeepEqual(got.Lexical.Tokens, complete.Lexical.Tokens[:wantLines]) {
				t.Fatalf("lexical prefix through line %d differs from complete tokenization", throughLine)
			}
			if !reflect.DeepEqual(got.Combined.Tokens, complete.Combined.Tokens[:wantLines]) {
				t.Fatalf("combined prefix through line %d differs from complete tokenization", throughLine)
			}
			if !reflect.DeepEqual(got.SemanticTokens, complete.SemanticTokens) {
				t.Fatalf("semantic classification through line %d was truncated", throughLine)
			}
			if throughLine < len(complete.Lexical.Tokens) && !slices.ContainsFunc(got.SemanticTokens, func(token semantics.Token) bool {
				return token.Start >= len(sourcePrefixThroughLine(source, throughLine))
			}) {
				t.Fatalf("semantic tail beyond line %d is missing", throughLine)
			}
		})
	}
}

func TestHighlighterPoolSupportsConcurrentDocuments(t *testing.T) {
	h, err := NewWithPoolSize(t.Context(), 2)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)
	sources := []string{
		"- name: one\n  ansible.builtin.debug: {msg: '{{ first }}'}\n",
		"- name: two\n  ansible.builtin.debug: {msg: '{{ second }}'}\n",
		"- name: three\n  ansible.builtin.debug: {msg: '{{ third }}'}\n",
		"- name: four\n  ansible.builtin.debug: {msg: '{{ fourth }}'}\n",
	}
	var wg sync.WaitGroup
	errs := make(chan error, len(sources))
	for _, source := range sources {
		wg.Go(func() {
			result, err := h.HighlightDocumentThroughLine(t.Context(), source, "one-dark-pro", DocumentOptions{SourcePath: "roles/demo/tasks/main.yml"}, 2)
			if err == nil && (result == nil || len(result.Combined.Tokens) != 2) {
				err = fmt.Errorf("combined token rows = %d, want 2", len(result.Combined.Tokens))
			}
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestDocumentCombinesActualThemeWithoutChangingLexicalEvidence(t *testing.T) {
	source := "- name: Café ☕\n  \"debug\":\n    \"msg\": '{{ value | custom_filter }}'\n    invented: true\n  when: enabled\n"
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := h.Close(t.Context()); err != nil {
			t.Errorf("close highlighter: %v", err)
		}
	}()
	for _, name := range []string{"one-dark-pro", "one-light"} {
		t.Run(name, func(t *testing.T) {
			result, err := h.HighlightDocument(t.Context(), source, name, DocumentOptions{SourcePath: "roles/web/tasks/main.yml"})
			if err != nil {
				t.Fatal(err)
			}
			if result.SourcePath != "roles/web/tasks/main.yml" {
				t.Fatal("lost document identity")
			}
			if len(result.SemanticTokens) != 4 {
				t.Fatalf("semantic tokens=%+v", result.SemanticTokens)
			}
			raw, err := h.Highlight(t.Context(), source, name)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(raw, result.Lexical) {
				t.Fatal("raw lexical evidence modified")
			}
			if name == "one-light" {
				if result.SemanticEnabled || !reflect.DeepEqual(raw, result.Combined) {
					t.Fatal("disabled theme changed lexical styles")
				}
				return
			}
			if !result.SemanticEnabled {
				t.Fatal("dark theme disabled")
			}
			checks := []struct {
				line        int
				text, color string
			}{{2, "\"debug\"", "#E5C07B"}, {3, "\"msg\"", "#61AFEF"}, {5, "when", "#C678DD"}, {3, "custom_filter", "#61AFEF"}}
			for _, check := range checks {
				joined := ""
				for _, tok := range result.Combined.Tokens[check.line-1] {
					joined += tok.Content
				}
				start := strings.Index(joined, check.text)
				if start < 0 {
					t.Fatalf("missing %q", check.text)
				}
				pos := 0
				for _, tok := range result.Combined.Tokens[check.line-1] {
					if pos+len(tok.Content) > start && pos < start+len(check.text) && !strings.EqualFold(tok.Color, check.color) {
						t.Errorf("%q style=%+v, want %s", check.text, tok, check.color)
					}
					pos += len(tok.Content)
				}
			}
			for i, line := range strings.Split(strings.TrimSuffix(source, "\n"), "\n") {
				var got strings.Builder
				for _, token := range result.Combined.Tokens[i] {
					if !utf8.ValidString(token.Content) {
						t.Fatal("split a UTF8 codepoint")
					}
					got.WriteString(token.Content)
				}
				if got.String() != line {
					t.Fatalf("source bytes changed at line %d", i+1)
				}
			}
		})
	}
}
func TestOverlaySplitsRangesAndInheritsOnlyDefinedProperties(t *testing.T) {
	source := "é \"clé\": value\r\nnext: yes\n"
	lexical := &nuri.TokensResult{Tokens: [][]nuri.ThemedToken{{{Content: "é \"clé\": value", Color: "#112233", BgColor: "#445566", FontStyle: theme.FontStyleItalic | theme.FontStyleBold, Scopes: []string{"source.ansible", "string.quoted"}}}, {{Content: "next: yes", Color: "#112233"}}}}
	original := lexical.Tokens[0][0]
	config, err := parseSemanticTheme([]byte(`{"semanticTokenColors":{"property":{"foreground":"#778899","bold":false}}}`))
	if err != nil {
		t.Fatal(err)
	}
	got := overlay(source, lexical, []semantics.Token{{Start: 3, End: 9, Type: semantics.Property}, {Start: 18, End: 22, Type: semantics.Property}}, config)
	if len(got.Tokens[0]) != 3 {
		t.Fatalf("split result=%+v", got.Tokens)
	}
	middle := got.Tokens[0][1]
	if middle.Content != "\"clé\"" || middle.Color != "#778899" || middle.BgColor != "#445566" || middle.FontStyle != theme.FontStyleItalic || !reflect.DeepEqual(middle.Scopes, original.Scopes) {
		t.Fatalf("merged token=%+v", middle)
	}
	if !reflect.DeepEqual(lexical.Tokens[0][0], original) {
		t.Fatal("mutated lexical token")
	}
	if got.Tokens[1][0].Content != "next" || got.Tokens[1][0].Color != "#778899" {
		t.Fatalf("CRLF offset lost: %+v", got.Tokens[1])
	}
}
