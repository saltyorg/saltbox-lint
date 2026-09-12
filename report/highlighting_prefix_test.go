package report

import (
	"bytes"
	"crypto/sha256"
	"strings"
	"testing"

	"github.com/frostybee/nuri"
	"github.com/saltyorg/saltbox-lint/lint"
)

func TestDocumentTokensExtendsVisiblePrefixWithoutScanningUnseenTail(t *testing.T) {
	data := []byte("first: true\r\nsecond: true\r\nthird: true\r\nfourth: true\r\nfifth: true\r\ntail: '{{ unseen }}'\r\n")
	source, diagnostics := lint.Parse("roles/demo/defaults/main.yml", data)
	if len(diagnostics) != 0 {
		t.Fatalf("parse fixture: %+v", diagnostics)
	}
	r, err := newHumanRenderer(&bytes.Buffer{}, &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()

	first := r.documentTokens(source.Path, string(data), 2)
	if first == nil || len(first.Tokens) != 2 {
		t.Fatalf("first visible prefix has %d token rows, want 2", tokenLineCount(first))
	}
	extended := r.documentTokens(source.Path, string(data), 5)
	if extended == nil || len(extended.Tokens) != 5 {
		t.Fatalf("extended visible prefix has %d token rows, want 5", tokenLineCount(extended))
	}
}

func TestDocumentTokensUsesOneLightSemanticFallbackStyles(t *testing.T) {
	data := []byte("- name: demo\n  ansible.builtin.debug:\n    msg: hello\n  when: enabled\n")
	source, diagnostics := lint.Parse("roles/demo/tasks/main.yml", data)
	if len(diagnostics) != 0 {
		t.Fatalf("parse fixture: %+v", diagnostics)
	}
	r, err := newHumanRenderer(&bytes.Buffer{}, &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}, HumanOptions{Theme: ThemeLight, ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()

	tokens := r.documentTokens(source.Path, string(data), 4)
	for _, check := range []struct {
		line           int
		content, color string
	}{
		{line: 2, content: "ansible.builtin.debug", color: "#C18401"},
		{line: 3, content: "msg", color: "#4078F2"},
		{line: 4, content: "when", color: "#A626A4"},
	} {
		found := false
		for _, token := range tokens.Tokens[check.line-1] {
			if token.Content == check.content {
				found = true
				if !strings.EqualFold(token.Color, check.color) {
					t.Errorf("line %d token %q color = %q, want %q", check.line, check.content, token.Color, check.color)
				}
			}
		}
		if !found {
			t.Errorf("line %d token %q is missing: %+v", check.line, check.content, tokens.Tokens[check.line-1])
		}
	}
}

func TestRenderExcerptRequestsOnlyItsFinalDisplayedLine(t *testing.T) {
	data := []byte("first: true\nsecond: false\nthird: true\n" + strings.Repeat("# tail\n", 1000))
	source, diagnostics := lint.Parse("roles/demo/defaults/main.yml", data)
	if len(diagnostics) != 0 {
		t.Fatalf("parse fixture: %+v", diagnostics)
	}
	project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	r, err := newHumanRenderer(&bytes.Buffer{}, project, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()

	start := bytes.Index(data, []byte("false"))
	var output strings.Builder
	r.renderExcerpt(&output, location(project, source.Path, lint.Span{Start: start, End: start + len("false")}))
	key := documentKey{path: source.Path, sum: sha256.Sum256(data)}
	cached, ok := r.tokens[key]
	if !ok {
		t.Fatal("original document token prefix was not cached")
	}
	if cached.throughLine != 3 || cached.result == nil || len(cached.result.Tokens) != 3 {
		t.Fatalf("cached prefix = through line %d with %d rows, want line 3 with 3 rows", cached.throughLine, tokenLineCount(cached.result))
	}
}

func tokenLineCount(result *nuri.TokensResult) int {
	if result == nil {
		return 0
	}
	return len(result.Tokens)
}
