package compare

import (
	"strings"
	"unicode"
)

// RowKind identifies how a line participates in a line-based diff.
type RowKind string

const (
	Context  RowKind = "context"
	Removal  RowKind = "removal"
	Addition RowKind = "addition"
)

// Span is a half-open byte range within DiffRow.Text. Its bounds always fall
// on UTF-8 rune boundaries.
type Span struct {
	Start int
	End   int
}

// Emphasis identifies the presentation background to add to a changed row.
// WholeLine also covers edits that have no visible byte span, such as a newly
// inserted blank line.
type Emphasis struct {
	WholeLine bool
	Spans     []Span
}

// DiffRow is one exact source line, including its original line ending.
// BeforeLine and AfterLine are 1-based full-document coordinates; zero means
// the row does not exist on that side. BlankLine explicitly identifies added
// or removed blank rows for plain-language annotations.
type DiffRow struct {
	Kind       RowKind
	Text       string
	BeforeLine int
	AfterLine  int
	BlankLine  bool
	Emphasis   Emphasis
}

// Compare returns deterministic line-based diff rows and guided emphasis.
func Compare(before, after string) []DiffRow {
	beforeLines := splitLines(before)
	afterLines := splitLines(after)
	lengths := lineLCS(beforeLines, afterLines)

	rows := make([]DiffRow, 0, len(beforeLines)+len(afterLines))
	beforeIndex, afterIndex := 0, 0
	for beforeIndex < len(beforeLines) || afterIndex < len(afterLines) {
		switch {
		case beforeIndex < len(beforeLines) && afterIndex < len(afterLines) && beforeLines[beforeIndex] == afterLines[afterIndex]:
			rows = append(rows, newRow(Context, beforeLines[beforeIndex], beforeIndex+1, afterIndex+1))
			beforeIndex++
			afterIndex++
		case beforeIndex < len(beforeLines) && (afterIndex == len(afterLines) || lengths[beforeIndex+1][afterIndex] >= lengths[beforeIndex][afterIndex+1]):
			rows = append(rows, newRow(Removal, beforeLines[beforeIndex], beforeIndex+1, 0))
			beforeIndex++
		default:
			rows = append(rows, newRow(Addition, afterLines[afterIndex], 0, afterIndex+1))
			afterIndex++
		}
	}
	applyGuidedEmphasis(rows)
	return rows
}

