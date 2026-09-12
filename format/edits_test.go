package format

import (
	"bytes"
	"testing"

	"github.com/saltyorg/saltbox-lint/lint"
)

func TestEditCompositionRetainsOriginalCoordinates(t *testing.T) {
	for _, tt := range []struct {
		name, input, want string
		stages            [][]lint.Edit
	}{
		{"insert into inserted", "abcd", "aXYZbcd", [][]lint.Edit{{{Span: lint.Span{Start: 1, End: 1}, Text: "XZ"}}, {{Span: lint.Span{Start: 2, End: 2}, Text: "Y"}}}},
		{"replace across pieces", "abcdef", "aQf", [][]lint.Edit{{{Span: lint.Span{Start: 1, End: 2}, Text: "XX"}}, {{Span: lint.Span{Start: 1, End: 6}, Text: "Q"}}}},
		{"adjacent deletion", "abcdef", "af", [][]lint.Edit{{{Span: lint.Span{Start: 1, End: 3}, Text: ""}, {Span: lint.Span{Start: 3, End: 5}, Text: ""}}}},
		{"empty source", "", "雪", [][]lint.Edit{{{Span: lint.Span{}, Text: "雪"}}}},
		{"whole deletion", "abc", "", [][]lint.Edit{{{Span: lint.Span{Start: 0, End: 3}, Text: ""}}}},
		{"end insertion", "a", "abc", [][]lint.Edit{{{Span: lint.Span{Start: 1, End: 1}, Text: "b"}}, {{Span: lint.Span{Start: 2, End: 2}, Text: "c"}}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			edits := composeEdits([]byte(tt.input), tt.stages...)
			got := apply([]byte(tt.input), edits)
			if !bytes.Equal(got, []byte(tt.want)) {
				t.Fatalf("got %q, want %q; edits=%+v", got, tt.want, edits)
			}
		})
	}
}
