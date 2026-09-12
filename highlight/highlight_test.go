package highlight

import (
	"os"
	"slices"
	"strings"
	"testing"
)

// This catches missing injections and theme precedence changing editor colors.
func TestAnsibleCompatibility(t *testing.T) {
	source, err := os.ReadFile("testdata/compatibility.yaml")
	if err != nil {
		t.Fatal(err)
	}
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := h.Close(t.Context()); err != nil {
			t.Errorf("close highlighter: %v", err)
		}
	}()
	result, err := h.Highlight(t.Context(), string(source), "one-dark-pro")
	if err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		line               int
		text, scope, color string
	}{
		{2, "name", "keyword.other.ansible", "#C678DD"},
		{3, "ansible.builtin.debug", "entity.name.tag.ansible", "#E06C75"},
		{4, "{{", "punctuation.section.embedded.begin.jinja", "#C678DD"},
		{4, "item", "variable.other.jinja", "#E06C75"},
		{18, "when", "keyword.other.special-method.ansible", "#61AFEF"},
		{23, "when", "keyword.other.special-method.ansible", "#61AFEF"},
		{25, "-", "punctuation.definition.block.sequence.item.ansible", "#ABB2BF"},
	}
	for _, token := range result.Tokens[18] {
		if slices.Contains(token.Scopes, "meta.flow-unquoted.ansible.condition") {
			t.Errorf("conditional state leaked into following comment: %+v", token)
		}
	}
	for _, check := range checks {
		found := false
		for _, tok := range result.Tokens[check.line-1] {
			if tok.Content != check.text {
				continue
			}
			found = true
			if !slices.Contains(tok.Scopes, check.scope) || !strings.EqualFold(tok.Color, check.color) {
				t.Errorf("line %d %q: scopes=%v color=%s; want scope=%s color=%s", check.line, check.text, tok.Scopes, tok.Color, check.scope, check.color)
			}
		}
		if !found {
			t.Errorf("line %d: missing token %q: %+v", check.line, check.text, result.Tokens[check.line-1])
		}
	}
	for i, line := range strings.Split(strings.TrimSuffix(string(source), "\n"), "\n") {
		var b strings.Builder
		for _, tok := range result.Tokens[i] {
			b.WriteString(tok.Content)
		}
		if b.String() != line {
			t.Errorf("line %d source changed", i+1)
		}
	}
}
