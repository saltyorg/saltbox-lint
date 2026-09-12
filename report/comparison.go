package report

import (
	"cmp"
	"crypto/sha256"
	"fmt"
	"slices"
	"sort"
	"strconv"

	"github.com/saltyorg/saltbox-lint/lint"
)

type comparisonRow struct {
	old, new int
	kind     byte
}
type comparisonHunk struct {
	rows                                   []comparisonRow
	oldStart, newStart, oldCount, newCount int
}
type editRegion struct{ start, end, delta int }

// proposalKey is cheap relative to cloning and reparsing a complete candidate.
// Normalize the identity here so identical file-wide fixes are only built once.
func proposal(d Diagnostic) (lint.Diagnostic, [32]byte) {
	raw := lint.Diagnostic{Path: d.Path, Preview: d.preview}
	var edits []lint.Edit
	if d.preview != nil {
		edits = slices.Clone(d.preview.Edits)
	} else if d.Fix != nil {
		for _, e := range d.Fix.Edits {
			edits = append(edits, lint.Edit{Span: lint.Span{Start: e.Span.Start, End: e.Span.End}, Text: e.Text})
		}
		raw.Fix = &lint.Fix{Edits: edits}
	}
	slices.SortFunc(edits, func(a, b lint.Edit) int {
		return cmp.Or(cmp.Compare(a.Span.Start, b.Span.Start), cmp.Compare(a.Span.End, b.Span.End), cmp.Compare(a.Text, b.Text))
	})
	edits = slices.Compact(edits)
	h := sha256.New()
	_, _ = fmt.Fprintf(h, "%d:%s", len(d.Path), d.Path)
	for _, e := range edits {
		_, _ = fmt.Fprintf(h, "/%d/%d/%d:%s", e.Span.Start, e.Span.End, len(e.Text), e.Text)
	}
	var key [32]byte
	copy(key[:], h.Sum(nil))
	return raw, key
}

func (r *humanRenderer) renderComparison(b textWriter, d Diagnostic) bool {
	raw, key := proposal(d)
	if previous, ok := r.proposals[key]; ok {
		if previous != "" {
			_, _ = fmt.Fprintf(b, "Suggestion shown above (%s).\n", previous)
			return true
		}
		return false
	}
	r.proposals[key] = ""
	if r.project == nil {
		return false
	}
	var prepared lint.PreparedPreview
	var ok bool
	if r.color {
		prepared, ok = lint.PreparePreview(r.project.Sources[d.Path], raw)
	} else {
		prepared.Change, prepared.Edits, ok = lint.PreviewChange(r.project.Sources[d.Path], raw)
	}
	change, edits := prepared.Change, prepared.Edits
	if !ok {
		return false
	}
	before, after := physicalLines(change.Before), physicalLines(change.After)
	hunks := comparisonHunks(change.Before, change.After, before, after, edits)
	if len(hunks) == 0 {
		return false
	}
	r.proposals[key] = fmt.Sprintf("%s:%d:%d", visibleText(d.Path), d.Range.Start.Line, d.Range.Start.Column)
	_, _ = fmt.Fprintf(b, "--- current/%s\n+++ suggested/%s\n", visibleText(d.Path), visibleText(d.Path))
	beforeThroughLine, afterThroughLine := displayedComparisonLineLimits(hunks)
	beforeTokens := r.documentTokens(d.Path, string(change.Before), beforeThroughLine)
	afterTokens := r.editedDocumentTokens(d.Path, string(change.Before), string(change.After), afterThroughLine, prepared.SourceIndex, edits)
	digits := 1
	for _, h := range hunks {
		for _, row := range h.rows {
			digits = max(digits, len(strconv.Itoa(max(row.old, row.new))))
		}
	}
	previousEnd := 0
	for _, h := range hunks {
		if r.ctx.Err() != nil || outputError(b) != nil {
			return true
		}
		if previousEnd > 0 && h.oldStart > previousEnd {
			_, _ = fmt.Fprintf(b, "… %d unchanged lines omitted …\n", h.oldStart-previousEnd)
		}
		_, _ = fmt.Fprintf(b, "@@ -%d,%d +%d,%d @@\n", h.oldStart, h.oldCount, h.newStart, h.newCount)
		for _, row := range h.rows {
			if r.ctx.Err() != nil || outputError(b) != nil {
				return true
			}
			var line sourceLine
			tokens := beforeTokens
			if row.kind == '+' {
				line = after[row.new-1]
				tokens = afterTokens
			} else {
				line = before[row.old-1]
			}
			r.comparisonLine(b, line, tokens, row, digits)
		}
		previousEnd = h.oldStart + h.oldCount
	}

	return true
}

