package highlight

import (
	"context"
	"reflect"
	"testing"
)

// A caller mutating returned display tokens or input collections must not alter
// a later prefix rendered from the same immutable prepared document.
func TestPreparedDisplayOwnsSemanticInputAndReturnedTokens(t *testing.T) {
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)
	source := "- docker_container:\n    name: demo\n    image: image\n"
	collections := []string{"community.docker"}
	prepared, err := h.PrepareDisplayDocument(t.Context(), source, DocumentOptions{Collections: collections})
	if err != nil {
		t.Fatal(err)
	}
	collections[0] = "wrong.collection"
	for _, theme := range []string{"one-dark-pro", "one-light"} {
		first, err := h.HighlightPreparedDisplayThroughLine(t.Context(), prepared, theme, 2)
		if err != nil {
			t.Fatal(err)
		}
		first.Tokens[0][0].Content = "mutated"
		got, err := h.HighlightPreparedDisplayThroughLine(t.Context(), prepared, theme, 3)
		if err != nil {
			t.Fatal(err)
		}
		want, err := h.HighlightDisplayThroughLine(t.Context(), source, theme, DocumentOptions{Collections: []string{"community.docker"}}, 3)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s prepared display changed semantic ownership or output", theme)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := h.HighlightPreparedDisplayThroughLine(ctx, prepared, "one-dark-pro", 3); err != context.Canceled {
		t.Fatalf("canceled error=%v", err)
	}
}

func TestPreparedDisplayPreservesMalformedYAMLFallback(t *testing.T) {
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)
	source := "a: *missing\n"
	prepared, err := h.PrepareDisplayDocument(t.Context(), source, DocumentOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := h.HighlightPreparedDisplayThroughLine(t.Context(), prepared, "one-light", 1)
	if err != nil {
		t.Fatal(err)
	}
	want, err := h.HighlightDisplayThroughLine(t.Context(), source, "one-light", DocumentOptions{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("malformed YAML changed lexical fallback")
	}
}
