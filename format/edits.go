package format

import (
	"bytes"
	"fmt"
	"slices"

	"github.com/saltyorg/saltbox-lint/lint"
)

func orderEdits(data []byte, edits []lint.Edit) ([]lint.Edit, error) {
	slices.SortFunc(edits, func(a, b lint.Edit) int {
		if a.Span.Start != b.Span.Start {
			return a.Span.Start - b.Span.Start
		}
		return a.Span.End - b.Span.End
	})
	result := make([]lint.Edit, 0, len(edits))
	for _, e := range edits {
		if e.Span.Start < 0 || e.Span.End < e.Span.Start || e.Span.End > len(data) {
			return nil, fmt.Errorf("invalid source edit")
		}
		if len(result) > 0 {
			last := result[len(result)-1]
			if last == e {
				continue
			}
			if last.Span.End > e.Span.Start {
				return nil, fmt.Errorf("overlapping source edits")
			}
		}
		result = append(result, e)
	}
	return result, nil
}

func applyEdits(data []byte, edits []lint.Edit) []byte {
	var out bytes.Buffer
	pos := 0
	for _, e := range edits {
		out.Write(data[pos:e.Span.Start])
		out.WriteString(e.Text)
		pos = e.Span.End
	}
	out.Write(data[pos:])
	return out.Bytes()
}

// sourcePieces composes successive verified edits without a whole-document diff.
// Untouched pieces retain their original offsets; inserted pieces own new text.
type sourcePiece struct {
	start, end int
	text       string
	inserted   bool
}

func composeEdits(original []byte, stages ...[]lint.Edit) []lint.Edit {
	pieces := []sourcePiece{{end: len(original)}}
	for _, stage := range stages {
		reader := pieceReader{pieces: pieces}
		var next []sourcePiece
		position := 0
		for _, e := range stage {
			reader.consume(e.Span.Start-position, true, &next)
			reader.consume(e.Span.End-e.Span.Start, false, &next)
			if e.Text != "" {
				next = append(next, sourcePiece{text: e.Text, inserted: true})
			}
			position = e.Span.End
		}
		// Remaining pieces are unchanged; retain their exact original ownership.
		reader.remainder(&next)
		pieces = next
	}
	var edits []lint.Edit
	cursor := 0
	text := ""
	for _, p := range pieces {
		if p.inserted {
			text += p.text
			continue
		}
		if cursor != p.start || text != "" {
			edits = append(edits, lint.Edit{Span: lint.Span{Start: cursor, End: p.start}, Text: text})
			text = ""
		}
		cursor = p.end
	}
	if cursor != len(original) || text != "" {
		edits = append(edits, lint.Edit{Span: lint.Span{Start: cursor, End: len(original)}, Text: text})
	}
	return edits
}

// pieceReader traverses each stage once; applying each edit by rescanning all
// prior pieces makes ordinary large documents quadratic in the number of edits.
type pieceReader struct {
	pieces        []sourcePiece
	index, offset int
}

func (r *pieceReader) consume(size int, keep bool, out *[]sourcePiece) {
	for size > 0 {
		p := r.pieces[r.index]
		length := p.end - p.start
		if p.inserted {
			length = len(p.text)
		}
		take := min(size, length-r.offset)
		part := p
		if p.inserted {
			part.text = p.text[r.offset : r.offset+take]
		} else {
			part.start = p.start + r.offset
			part.end = part.start + take
		}
		if keep && take > 0 {
			*out = append(*out, part)
		}
		r.offset += take
		size -= take
		if r.offset == length {
			r.index++
			r.offset = 0
		}
	}
}

func (r *pieceReader) remainder(out *[]sourcePiece) {
	if r.index >= len(r.pieces) {
		return
	}
	first := r.pieces[r.index]
	if first.inserted {
		first.text = first.text[r.offset:]
	} else {
		first.start += r.offset
	}
	if first.start != first.end || first.text != "" {
		*out = append(*out, first)
	}
	*out = append(*out, r.pieces[r.index+1:]...)
}
