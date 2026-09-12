package highlight

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/frostybee/nuri"
	"github.com/saltyorg/saltbox-lint/yamlindex"
)

// Disabling the direct session path must fail the literal traversal counters;
// any wrong edit alignment or grammar state must fail the uncached full oracle.
func TestDisplayCheckpointsMatchUncachedEditsAcrossBothThemes(t *testing.T) {
	cached, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, cached)
	oracle, err := newHighlighter(t.Context(), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, oracle)
	original := "- name: First\n  ansible.builtin.debug:\n    msg: |\n      alpha {{ café | default('hello') }}\n      beta\n  when: enabled | bool\n- name: Second\n  ansible.builtin.debug:\n    msg: plain\n"
	variants := []struct {
		name, source string
		edits        []nuri.DocumentEdit
	}{
		{"rename", strings.Replace(original, "First", "FIRST", 1), []nuri.DocumentEdit{{Start: 8, End: 13, Text: "FIRST"}}},
		{"insert first line", "# café\n" + original, []nuri.DocumentEdit{{Start: 0, Text: "# café\n"}}},
		{"delete first line", original[14:], []nuri.DocumentEdit{{Start: 0, End: 14}}},
		{"new eof line", original + "# final\n", []nuri.DocumentEdit{{Start: len(original), End: len(original), Text: "# final\n"}}},
		{"delete eof newline", strings.TrimSuffix(original, "\n"), []nuri.DocumentEdit{{Start: len(original) - 1, End: len(original)}}},
	}
	for _, replacement := range []struct{ name, old, new string }{
		{"multiline collapse", "    msg: |\n", "    msg:\n"},
		{"quoted transition", "    msg: |\n", "    msg: \"\n"},
		{"unicode", "café", "日本語"},
		{"join physical lines", "\n      beta\n", " beta\n"},
		{"hidden semantic tail", "  when: enabled | bool\n", "  when: enabled | bool\n  vars:\n    enabled: true\n"},
		{"malformed yaml", "    msg: plain", "    msg: *missing"},
	} {
		offset := strings.Index(original, replacement.old)
		variants = append(variants, struct {
			name, source string
			edits        []nuri.DocumentEdit
		}{replacement.name, strings.Replace(original, replacement.old, replacement.new, 1), []nuri.DocumentEdit{{Start: offset, End: offset + len(replacement.old), Text: replacement.new}}})
	}
	for _, theme := range []string{"one-dark-pro", "one-light"} {
		document, err := cached.PrepareDisplayDocument(t.Context(), original, DocumentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if err := cached.WarmPreparedDisplayThroughLine(t.Context(), document, theme, 100); err != nil {
			t.Fatal(err)
		}
		for _, variant := range variants {
			t.Run(theme+"/"+variant.name, func(t *testing.T) {
				index, _ := yamlindex.Scan(variant.source)
				opts := DocumentOptions{SourceIndex: index}
				for _, limit := range []int{0, 1, 4, 6, 100} {
					got, err := cached.HighlightEditedDisplayThroughLine(t.Context(), document, variant.source, theme, opts, variant.edits, limit)
					if err != nil {
						t.Fatal(err)
					}
					want, err := oracle.HighlightDisplayThroughLine(t.Context(), variant.source, theme, DocumentOptions{}, limit)
					if err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("line %d: cached scopes/RGB/fonts/diagnostics differ from uncached full-context oracle", limit)
					}
				}
			})
		}
		before := cached.CacheStats()
		got, err := cached.HighlightPreparedDisplayThroughLine(t.Context(), document, theme, 4)
		if err != nil {
			t.Fatal(err)
		}
		after := cached.CacheStats()
		if after.Visited != before.Visited || after.Reused-before.Reused != 4 {
			t.Fatalf("prefix counters before=%+v after=%+v", before, after)
		}
		got.Tokens[0][0].Scopes[0] = "caller mutation"
		again, err := cached.HighlightPreparedDisplayThroughLine(t.Context(), document, theme, 4)
		if err != nil {
			t.Fatal(err)
		}
		want, err := oracle.HighlightDisplayThroughLine(t.Context(), original, theme, DocumentOptions{}, 4)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(again, want) {
			t.Fatal("returned scopes mutated a stored checkpoint")
		}
	}
}

func TestDisplayCheckpointsPreserveCRLFAndEOF(t *testing.T) {
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)
	oracle, err := newHighlighter(t.Context(), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, oracle)
	for _, source := range []string{"", "value: café", "value: café\r\nnext: true\r\n", "value: café\r\n\r\n", "value: café\r"} {
		document, err := h.PrepareDisplayDocument(t.Context(), source, DocumentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		for _, limit := range []int{0, 1, 2, 100} {
			got, err := h.HighlightPreparedDisplayThroughLine(t.Context(), document, "one-light", limit)
			if err != nil {
				t.Fatal(err)
			}
			want, err := oracle.HighlightDisplayThroughLine(t.Context(), source, "one-light", DocumentOptions{}, limit)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("source=%q line=%d changed EOF/CRLF behavior", source, limit)
			}
		}
	}
}

func TestDisplayCheckpointsRespectCancellationAndOwnership(t *testing.T) {
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)
	other, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, other)
	document, err := h.PrepareDisplayDocument(t.Context(), "key: value\n", DocumentOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.WarmPreparedDisplayThroughLine(t.Context(), document, "one-dark-pro", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := other.HighlightPreparedDisplayThroughLine(t.Context(), document, "one-dark-pro", 1); err == nil {
		t.Fatal("another highlighter reused a foreign document")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := h.HighlightEditedDisplayThroughLine(ctx, document, "key: value\n", "one-light", DocumentOptions{}, nil, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled reuse error=%v", err)
	}
}

func TestEditedCheckpointsPreserveCRLFByteOffsets(t *testing.T) {
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, h)
	oracle, err := newHighlighter(t.Context(), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTestHighlighter(t, oracle)
	source := "key: café\r\nnext: true\r\nlast: end"
	document, err := h.PrepareDisplayDocument(t.Context(), source, DocumentOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.WarmPreparedDisplayThroughLine(t.Context(), document, "one-light", 3); err != nil {
		t.Fatal(err)
	}
	variants := []struct {
		source string
		edits  []nuri.DocumentEdit
	}{
		{"key: 日本語\r\nnext: true\r\nlast: end", []nuri.DocumentEdit{{Start: 5, End: 10, Text: "日本語"}}},
		{"key: café\nnext: true\nlast: end", []nuri.DocumentEdit{{Start: 10, End: 11}, {Start: 22, End: 23}}},
		{source + "\nnew: yes\n", []nuri.DocumentEdit{{Start: len(source), End: len(source), Text: "\nnew: yes\n"}}},
	}
	for _, variant := range variants {
		before := h.CacheStats()
		got, err := h.HighlightEditedDisplayThroughLine(t.Context(), document, variant.source, "one-light", DocumentOptions{}, variant.edits, 100)
		if err != nil {
			t.Fatal(err)
		}
		want, err := oracle.HighlightDisplayThroughLine(t.Context(), variant.source, "one-light", DocumentOptions{}, 100)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("CRLF edit changed tokens for %q", variant.source)
		}
		if after := h.CacheStats(); after.Reused == before.Reused {
			t.Fatalf("CRLF fixture did not exercise validated reuse: %q", variant.source)
		}
	}
}
