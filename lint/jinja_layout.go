package lint

import (
	"bytes"
	"fmt"
	"slices"
	"strings"
)

type layoutAnalysis struct {
	source      *Source
	expression  Expression
	edits       []Edit
	diagnostics []Diagnostic
	newline     string
	block       bool
	base        int
}

func layoutFindings(s *Source) ([]Diagnostic, []Edit) {
	var ds []Diagnostic
	var edits []Edit
	for _, e := range Expressions(s) {
		if !e.mapped {
			ds = append(ds, Diagnostic{Path: s.Path, RuleID: "jinja-layout", Severity: "error", Span: e.Span, Message: "Jinja source mapping is unavailable", Expected: "Reparse the source and review this scalar manually; no verified token locations are available."})
			continue
		}
		if !e.Complete {
			ds = append(ds, Diagnostic{Path: s.Path, RuleID: "jinja-layout", Severity: "error", Span: e.Span, Message: "incomplete Jinja expression", Expected: "Complete the quoted strings and delimiters before formatting."})
			continue
		}
		if e.Kind != "output" || len(e.Tokens) == 0 {
			continue
		}
		if !layoutSupported(e) {
			ds = append(ds, Diagnostic{Path: s.Path, RuleID: "jinja-layout", Severity: "error", Span: e.Span, Message: "unsupported Jinja layout syntax", Expected: "Review the expression syntax manually; no safe formatting correction is available."})
			continue
		}
		a := layoutAnalysis{source: s, expression: e, newline: "\n"}
		if bytes.Contains(s.Data, []byte("\r\n")) {
			a.newline = "\r\n"
		}
		if s.Position(e.Span.Start).Line == s.Position(e.Span.End-1).Line {
			continue
		}
		a.block, a.base = pureBlock(s, e)
		brace := a.column(e.Span.Start)
		content := a.column(e.Tokens[0].Span.Start)
		conditional := brace
		if a.block {
			a.indent(e.Span.Start, a.base, "align block expression braces with the scalar indentation")
			conditional = a.base
			content = a.base
			if s.Position(e.Span.Start).Line != s.Position(e.Tokens[0].Span.Start).Line {
				content += 2
				conditional = content
				a.indent(e.Tokens[0].Span.Start, content, "indent block expression content two spaces past the braces")
			}
		} else if a.lineStart(e.Tokens[0].Span.Start) {
			conditional = content
		}
		a.region(0, len(e.Tokens), content, conditional, false)
		close := e.closing.Start
		last := e.Tokens[len(e.Tokens)-1].Span.End
		if a.block {
			if a.lineStart(close) {
				a.indent(close, a.base, "align closing braces with opening braces")
			}
		} else if s.Position(last-1).Line != s.Position(close).Line {
			a.gap(last, close, " ", "keep closing braces beside the final expression token")
		}
		ds = append(ds, a.diagnostics...)
		edits = append(edits, a.edits...)
	}
	return ds, edits
}
func pureBlock(s *Source, e Expression) (bool, int) {
	n := e.node
	if n == nil || (n.Style != "literal" && n.Style != "folded") {
		return false, 0
	}
	if strings.TrimSpace(n.Value) != strings.TrimSpace(e.text) {
		return false, 0
	}
	start := bytes.LastIndexByte(s.Data[:n.Span.Start], '\n') + 1
	indent := 0
	for start+indent < len(s.Data) && s.Data[start+indent] == ' ' {
		indent++
	}
	// A sequence marker contributes to the mapping's indentation.
	if bytes.HasPrefix(s.Data[start+indent:], []byte("- ")) {
		indent += 2
	}
	increment := 2
	headerEnd := bytes.IndexByte(s.Data[n.Span.Start:n.Span.End], '\n')
	if headerEnd >= 0 {
		header := s.Data[n.Span.Start : n.Span.Start+headerEnd]
		marker := scalarSyntaxStart(string(header))
		if marker < len(header) && (header[marker] == '|' || header[marker] == '>') {
			for _, c := range header[marker+1:] {
				if c >= '1' && c <= '9' {
					increment = int(c - '0')
					break
				}
				if c != '+' && c != '-' {
					break
				}
			}
		}
	}
	return true, indent + increment
}
func (a *layoutAnalysis) column(pos int) int { return a.source.Position(pos).Column - 1 }
func (a *layoutAnalysis) lineStart(pos int) bool {
	start := bytes.LastIndexByte(a.source.Data[:pos], '\n') + 1
	return len(bytes.TrimSpace(a.source.Data[start:pos])) == 0
}
func (a *layoutAnalysis) indent(pos, col int, hint string) {
	if !a.lineStart(pos) {
		return
	}
	start := bytes.LastIndexByte(a.source.Data[:pos], '\n') + 1
	a.gap(start, pos, strings.Repeat(" ", max(0, col)), hint)
}
func (a *layoutAnalysis) gap(start, end int, want, hint string) {
	if start > end || start < 0 || end > len(a.source.Data) {
		return
	}
	old := string(a.source.Data[start:end])
	if old == want {
		return
	}
	for i := range len(old) {
		if !space(old[i]) {
			return
		}
	}
	a.edits = append(a.edits, Edit{Span: Span{start, end}, Text: want})
	a.diagnostics = append(a.diagnostics, Diagnostic{Path: a.source.Path, RuleID: "jinja-layout", Severity: "error", Span: Span{end, end}, Message: hint, Expected: hint + "."})
}
func (a *layoutAnalysis) breakBefore(i, col int, hint string) {
	ts := a.expression.Tokens
	if i == 0 {
		return
	}
	a.gap(ts[i-1].Span.End, ts[i].Span.Start, a.newline+strings.Repeat(" ", max(0, col)), hint)
}

