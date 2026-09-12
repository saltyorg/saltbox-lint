package report

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/saltyorg/saltbox-lint/highlight"
	"github.com/saltyorg/saltbox-lint/lint"
)

func TestDocumentTokensInvalidatesChangedCollectionContext(t *testing.T) {
	source, _ := lint.Parse("roles/demo/tasks/main.yml", []byte("- server:\n    name: demo\n"))
	metadata, _ := lint.Parse("roles/demo/meta/main.yml", []byte("collections: [hetzner.hcloud]\n"))
	project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source, metadata.Path: metadata}}
	r, err := newHumanRenderer(&bytes.Buffer{}, project, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	first := r.documentTokens(source.Path, string(source.Data), 2)
	metadata.Documents[0].Get("collections").Items[0].Value = "missing.collection"
	got := r.documentTokens(source.Path, string(source.Data), 2)
	want, err := r.highlights.get().HighlightDisplayThroughLine(t.Context(), string(source.Data), r.themeName, highlight.DocumentOptions{Collections: []string{"missing.collection"}}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.DeepEqual(first, want) {
		t.Fatal("fixture did not change semantic collection resolution")
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("original document cache ignored changed collection context")
	}
}

func TestEditedDocumentTokensReuseOriginalAndReclassifyCandidate(t *testing.T) {
	source, _ := lint.Parse("roles/demo/tasks/main.yml", []byte("- name: original\n  ansible.builtin.debug:\n    msg: '{{ item }}'\n- name: tail\n  ansible.builtin.debug:\n    msg: plain\n"))
	project := &lint.Project{Sources: map[string]*lint.Source{source.Path: source}}
	r, err := newHumanRenderer(&bytes.Buffer{}, project, HumanOptions{ColorProfile: ColorTrueColor, Context: t.Context()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	_ = r.documentTokens(source.Path, string(source.Data), 6)
	before := r.highlights.get().CacheStats()
	candidate := bytes.Replace(source.Data, []byte("original"), []byte("renamed"), 1)
	got := r.editedDocumentTokens(source.Path, string(source.Data), string(candidate), 6, nil, []lint.Edit{{Span: lint.Span{Start: 8, End: 16}, Text: "renamed"}})
	after := r.highlights.get().CacheStats()
	if after.Visited-before.Visited != 1 || after.Reused-before.Reused != 5 {
		t.Fatalf("edit counters before=%+v after=%+v", before, after)
	}
	want, err := r.highlights.get().HighlightDisplayThroughLine(t.Context(), string(candidate), r.themeName, highlight.DocumentOptions{}, 6)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("candidate display differs from full-source wrapper")
	}
	// A stale original byte identity must not use the renderer's prepared source.
	before = r.highlights.get().CacheStats()
	_ = r.editedDocumentTokens(source.Path, "stale source", string(candidate), 6, nil, nil)
	after = r.highlights.get().CacheStats()
	if after.Reused != before.Reused {
		t.Fatal("stale original reused checkpoint")
	}
}
