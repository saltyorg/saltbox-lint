package main_test

import (
	"testing"

	"github.com/saltyorg/saltbox-lint/highlight"
	"github.com/saltyorg/saltbox-lint/highlight/catalog"
	"github.com/saltyorg/saltbox-lint/highlight/semantics"
)

func TestProductionHighlightPackagesCompose(t *testing.T) {
	source := "- name: Show value\n  ansible.builtin.debug:\n    msg: '{{ value }}'\n"

	snapshot, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	if _, found := snapshot.Resolve("ansible.builtin.debug", catalog.ResolveContext{}); !found {
		t.Fatal("embedded catalog cannot resolve ansible.builtin.debug")
	}

	semanticTokens, err := semantics.Classify(source, semantics.Options{Catalog: snapshot})
	if err != nil {
		t.Fatal(err)
	}
	if len(semanticTokens) == 0 {
		t.Fatal("semantic classifier returned no tokens")
	}

	highlighter, err := highlight.New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := highlighter.Close(t.Context()); err != nil {
			t.Errorf("close highlighter: %v", err)
		}
	}()

	raw, err := highlighter.Highlight(t.Context(), source, "one-dark-pro")
	if err != nil {
		t.Fatal(err)
	}
	if len(raw.Tokens) == 0 {
		t.Fatal("lexical highlighter returned no token lines")
	}

	document, err := highlighter.HighlightDocument(t.Context(), source, "one-dark-pro", highlight.DocumentOptions{
		SourcePath:  "roles/example/tasks/main.yml",
		Collections: []string{"community.general"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if document.SourcePath != "roles/example/tasks/main.yml" {
		t.Fatalf("source path = %q", document.SourcePath)
	}
	if !document.SemanticEnabled || document.Lexical == nil || document.Combined == nil {
		t.Fatalf("incomplete document result: %+v", document)
	}
}