// region owns one conditional branch or argument. Delimiters introduce child
// regions; else branches establish their own anchor and cannot leak past a close.
func (a *layoutAnalysis) region(lo, hi, content, conditional int, force bool) {
	ts := a.expression.Tokens
	if lo >= hi {
		return
	}
	depth := 0
	firstIf, firstElse := -1, -1
	comprehension := false
	for i := lo; i < hi; i++ {
		v := ts[i].Text
		if depth == 0 && ts[i].Kind == "name" {
			if v == "for" {
				comprehension = true
			}
			if v == "if" && firstIf < 0 {
				firstIf = i
			}
			if v == "else" && firstIf >= 0 {
				firstElse = i
				break
			}
		}
		if v == "(" || v == "[" || v == "{" {
			depth++
		}
		if v == ")" || v == "]" || v == "}" {
			depth--
		}
	}
	multiline := a.source.Position(ts[lo].Span.Start).Line != a.source.Position(ts[hi-1].Span.End-1).Line
	if firstIf >= 0 && firstElse > firstIf && !comprehension {
		wrap := multiline || force
		if wrap {
			a.breakBefore(firstIf, conditional, "align conditional if with its owning expression")
			a.breakBefore(firstElse, conditional, "align conditional else with its owning if")
		}
		a.region(lo, firstIf, content, conditional, false)
		a.region(firstIf+1, firstElse, conditional+3, conditional+3, false)
		branch := a.column(ts[firstElse].Span.Start) + 5
		if wrap {
			branch = conditional + 5
		}
		a.region(firstElse+1, hi, branch, branch, wrap)
		return
	}
	for i := lo; i < hi; i++ {
		v := ts[i].Text
		if a.lineStart(ts[i].Span.Start) {
			if v == "|" || v == "+" {
				a.indent(ts[i].Span.Start, content, "align continuation operator with its expression content")
			}
		}
		if v != "(" && v != "[" && v != "{" {
			continue
		}
		close := balancedEnd(ts, i, hi)
		if close < 0 {
			continue
		}
		function := i > lo && ((ts[i-1].Kind == "name" && !jinjaKeyword(ts[i-1].Text)) || ts[i-1].Text == ")" || ts[i-1].Text == "]")
		inner := a.column(ts[i].Span.Start) + 1
		if a.block && function {
			inner = a.column(ts[i-1].Span.Start) + 2
		}
		if v == "{" && i+1 < close {
			inner = a.column(ts[i+1].Span.Start)
		}
		wrapped := a.source.Position(ts[i].Span.Start).Line != a.source.Position(ts[close].Span.Start).Line
		lookup := function && ts[i-1].Text == "lookup" && wrapped
		parts := argumentRanges(ts, i+1, close)
		for p, part := range parts {
			x, y := part.Start, part.End
			if x == y {
				continue
			}
			if lookup {
				if p == 0 {
					a.gap(ts[i].Span.End, ts[x].Span.Start, "", "keep the first lookup argument beside lookup(")
				}
				if p > 0 {
					a.breakBefore(x, inner, "put each later lookup argument on the immediately following aligned line")
				}
			} else if function || v == "{" || a.block {
				a.indent(ts[x].Span.Start, inner, "align argument or dictionary entry with its content anchor")
			}
			start, anchor := x, inner
			if x+2 < y && (ts[x+1].Text == "=" || ts[x+1].Text == ":") {
				start = x + 2
				anchor = a.column(ts[start].Span.Start)
			}
			a.region(start, y, anchor, anchor, false)
		}
		if a.block && a.lineStart(ts[close].Span.Start) && v == "(" {
			start := bytes.LastIndexByte(a.source.Data[:ts[i].Span.Start], '\n') + 1
			indent := 0
			for start+indent < len(a.source.Data) && a.source.Data[start+indent] == ' ' {
				indent++
			}
			a.indent(ts[close].Span.Start, indent, "align the closing parenthesis with its opening line")
		}
		i = close
	}
}
func balancedEnd(ts []Token, start, end int) int {
	depth := 0
	for i := start; i < end; i++ {
		v := ts[i].Text
		if v == "(" || v == "[" || v == "{" {
			depth++
		}
		if v == ")" || v == "]" || v == "}" {
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}
func argumentRanges(ts []Token, start, end int) []Span {
	var out []Span
	lo := start
	for i := start; i < end; i++ {
		v := ts[i].Text
		if v == "(" || v == "[" || v == "{" {
			j := balancedEnd(ts, i, end)
			if j < 0 {
				break
			}
			i = j
			continue
		}
		if v == "," {
			out = append(out, Span{lo, i})
			lo = i + 1
		}
	}
	if lo < end {
		out = append(out, Span{lo, end})
	}
	return out
}
func checkLayout(_ *Project, s *Source) []Diagnostic {
	ds, _ := layoutFindings(s)
	if len(ds) == 0 {
		return nil
	}
	candidate := s
	for range 24 {
		_, edits := layoutFindings(candidate)
		if len(edits) == 0 {
			break
		}
		normalized, err := orderedEdits(edits)
		if err != nil {
			return ds
		}
		data := applyEdits(candidate.Data, normalized)
		next, errors := Parse(s.Path, data)
		if len(errors) > 0 {
			return ds
		}
		candidate = next
	}
	_, remaining := layoutFindings(candidate)
	if len(remaining) > 0 || bytes.Equal(s.Data, candidate.Data) {
		return ds
	}
	edits, ok := whitespaceChanges(s.Data, candidate.Data)
	if !ok {
		return ds
	}
	if !verifiedCandidate(s, candidate.Data) {
		return ds
	}
	fix := &Fix{Message: "apply verified Jinja layout corrections", Edits: edits}
	for i := range ds {
		if ds[i].Message != "incomplete Jinja expression" && ds[i].Message != "unsupported Jinja layout syntax" && ds[i].Message != "Jinja source mapping is unavailable" {
			ds[i].Fix = fix
		}
	}
	return ds
}

func orderedEdits(edits []Edit) ([]Edit, error) {
	edits = slices.Clone(edits)
	slices.SortFunc(edits, func(a, b Edit) int {
		if a.Span.Start != b.Span.Start {
			return a.Span.Start - b.Span.Start
		}
		return a.Span.End - b.Span.End
	})
	var result []Edit
	for _, e := range edits {
		if len(result) > 0 {
			last := result[len(result)-1]
			if e == last {
				continue
			}
			if e.Span.Start < last.Span.End || e.Span.Start == last.Span.Start {
				return nil, fmt.Errorf("conflicting edits at byte %d", e.Span.Start)
			}
		}
		result = append(result, e)
	}
	return result, nil
}
func applyEdits(data []byte, edits []Edit) []byte {
	var out []byte
	pos := 0
	for _, e := range edits {
		out = append(out, data[pos:e.Span.Start]...)
		out = append(out, e.Text...)
		pos = e.Span.End
	}
	return append(out, data[pos:]...)
}
func whitespaceChanges(before, after []byte) ([]Edit, bool) {
	var edits []Edit
	i, j := 0, 0
	for i < len(before) || j < len(after) {
		x, y := i, j
		for i < len(before) && space(before[i]) {
			i++
		}
		for j < len(after) && space(after[j]) {
			j++
		}
		if !bytes.Equal(before[x:i], after[y:j]) {
			start, stop, replacement := x, i, after[y:j]
			for start < stop && len(replacement) > 0 && before[start] == replacement[0] {
				start++
				replacement = replacement[1:]
			}
			for start < stop && len(replacement) > 0 && before[stop-1] == replacement[len(replacement)-1] {
				stop--
				replacement = replacement[:len(replacement)-1]
			}
			edits = append(edits, Edit{Span: Span{start, stop}, Text: string(replacement)})
		}
		if i == len(before) || j == len(after) {
			return edits, i == len(before) && j == len(after)
		}
		if before[i] != after[j] {
			return nil, false
		}
		i++
		j++
	}
	return edits, true
}

func jinjaKeyword(name string) bool {
	switch name {
	case "if", "else", "and", "or", "not", "in", "is", "for":
		return true
	}
	return false
}
func layoutSupported(e Expression) bool {
	for _, t := range e.Tokens {
		if t.Kind != "punctuation" {
			continue
		}
		switch t.Text {
		case "(", ")", "[", "]", "{", "}", ".", ",", ":", "|", "+", "-", "*", "/", "//", "%", "**", "~", "=", "==", "!=", "<", ">", "<=", ">=":
		default:
			return false
		}
	}
	return true
}