func displayedComparisonLineLimits(hunks []comparisonHunk) (oldLine, newLine int) {
	for _, h := range hunks {
		for _, row := range h.rows {
			oldLine = max(oldLine, row.old)
			newLine = max(newLine, row.new)
		}
	}
	return oldLine, newLine
}

func lineNumber(line int) string {
	if line == 0 {
		return ""
	}
	return strconv.Itoa(line)
}

func physicalLines(data []byte) []sourceLine {
	lines := splitSourceLines(data)
	if len(lines) > 0 && lines[len(lines)-1].start == len(data) {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func offsetIndex(lines []sourceLine, offset int) int {
	return max(0, sort.Search(len(lines), func(i int) bool { return lines[i].start > offset })-1)
}
func boundaryOffset(lines []sourceLine, index, size int) int {
	if index >= len(lines) {
		return size
	}
	return lines[index].start
}

// comparisonHunks follows the validated original-byte edits. It expands only
// touched lines, trims equal edges, and walks unchanged lines once. No LCS or
// content-dependent quadratic search is needed, even for large files.
func comparisonHunks(oldData, newData []byte, oldLines, newLines []sourceLine, edits []lint.Edit) []comparisonHunk {
	var regions []editRegion
	for _, e := range edits {
		start := len(oldLines)
		var end int
		if e.Span.Start < len(oldData) || (len(oldData) > 0 && oldData[len(oldData)-1] != '\n') {
			start = offsetIndex(oldLines, e.Span.Start)
		}
		if e.Span.End > e.Span.Start {
			end = offsetIndex(oldLines, e.Span.End-1) + 1
		} else {
			end = min(start+1, len(oldLines))
		}
		// Keep the following physical line in the region: replacing a newline
		// can join its content to the touched line. Equal edges are trimmed later.
		end = min(end+1, len(oldLines))
		delta := len(e.Text) - (e.Span.End - e.Span.Start)
		if len(regions) > 0 && start <= regions[len(regions)-1].end {
			last := &regions[len(regions)-1]
			last.end = max(last.end, end)
			last.delta += delta
		} else {
			regions = append(regions, editRegion{start, end, delta})
		}
	}
	var rows []comparisonRow
	oldCursor, newCursor, delta := 0, 0, 0
	contextRows := func(end int) {
		for oldCursor < end {
			rows = append(rows, comparisonRow{oldCursor + 1, newCursor + 1, ' '})
			oldCursor++
			newCursor++
		}
	}
	for _, region := range regions {
		contextRows(region.start)
		afterEndOffset := boundaryOffset(oldLines, region.end, len(oldData)) + delta + region.delta
		afterEnd := sort.Search(len(newLines), func(i int) bool { return newLines[i].start >= afterEndOffset })
		oldEnd, newEnd := region.end, afterEnd
		for oldCursor < oldEnd && newCursor < newEnd && equalSourceLine(oldLines[oldCursor], newLines[newCursor]) {
			contextRows(oldCursor + 1)
		}
		suffix := 0
		for oldEnd-suffix > oldCursor && newEnd-suffix > newCursor && equalSourceLine(oldLines[oldEnd-suffix-1], newLines[newEnd-suffix-1]) {
			suffix++
		}
		for oldCursor < oldEnd-suffix {
			rows = append(rows, comparisonRow{oldCursor + 1, 0, '-'})
			oldCursor++
		}
		for newCursor < newEnd-suffix {
			rows = append(rows, comparisonRow{0, newCursor + 1, '+'})
			newCursor++
		}
		contextRows(oldEnd)
		delta += region.delta
	}
	contextRows(len(oldLines))
	var ranges [][2]int
	for i, row := range rows {
		if row.kind == ' ' {
			continue
		}
		start, end := max(0, i-2), min(len(rows), i+3)
		if len(ranges) > 0 && start <= ranges[len(ranges)-1][1] {
			ranges[len(ranges)-1][1] = end
		} else {
			ranges = append(ranges, [2]int{start, end})
		}
	}
	var hunks []comparisonHunk
	oldPosition, newPosition, cursor := 0, 0, 0
	for _, window := range ranges {
		for cursor < window[0] {
			if rows[cursor].old > 0 {
				oldPosition++
			}
			if rows[cursor].new > 0 {
				newPosition++
			}
			cursor++
		}
		h := comparisonHunk{rows: rows[window[0]:window[1]], oldStart: oldPosition + 1, newStart: newPosition + 1}
		for cursor < window[1] {
			if rows[cursor].old > 0 {
				h.oldCount++
				oldPosition++
			}
			if rows[cursor].new > 0 {
				h.newCount++
				newPosition++
			}
			cursor++
		}
		if h.oldCount == 0 {
			h.oldStart--
		}
		if h.newCount == 0 {
			h.newStart--
		}
		hunks = append(hunks, h)
	}
	return hunks
}

func equalSourceLine(a, b sourceLine) bool { return a.text == b.text && a.ending == b.ending }
