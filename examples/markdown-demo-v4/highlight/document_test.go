package highlight

import (
	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"reflect"
	"saltbox-lint-markdown-demo-v4/semantics"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDocumentCombinesActualThemeWithoutChangingLexicalEvidence(t *testing.T) {
	source := "- name: Café ☕\n  \"debug\":\n    \"msg\": '{{ value | custom_filter }}'\n    invented: true\n  when: enabled\n"
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
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
