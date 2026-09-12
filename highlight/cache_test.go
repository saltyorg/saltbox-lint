package highlight

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestLineCacheMatchesUncachedCompleteDocumentOutput(t *testing.T) {
	fixture, err := os.ReadFile("testdata/compatibility.yaml")
	if err != nil {
		t.Fatal(err)
	}
	original := string(fixture)
	variants := []struct {
		name     string
		source   string
		semantic bool
	}{
		{name: "fixture", source: original, semantic: true},
		{name: "edited line", source: strings.Replace(original, "debug:", "ansible.builtin.debug:", 1), semantic: true},
		{name: "inserted multiline transition", source: "- name: inserted\n  ansible.builtin.debug:\n    msg: >-\n      {{ café }}\n" + original, semantic: true},
		{name: "unicode", source: strings.Replace(original, "item", "élément", 1), semantic: true},
		{name: "crlf", source: strings.ReplaceAll(original, "\n", "\r\n")},
		{name: "same line after distinct state", source: "- name: block\n  ansible.builtin.debug:\n    msg: >-\n      repeated\n- name: plain\n  ansible.builtin.debug:\n    msg:\n      repeated\n"},
		{name: "same line not first", source: "other: value\nsame: line\n"},
		{name: "same line at first line", source: "same: line\nother: value\n"},
	}

	cached, err := newHighlighter(t.Context(), defaultLineCacheBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, cached)
	uncached, err := newHighlighter(t.Context(), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, uncached)

	for _, themeName := range []string{"one-dark-pro", "one-light"} {
		for _, variant := range variants {
			t.Run(themeName+"/"+variant.name, func(t *testing.T) {
				gotRaw, err := cached.Highlight(t.Context(), variant.source, themeName)
				if err != nil {
					t.Fatal(err)
				}
				wantRaw, err := uncached.Highlight(t.Context(), variant.source, themeName)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(gotRaw, wantRaw) {
					t.Fatalf("cached lexical output differs for %s", variant.name)
				}

				if !variant.semantic {
					return
				}
				gotDocument, err := cached.HighlightDocument(t.Context(), variant.source, themeName, DocumentOptions{SourcePath: "roles/test/tasks/main.yml"})
				if err != nil {
					t.Fatal(err)
				}
				wantDocument, err := uncached.HighlightDocument(t.Context(), variant.source, themeName, DocumentOptions{SourcePath: "roles/test/tasks/main.yml"})
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(gotDocument, wantDocument) {
					t.Fatalf("cached semantic document output differs for %s", variant.name)
				}
			})
		}
	}
}

func closeTestHighlighter(t *testing.T, h *Highlighter) {
	t.Helper()
	if err := h.Close(t.Context()); err != nil {
		t.Errorf("close highlighter: %v", err)
	}
}
