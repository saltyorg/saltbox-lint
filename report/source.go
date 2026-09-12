package report

import (
	"bytes"
	"fmt"
	"iter"
	"slices"
	"strings"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/frostybee/nuri"
	"github.com/rivo/uniseg"
)

const tabWidth = 4

type sourceLine struct {
	text       string
	ending     string
	start, end int
}

type displayCluster struct {
	text               string
	byteStart, byteEnd int
	cellStart, cellEnd int
}

func (r *humanRenderer) sourceLines(path string) ([]sourceLine, bool) {
	if lines, ok := r.lines[path]; ok {
		return lines, true
	}
	if r.project == nil || r.project.Sources[path] == nil {
		return nil, false
	}
	data := r.project.Sources[path].Data
	lines := splitSourceLines(data)
	r.lines[path] = lines
	return lines, true
}

func splitSourceLines(data []byte) []sourceLine {
	lines := make([]sourceLine, 0, bytes.Count(data, []byte{'\n'})+1)
	start := 0
	for start <= len(data) {
		newline := bytes.IndexByte(data[start:], '\n')
		end := len(data)
		next := len(data) + 1
		if newline >= 0 {
			end = start + newline
			next = end + 1
		}
		contentEnd := end
		if newline >= 0 && contentEnd > start && data[contentEnd-1] == '\r' {
			contentEnd--
		}
		lines = append(lines, sourceLine{text: string(data[start:contentEnd]), ending: string(data[contentEnd:min(next, len(data))]), start: start, end: contentEnd})
		if newline < 0 {
			break
		}
		start = next
		if start == len(data) {
			lines = append(lines, sourceLine{start: start, end: start})
			break
		}
	}
	return lines
}

func (r *humanRenderer) renderExcerpt(b textWriter, location Location) {
	lines, ok := r.sourceLines(location.Path)
	if !ok || len(lines) == 0 {
		_, _ = b.WriteString("  source unavailable\n")
		return
	}
	startLine := clamp(location.Range.Start.Line, 1, len(lines))
	endLine := startLine
	if location.Span.End > location.Span.Start {
		endLine = lineForOffset(lines, max(location.Span.Start, location.Span.End-1))
	}
	indexes := excerptIndexes(startLine, endLine, len(lines))
	digits := len(fmt.Sprint(indexes[len(indexes)-1]))
	var tokens *nuri.TokensResult
	if r.project != nil && r.project.Sources[location.Path] != nil {
		tokens = r.documentTokens(location.Path, string(r.project.Sources[location.Path].Data), indexes[len(indexes)-1])
	}
	for _, index := range indexes {
		if r.ctx.Err() != nil || outputError(b) != nil {
			return
		}
		r.excerptLine(b, lines[index-1], tokens, index, digits, location.Span)
	}

}

func excerptIndexes(start, end, total int) []int {
	first := max(1, start-1)
	last := min(total, end+1)
	indexes := make([]int, last-first+1)
	for i := range indexes {
		indexes[i] = first + i
	}
	return indexes
}

func lineForOffset(lines []sourceLine, offset int) int {
	for i := len(lines) - 1; i >= 0; i-- {
		if offset >= lines[i].start {
			return i + 1
		}
	}
	return 1
}

func markerForLine(line sourceLine, span Span) (bool, int, int) {
	if span.Start == span.End {
		if span.Start < line.start || span.Start > line.end {
			return false, 0, 0
		}
		start := displayOffset(line, span.Start)
		return true, start, start + 1
	}
	if span.End <= line.start || span.Start > line.end {
		return false, 0, 0
	}
	startOffset := clamp(span.Start, line.start, line.end)
	endOffset := clamp(span.End, line.start, line.end)
	start := displayOffset(line, startOffset)
	end := displayOffset(line, endOffset)
	for cluster := range sourceClusters(line.text) {
		if endOffset-line.start > cluster.byteStart && endOffset-line.start < cluster.byteEnd {
			end = cluster.cellEnd
			break
		}
	}
	return true, start, max(start+1, end)
}

func displayOffset(line sourceLine, absolute int) int {
	relative := clamp(absolute-line.start, 0, len(line.text))
	cells := 0
	for cluster := range sourceClusters(line.text) {
		if relative < cluster.byteEnd {
			return cluster.cellStart
		}
		cells = cluster.cellEnd
	}
	return cells
}

func displayClusters(text string) []displayCluster { return slices.Collect(sourceClusters(text)) }

func sourceClusters(text string) iter.Seq[displayCluster] {
	return func(yield func(displayCluster) bool) {
		graphemes := uniseg.NewGraphemes(text)
		cells := 0
		for graphemes.Next() {
			start, end := graphemes.Positions()
			raw := graphemes.Str()
			display := visibleText(raw)
			width := charmansi.StringWidth(display)
			if raw == "\t" {
				width = tabWidth - cells%tabWidth
				display = strings.Repeat(" ", width)
			}
			if !yield(displayCluster{text: display, byteStart: start, byteEnd: end, cellStart: cells, cellEnd: cells + width}) {
				return
			}
			cells += width
		}
	}
}

func joinClusters(clusters []displayCluster) string {
	var b strings.Builder
	for _, cluster := range clusters {
		_, _ = b.WriteString(cluster.text)
	}
	return b.String()
}

func visibleText(text string) string {
	var b strings.Builder
	for _, char := range text {
		switch {
		case char == '\n':
			_, _ = b.WriteString("\\n")
		case char == '\r':
			_, _ = b.WriteString("\\r")
		case char == '\t':
			_, _ = b.WriteString("\\t")
		case char < ' ' || char == 0x7f:
			fmt.Fprintf(&b, "\\x%02x", char)
		case char >= 0x80 && char <= 0x9f:
			fmt.Fprintf(&b, "\\u%04x", char)
		default:
			b.WriteRune(char)
		}
	}
	return b.String()
}

func wrapVisible(text string, width int) string {
	return charmansi.Wordwrap(visibleText(text), max(1, width), " ")
}

func clamp(value, low, high int) int {
	return min(max(value, low), high)
}
