package tokenizer

import (
	"context"
	"sort"
	"strings"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
)

// Edit is an original-byte replacement. Unsorted, overlapping, out-of-range or
// stale replacements disable reuse; tokenization always uses the supplied source.
type Edit struct {
	Start, End int
	Text       string
}

// DocumentStats distinguishes direct reuse from traversal through the line cache.
type DocumentStats struct{ Visited, Reused int }

type documentLine struct {
	tokens   []Token
	outgoing *StateStack
}

// DocumentSnapshot is immutable after publication. TokenizeDocument's internal
// result borrows its tokens: consumers must clone scopes before exposing them.
// A snapshot is published only after the entire requested scan stays untainted.
type DocumentSnapshot struct {
	source                   string
	lines                    [][]byte
	starts                   []int
	records                  []documentLine
	grammar                  *grammar.Grammar
	resolver                 resolverKey
	maxLineLength, timeoutMs int
}

type documentScan struct {
	*DocumentSnapshot
	previous                            *DocumentSnapshot
	limit, prefix, oldSuffix, newSuffix int
	stats                               DocumentStats
	safe                                bool
}

// TokenizeDocument resumes exact-source prefixes or validated edits at a complete
// line boundary. Only aligned unchanged source and equal normalized full grammar
// state permit suffix reuse. Returned snapshots never own scanners or goroutines.
func TokenizeDocument(ctx context.Context, source string, throughLine int, g *grammar.Grammar, lib oniguruma.OnigLib, opts TokenizeOptions, previous *DocumentSnapshot, edits []Edit, resolvers ...grammar.GrammarResolver) (*TokenizeResult, *DocumentSnapshot, DocumentStats, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, DocumentStats{}, err
	}
	var resolver grammar.GrammarResolver
	if len(resolvers) > 0 {
		resolver = resolvers[0]
	}
	identity, reliable := resolverIdentity(resolver)
	if !reliable || previous != nil && (previous.grammar != g || previous.resolver != identity || previous.maxLineLength != opts.MaxLineLength || previous.timeoutMs != opts.TimeoutMs) {
		previous = nil
	}
	scan := &documentScan{DocumentSnapshot: &DocumentSnapshot{source: source, grammar: g, resolver: identity, maxLineLength: opts.MaxLineLength, timeoutMs: opts.TimeoutMs}, previous: previous, oldSuffix: -1, newSuffix: -1}
	if previous != nil && previous.source == source {
		scan.lines, scan.starts = previous.lines, previous.starts
		if len(edits) == 0 {
			scan.prefix = len(previous.records)
		} else {
			scan.configureEdits(edits)
		}
	} else {
		scan.lines = splitLines([]byte(source))
		scan.starts = lineStarts(source)
		if previous != nil {
			scan.configureEdits(edits)
		}
	}
	scan.limit = min(max(0, throughLine), len(scan.lines))
	scan.prefix = min(scan.prefix, scan.limit)
	scan.records = make([]documentLine, 0, scan.limit)
	result, err := tokenize(ctx, []byte(source), g, lib, opts, scan, resolver)
	if err != nil || !scan.safe || !reliable {
		return result, nil, scan.stats, err
	}
	if scan.previous != nil && previous.source == source && len(previous.records) >= scan.limit {
		return result, previous, scan.stats, nil
	}
	return result, scan.DocumentSnapshot, scan.stats, nil
}

func lineStarts(source string) []int {
	starts := make([]int, 0, strings.Count(source, "\n")+1)
	for offset := 0; offset < len(source); {
		starts = append(starts, offset)
		next := strings.IndexByte(source[offset:], '\n')
		if next < 0 {
			break
		}
		offset += next + 1
	}
	return starts
}

