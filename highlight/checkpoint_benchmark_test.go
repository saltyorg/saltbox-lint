package highlight

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/frostybee/nuri"
)

// The fixture is generated solely from these immutable literals, so the frozen
// benchmark binary is independent of the working directory and consumer files.
func checkpointFixture() string {
	var source strings.Builder
	for i := range 100 {
		fmt.Fprintf(&source, "- name: Example %d\n  ansible.builtin.debug:\n    msg: \"{{ example_%d | default('hello') }}\"\n  when: enabled | bool\n", i, i)
	}
	return source.String()
}

func BenchmarkCheckpointLineCache(b *testing.B) {
	h, err := New(b.Context())
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		if err := h.Close(context.WithoutCancel(b.Context())); err != nil {
			b.Errorf("close highlighter: %v", err)
		}
	})
	source := checkpointFixture()
	if _, err := h.HighlightThroughLine(b.Context(), source, "one-dark-pro", 400); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		for _, line := range []int{80, 160, 240, 320, 400} {
			if _, err := h.HighlightThroughLine(b.Context(), source, "one-dark-pro", line); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkCheckpointDocument(b *testing.B) {
	h, err := New(b.Context())
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		if err := h.Close(context.WithoutCancel(b.Context())); err != nil {
			b.Errorf("close highlighter: %v", err)
		}
	})
	source := checkpointFixture()
	document := h.engine.NewDocument(source)
	opts := nuri.CodeToTokensOptions{Lang: "ansible", Theme: "one-dark-pro"}
	if err := h.engine.WarmDocument(b.Context(), document, 400, opts); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		for _, line := range []int{80, 160, 240, 320, 400} {
			if _, err := h.engine.CodeToDocumentTokens(b.Context(), document, line, opts); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkCheckpointEditedLineCache(b *testing.B) { benchmarkCheckpointEdit(b, false) }
func BenchmarkCheckpointEditedDocument(b *testing.B)  { benchmarkCheckpointEdit(b, true) }
func benchmarkCheckpointEdit(b *testing.B, checkpoints bool) {
	h, err := New(b.Context())
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		if err := h.Close(context.WithoutCancel(b.Context())); err != nil {
			b.Errorf("close highlighter: %v", err)
		}
	})
	source := checkpointFixture()
	offset := strings.Index(source, "Example 50")
	candidate := source[:offset] + "Renamed 50" + source[offset+len("Example 50"):]
	document := h.engine.NewDocument(source)
	opts := nuri.CodeToTokensOptions{Lang: "ansible", Theme: "one-dark-pro"}
	if checkpoints {
		if err := h.engine.WarmDocument(b.Context(), document, 400, opts); err != nil {
			b.Fatal(err)
		}
	} else {
		if _, err := h.HighlightThroughLine(b.Context(), source, "one-dark-pro", 400); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportAllocs()
	for b.Loop() {
		var err error
		if checkpoints {
			_, err = h.engine.CodeToEditedDocumentTokens(b.Context(), document, candidate, []nuri.DocumentEdit{{Start: offset, End: offset + len("Example 50"), Text: "Renamed 50"}}, 400, opts)
		} else {
			_, err = h.HighlightThroughLine(b.Context(), candidate, "one-dark-pro", 400)
		}
		if err != nil {
			b.Fatal(err)
		}
	}
}
