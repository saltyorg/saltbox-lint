package report

import (
	"bytes"
	"fmt"
	"strings"
	"unicode/utf8"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/rivo/uniseg"
)

const tabWidth = 4

type sourceLine struct {
	text       string
	start, end int
}

type displayCluster struct {
	text               string
	byteStart, byteEnd int
	cellStart, cellEnd int
}

type croppedLine struct {
	text        string
	start       int
	left, right bool
}

type sourceViewport struct {
	start, end int
}

func (r *humanRenderer) sourceLines(path string) ([]sourceLine, bool) {
	if lines, ok := r.lines[path]; ok {
		return lines, true
	}
	if r.project == nil || r.project.Sources[path] == nil {
		return nil, false
	}
	data := r.project.Sources[path].Data
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
		if contentEnd > start && data[contentEnd-1] == '\r' {
			contentEnd--
		}
		lines = append(lines, sourceLine{text: string(data[start:contentEnd]), start: start, end: contentEnd})
		if newline < 0 {
			break
		}
		start = next
		if start == len(data) {
			lines = append(lines, sourceLine{start: start, end: start})
			break
		}
	}
	r.lines[path] = lines
	return lines, true
}

func (r *humanRenderer) renderExcerpt(b *strings.Builder, location Location) {
	lines, ok := r.sourceLines(location.Path)
	if !ok || len(lines) == 0 {
		b.WriteString("  source unavailable\n")
		return
	}
	startLine := clamp(location.Range.Start.Line, 1, len(lines))
	endLine := startLine
	if location.Span.End > location.Span.Start {
		endLine = lineForOffset(lines, max(location.Span.Start, location.Span.End-1))
	}
	indexes := excerptIndexes(startLine, endLine, len(lines))
	digits := len(fmt.Sprint(indexes[len(indexes)-1]))
	focus := displayOffset(lines[startLine-1], location.Span.Start)
	viewport := excerptViewport(lines, indexes, max(4, r.width-digits-3), focus, startLine)
	previous := -1
	for _, index := range indexes {
		if previous >= 0 && index > previous+1 {
			fmt.Fprintf(b, "%*s | … %d lines omitted …\n", digits, "", index-previous-1)
		}
		line := lines[index-1]
		marked, markerStart, markerEnd := markerForLine(line, location.Span)
		cropped := cropDisplay(line, viewport)
		fmt.Fprintf(b, "%*d | %s\n", digits, index, cropped.text)
		if marked {
			markerStart = max(markerStart, cropped.start) - cropped.start
			markerEnd = max(markerEnd, cropped.start) - cropped.start
			if cropped.left {
				markerStart++
				markerEnd++
			}
			displayWidth := charmansi.StringWidth(cropped.text)
			sourceEnd := displayWidth
			if cropped.right {
				sourceEnd--
			}
			markerStart = clamp(markerStart, 0, sourceEnd)
			markerEnd = clamp(markerEnd, markerStart+1, max(markerStart+1, sourceEnd))
			fmt.Fprintf(b, "%*s | %s%s\n", digits, "", strings.Repeat(" ", markerStart), strings.Repeat("^", markerEnd-markerStart))
		}
		previous = index
	}
}

func excerptViewport(lines []sourceLine, indexes []int, width, focus, focusLine int) sourceViewport {
	maximumWidth := 0
	for _, index := range indexes {
		maximumWidth = max(maximumWidth, displayWidth(lines[index-1]))
	}
	if maximumWidth <= width {
		return sourceViewport{end: width}
	}
	budget := max(1, width-2)
	focusWidth := displayWidth(lines[focusLine-1])
	start := max(0, focus-budget/3)
	start = min(start, max(0, focusWidth-budget))
	return sourceViewport{start: start, end: start + budget}
}

func excerptIndexes(start, end, total int) []int {
	first := max(1, start-1)
	last := min(total, end+1)
	if last-first+1 <= 6 {
		indexes := make([]int, last-first+1)
		for i := range indexes {
			indexes[i] = first + i
		}
		return indexes
	}
	return []int{first, first + 1, first + 2, last - 2, last - 1, last}
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
	return true, start, max(start+1, end)
}

func displayOffset(line sourceLine, absolute int) int {
	relative := clamp(absolute-line.start, 0, len(line.text))
	clusters := displayClusters(line.text)
	for _, cluster := range clusters {
		if relative <= cluster.byteStart {
			return cluster.cellStart
		}
		if relative < cluster.byteEnd {
			return cluster.cellStart
		}
	}
	if len(clusters) == 0 {
		return 0
	}
	return clusters[len(clusters)-1].cellEnd
}

func cropDisplay(line sourceLine, viewport sourceViewport) croppedLine {
	clusters := displayClusters(line.text)
	if len(clusters) == 0 {
		return croppedLine{start: viewport.start}
	}
	total := clusters[len(clusters)-1].cellEnd
	if viewport.start == 0 && total <= viewport.end {
		return croppedLine{text: joinClusters(clusters)}
	}
	selected := make([]displayCluster, 0, len(clusters))
	for _, cluster := range clusters {
		if cluster.cellStart < viewport.start || cluster.cellEnd > viewport.end {
			continue
		}
		selected = append(selected, cluster)
	}
	left := viewport.start > 0 && total > 0
	right := total > viewport.end
	var b strings.Builder
	if left {
		b.WriteRune('…')
	}
	if len(selected) > 0 {
		b.WriteString(strings.Repeat(" ", selected[0].cellStart-viewport.start))
	}
	b.WriteString(joinClusters(selected))
	if right {
		b.WriteRune('…')
	}
	return croppedLine{text: b.String(), start: viewport.start, left: left, right: right}
}

func displayWidth(line sourceLine) int {
	clusters := displayClusters(line.text)
	if len(clusters) == 0 {
		return 0
	}
	return clusters[len(clusters)-1].cellEnd
}

func displayClusters(text string) []displayCluster {
	graphemes := uniseg.NewGraphemes(text)
	clusters := make([]displayCluster, 0, utf8.RuneCountInString(text))
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
		clusters = append(clusters, displayCluster{text: display, byteStart: start, byteEnd: end, cellStart: cells, cellEnd: cells + width})
		cells += width
	}
	return clusters
}

func joinClusters(clusters []displayCluster) string {
	var b strings.Builder
	for _, cluster := range clusters {
		b.WriteString(cluster.text)
	}
	return b.String()
}

func visibleText(text string) string {
	var b strings.Builder
	for _, char := range text {
		switch {
		case char == '\n':
			b.WriteString("\\n")
		case char == '\r':
			b.WriteString("\\r")
		case char == '\t':
			b.WriteString("\\t")
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