func (d *documentScan) configureEdits(edits []Edit) {
	if len(edits) == 0 {
		d.previous = nil
		return
	}
	old := d.previous.source
	cursor, newCursor := 0, 0
	for i, edit := range edits {
		if edit.Start < cursor || edit.End < edit.Start || edit.End > len(old) || edit.Start < 0 || i > 0 && edit.Start == edits[i-1].Start {
			d.previous = nil
			return
		}
		unchanged := edit.Start - cursor
		if newCursor+unchanged+len(edit.Text) > len(d.source) || d.source[newCursor:newCursor+unchanged] != old[cursor:edit.Start] || d.source[newCursor+unchanged:newCursor+unchanged+len(edit.Text)] != edit.Text {
			d.previous = nil
			return
		}
		newCursor += unchanged + len(edit.Text)
		cursor = edit.End
	}
	if d.source[newCursor:] != old[cursor:] {
		d.previous = nil
		return
	}
	d.prefix = min(strings.Count(old[:edits[0].Start], "\n"), len(d.previous.records))
	// Both positions point at identical suffix bytes. Advance together to the
	// first boundary in BOTH sources: an edit can remove the newline before only
	// one position. Rounding either offset independently would pair different lines.
	suffix := cursor
	if suffix > 0 && old[suffix-1] != '\n' || newCursor > 0 && d.source[newCursor-1] != '\n' {
		next := strings.IndexByte(old[suffix:], '\n')
		if next < 0 {
			return
		}
		suffix += next + 1
	}
	d.oldSuffix = sort.SearchInts(d.previous.starts, suffix)
	d.newSuffix = sort.SearchInts(d.starts, newCursor+suffix-cursor)
}

func (d *documentScan) reusePrefix(result *TokenizeResult, state *StateStack) (int, *StateStack) {
	if d.previous == nil || d.prefix == 0 {
		return 0, state
	}
	for _, record := range d.previous.records[:d.prefix] {
		result.Lines = append(result.Lines, record.tokens)
	}
	d.records = append(d.records, d.previous.records[:d.prefix]...)
	d.stats.Reused += d.prefix
	return d.prefix, d.records[d.prefix-1].outgoing.clone()
}

func (d *documentScan) reuseSuffix(line int, state *StateStack, result *TokenizeResult) bool {
	if d.previous == nil || d.newSuffix < 0 || line < d.newSuffix {
		return false
	}
	oldLine := d.oldSuffix + line - d.newSuffix
	if oldLine >= len(d.previous.records) || (line == 0) != (oldLine == 0) {
		return false
	}
	incoming := newStateStack(nil, d.grammar.ScopeName)
	if oldLine > 0 {
		incoming = d.previous.records[oldLine-1].outgoing.clone()
		incoming.resetForNewLine()
	}
	if !stateStacksEqual(state, incoming) {
		return false
	}
	count := min(d.limit-line, len(d.previous.records)-oldLine)
	// Source alignment is validated from original-byte edits, never token equality.
	// A prefix snapshot may end before the new requested limit; reuse that portion
	// only when it completes this scan, otherwise let the normal loop continue.
	if count != d.limit-line {
		return false
	}
	for _, record := range d.previous.records[oldLine : oldLine+count] {
		result.Lines = append(result.Lines, record.tokens)
		d.records = append(d.records, record)
	}
	d.stats.Reused += count
	return true
}

func (d *documentScan) record(tokens []Token, state *StateStack) {
	d.records = append(d.records, documentLine{tokens: tokens, outgoing: state.clone()})
}

// Bytes conservatively accounts source, line tables, token/scope slices and
// complete boundary states. Referenced immutable grammar objects belong to the
// highlighter registry and already exist independently of snapshot storage.
func (d *DocumentSnapshot) Bytes() int {
	if d == nil {
		return 0
	}
	size := 256 + 2*len(d.source) + cap(d.lines)*24 + cap(d.starts)*8 + cap(d.records)*32
	for _, record := range d.records {
		size += stateStackBytes(record.outgoing)
		size += cap(record.tokens) * 40
		for _, token := range record.tokens {
			size += cap(token.Scopes) * 16
			for _, scope := range token.Scopes {
				size += len(scope)
			}
		}
	}
	return size
}

// Prefix returns exactly the source prefix represented by a one-based line limit.
func (d *DocumentSnapshot) Prefix(throughLine int) string {
	if throughLine <= 0 {
		return ""
	}
	if throughLine >= len(d.starts) {
		return d.source
	}
	return d.source[:d.starts[throughLine]]
}
