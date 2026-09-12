package report

import (
	"fmt"
	"iter"
	"strings"
	"unicode"

	"github.com/frostybee/nuri"
	"github.com/saltyorg/saltbox-lint/highlight"
)

// visualRow refers to original display clusters, retaining byte spans for token
// lookup and absolute cells for caret intersections. Wrapping never edits source.
type visualRow struct {
	clusters     []displayCluster
	start, end   int
	continuation bool
	last         bool
}

func visualRows(line sourceLine, width int) iter.Seq[visualRow] {
	return func(yield func(visualRow) bool) {
		var pending []displayCluster
		continuation := false
		emit := func(last bool) bool {
			count := len(pending)
			if !last {
				for i := len(pending) - 1; i >= 0; i-- {
					if strings.IndexFunc(pending[i].text, unicode.IsSpace) >= 0 {
						count = i + 1
						break
					}
				}
			}
			row := visualRow{clusters: pending[:count], continuation: continuation, last: last}
			if count > 0 {
				row.start = pending[0].cellStart
				row.end = pending[count-1].cellEnd
			}
			if !yield(row) {
				return false
			}
			pending = pending[count:]
			continuation = true
			return true
		}
		appendCluster := func(cluster displayCluster) bool {
			for len(pending) > 0 && cluster.cellEnd-pending[0].cellStart > max(2, width) {
				if !emit(false) {
					return false
				}
			}
			pending = append(pending, cluster)
			return true
		}
		for cluster := range sourceClusters(line.text) {
			// Tabs and escaped controls are safe ASCII expansions, so their display
			// cells can wrap independently while retaining their original byte span.
			if cluster.cellEnd-cluster.cellStart > max(2, width) && len(cluster.text) == cluster.cellEnd-cluster.cellStart {
				for i := range len(cluster.text) {
					part := cluster
					part.text = cluster.text[i : i+1]
					part.cellStart = cluster.cellStart + i
					part.cellEnd = part.cellStart + 1
					if !appendCluster(part) {
						return
					}
				}
			} else if !appendCluster(cluster) {
				return
			}
		}
		emit(true)
	}
}

// withEndpointRow gives an endpoint caret its own visual row when the final
// source row is full. The empty row retains the source endpoint, not a new byte.
func withEndpointRow(rows iter.Seq[visualRow], endpoint, budget int) iter.Seq[visualRow] {
	return func(yield func(visualRow) bool) {
		for row := range rows {
			extra := row.last && endpoint == row.end && row.end-row.start >= budget
			if extra {
				row.last = false
			}
			if !yield(row) {
				return
			}
			if extra {
				yield(visualRow{start: row.end, end: row.end, continuation: true, last: true})
				return
			}
		}
	}
}

func (row visualRow) marker(start, end int) (int, int, bool) {
	a, b := max(start, row.start), min(end, row.end)
	if a < b {
		return a - row.start, b - row.start, true
	}
	if row.last && start == row.end {
		return start - row.start, start - row.start + 1, true
	}
	return 0, 0, false
}

func (r *humanRenderer) codeRow(row visualRow, result *nuri.TokensResult, number int, kind byte, budget int) string {
	if !r.color {
		return joinClusters(row.clusters)
	}
	background := ""
	if kind == '-' {
		background = r.removed
	}
	if kind == '+' {
		background = r.added
	}
	var tokens []nuri.ThemedToken
	if result != nil && number > 0 && number <= len(result.Tokens) {
		tokens = result.Tokens[number-1]
	}
	display := make([]nuri.ThemedToken, 0, len(row.clusters)+1)
	index, offset := 0, 0
	for _, cluster := range row.clusters {
		for index < len(tokens) && offset+len(tokens[index].Content) <= cluster.byteStart {
			offset += len(tokens[index].Content)
			index++
		}
		token := nuri.ThemedToken{}
		if index < len(tokens) {
			token = tokens[index]
		}
		token.Content = cluster.text
		if background != "" {
			token.BgColor = background
		}
		display = append(display, token)
	}
	if background != "" && budget > row.end-row.start {
		display = append(display, nuri.ThemedToken{Content: strings.Repeat(" ", budget-(row.end-row.start)), BgColor: background})
	}
	rendered, err := highlight.ANSI(display)
	if err != nil {
		return joinClusters(row.clusters)
	}
	return rendered
}

func (r *humanRenderer) excerptLine(b textWriter, line sourceLine, tokens *nuri.TokensResult, index, digits int, span Span) {
	prefix := fmt.Sprintf("%*d | ", digits, index)
	continuation := fmt.Sprintf("%*s ↪ ", digits, "")
	caret := fmt.Sprintf("%*s | ", digits, "")
	budget := r.width - digits - 3
	if budget < 2 {
		_, _ = fmt.Fprintf(b, "line %d:\n", index)
		prefix = ""
		continuation = "↪ "
		caret = ""
		budget = max(2, r.width-2)
	}
	if r.width < 4 {
		prefix = ""
		continuation = ""
		budget = max(2, r.width)
	}
	marked, start, end := markerForLine(line, span)
	rows := visualRows(line, budget)
	if marked {
		rows = withEndpointRow(rows, start, budget)
	}
	for row := range rows {
		if r.ctx.Err() != nil || outputError(b) != nil {
			return
		}
		gutter := prefix
		if row.continuation {
			gutter = continuation
			if r.width < 4 {
				_, _ = b.WriteString("↪\n")
			}
		}
		_, _ = fmt.Fprintf(b, "%s%s\n", gutter, r.codeRow(row, tokens, index, ' ', budget))
		if marked {
			if a, z, ok := row.marker(start, end); ok {
				markerPrefix := caret
				if row.continuation && prefix == "" && r.width >= 4 {
					markerPrefix = "  "
				}
				_, _ = fmt.Fprintf(b, "%s%s%s\n", markerPrefix, strings.Repeat(" ", a), strings.Repeat("^", z-a))
			}
		}
	}
}

func (r *humanRenderer) comparisonLine(b textWriter, line sourceLine, tokens *nuri.TokensResult, source comparisonRow, digits int) {
	number := source.old
	if source.kind == '+' {
		number = source.new
	}
	prefix := fmt.Sprintf("%*s %*s │ %c ", digits, lineNumber(source.old), digits, lineNumber(source.new), source.kind)
	continuation := fmt.Sprintf("%*s %*s ↪ %c ", digits, "", digits, "", source.kind)
	budget := r.width - (digits*2 + 6)
	if budget < 2 {
		_, _ = fmt.Fprintf(b, "%s %s %c:\n", lineNumber(source.old), lineNumber(source.new), source.kind)
		prefix = fmt.Sprintf("%c ", source.kind)
		continuation = fmt.Sprintf("↪%c", source.kind)
		budget = max(2, r.width-2)
	}
	if r.width < 4 {
		prefix = ""
		continuation = ""
		budget = max(2, r.width)
	}
	for row := range visualRows(line, budget) {
		if r.ctx.Err() != nil || outputError(b) != nil {
			return
		}
		gutter := prefix
		if row.continuation {
			gutter = continuation
			if r.width < 4 {
				_, _ = fmt.Fprintf(b, "↪%c\n", source.kind)
			}
		}
		_, _ = fmt.Fprintf(b, "%s%s\n", gutter, r.codeRow(row, tokens, number, source.kind, budget))
	}
	if source.kind != ' ' && line.ending == "" {
		_, _ = b.WriteString("\\ No newline at end of file\n")
	}
}