func splitLines(source string) []string {
	if source == "" {
		return nil
	}
	lines := strings.SplitAfter(source, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func lineLCS(before, after []string) [][]int {
	lengths := make([][]int, len(before)+1)
	for i := range lengths {
		lengths[i] = make([]int, len(after)+1)
	}
	for i := len(before) - 1; i >= 0; i-- {
		for j := len(after) - 1; j >= 0; j-- {
			if before[i] == after[j] {
				lengths[i][j] = lengths[i+1][j+1] + 1
			} else {
				lengths[i][j] = max(lengths[i+1][j], lengths[i][j+1])
			}
		}
	}
	return lengths
}

func newRow(kind RowKind, text string, beforeLine, afterLine int) DiffRow {
	return DiffRow{
		Kind:       kind,
		Text:       text,
		BeforeLine: beforeLine,
		AfterLine:  afterLine,
		BlankLine:  strings.TrimSuffix(strings.TrimSuffix(text, "\n"), "\r") == "",
	}
}

func applyGuidedEmphasis(rows []DiffRow) {
	for start := 0; start < len(rows); {
		if rows[start].Kind == Context {
			start++
			continue
		}
		end := start
		for end < len(rows) && rows[end].Kind != Context {
			end++
		}
		emphasizeChange(rows[start:end])
		start = end
	}
}

func emphasizeChange(rows []DiffRow) {
	removals, additions := []int{}, []int{}
	for i := range rows {
		switch rows[i].Kind {
		case Removal:
			removals = append(removals, i)
		case Addition:
			additions = append(additions, i)
		}
	}
	if len(removals) == 1 && len(additions) == 1 {
		removed := &rows[removals[0]]
		added := &rows[additions[0]]
		removedSpans, addedSpans := changedUnitSpans(removed.Text, added.Text)
		switch {
		case onlyWhitespaceChanged(removed.Text, added.Text, removedSpans, addedSpans):
			added.Emphasis.WholeLine = true
		case len(addedSpans) > 0:
			added.Emphasis.Spans = addedSpans
		case len(removedSpans) > 0:
			removed.Emphasis.Spans = removedSpans
		default:
			added.Emphasis.WholeLine = true
		}
		return
	}
	if len(additions) > 0 {
		for _, index := range additions {
			rows[index].Emphasis.WholeLine = true
		}
		return
	}
	for _, index := range removals {
		rows[index].Emphasis.WholeLine = true
	}
}

type unit struct {
	text       string
	start, end int
}

func changedUnitSpans(before, after string) ([]Span, []Span) {
	beforeUnits := lineUnits(before)
	afterUnits := lineUnits(after)
	lengths := unitLCS(beforeUnits, afterUnits)
	beforeChanged := make([]Span, 0)
	afterChanged := make([]Span, 0)
	beforeIndex, afterIndex := 0, 0
	for beforeIndex < len(beforeUnits) || afterIndex < len(afterUnits) {
		switch {
		case beforeIndex < len(beforeUnits) && afterIndex < len(afterUnits) && beforeUnits[beforeIndex].text == afterUnits[afterIndex].text:
			beforeIndex++
			afterIndex++
		case beforeIndex < len(beforeUnits) && (afterIndex == len(afterUnits) || lengths[beforeIndex+1][afterIndex] >= lengths[beforeIndex][afterIndex+1]):
			beforeChanged = appendSpan(beforeChanged, beforeUnits[beforeIndex])
			beforeIndex++
		default:
			afterChanged = appendSpan(afterChanged, afterUnits[afterIndex])
			afterIndex++
		}
	}
	return beforeChanged, afterChanged
}

func lineUnits(line string) []unit {
	content := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	units := []unit{}
	start, class := 0, runeClass(-1)
	for index, value := range content {
		current := classifyRune(value)
		if class >= 0 && current != class {
			units = append(units, unit{content[start:index], start, index})
			start = index
		}
		class = current
	}
	if start < len(content) {
		units = append(units, unit{content[start:], start, len(content)})
	}
	return units
}

type runeClass int

const (
	wordClass runeClass = iota
	spaceClass
	punctuationClass
)

func classifyRune(value rune) runeClass {
	if unicode.IsSpace(value) {
		return spaceClass
	}
	if unicode.IsLetter(value) || unicode.IsDigit(value) || value == '_' || value == '-' || value == '.' {
		return wordClass
	}
	return punctuationClass
}

func unitLCS(before, after []unit) [][]int {
	lengths := make([][]int, len(before)+1)
	for i := range lengths {
		lengths[i] = make([]int, len(after)+1)
	}
	for i := len(before) - 1; i >= 0; i-- {
		for j := len(after) - 1; j >= 0; j-- {
			if before[i].text == after[j].text {
				lengths[i][j] = lengths[i+1][j+1] + 1
			} else {
				lengths[i][j] = max(lengths[i+1][j], lengths[i][j+1])
			}
		}
	}
	return lengths
}

func appendSpan(spans []Span, value unit) []Span {
	if len(spans) > 0 && spans[len(spans)-1].End == value.start {
		spans[len(spans)-1].End = value.end
		return spans
	}
	return append(spans, Span{Start: value.start, End: value.end})
}

func onlyWhitespaceChanged(before, after string, beforeSpans, afterSpans []Span) bool {
	if len(beforeSpans)+len(afterSpans) == 0 {
		return false
	}
	return spansAreWhitespace(before, beforeSpans) && spansAreWhitespace(after, afterSpans)
}

func spansAreWhitespace(text string, spans []Span) bool {
	for _, span := range spans {
		if strings.TrimSpace(text[span.Start:span.End]) != "" {
			return false
		}
	}
	return true
}
