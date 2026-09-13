package lint

import (
	"bytes"
	"strconv"
	"strings"
)

func expressionStructuralFixes(s *Source) []structuralFix {
	var fixes []structuralFix
	nodes := whenNodes(s)
	for _, e := range RuntimeExpressions(s) {
		if e.Kind != "implicit" || !e.Complete || !e.mapped || !nodes[e.node] || e.node.Kind != "string" || !undecoratedScalar(s, e.node) {
			continue
		}
		parsed, ok := parseFixExpression(e.Tokens)
		if !ok {
			continue
		}
		span := Span{e.Tokens[0].Span.Start, e.Tokens[len(e.Tokens)-1].Span.End}
		if operands := rootConjunction(e.Tokens); len(operands) > 0 {
			if !parsed.boolean {
				continue
			}
			fix, ok := whenListFix(s, e, operands)
			if ok {
				fixes = append(fixes, fix)
			}
			continue
		}
		if whenConditionGroupedOrRead(e) {
			continue
		}
		trimmed := strings.TrimSpace(e.node.Value)
		expected := strings.Replace(e.node.Value, trimmed, "("+trimmed+")", 1)
		fixes = append(fixes, structuralFix{rule: "ansible-when-parentheses", span: span, node: e.node, value: expected, edits: []Edit{{Span: Span{span.Start, span.Start}, Text: "("}, {Span: Span{span.End, span.End}, Text: ")"}}})
	}
	for _, e := range Expressions(s) {
		if e.Kind != "output" || !e.Complete || !e.mapped || e.node.Tag != "" || e.node.Anchor != "" {
			continue
		}
		inner := stripGrouping(e.Tokens)
		if len(inner) == len(e.Tokens) || conditionalResultTuple(inner) {
			continue
		}
		parsed, ok := parseFixExpression(e.Tokens)
		if !ok || parsed.kind != "conditional" {
			continue
		}
		syntax := inspectRegion(inner, 0, len(inner))
		if syntax.Else < 0 {
			continue
		}
		var edits []Edit
		for i := range (len(e.Tokens) - len(inner)) / 2 {
			edits = append(edits, Edit{Span: e.Tokens[i].Span}, Edit{Span: e.Tokens[len(e.Tokens)-1-i].Span})
		}
		// Derive decoded replacement separately, then independently parse and compare
		// the complete scalar after the source edits have been applied.
		expected := e.node.Value
		decoded := scanExpressions(expected)
		positions, ok := scalarPositions(s, e.node)
		if !ok {
			continue
		}
		var decodedEdits []Edit
		for _, part := range decoded {
			if mapSpan(positions, part.Span) != e.Span {
				continue
			}
			for i := range (len(e.Tokens) - len(inner)) / 2 {
				decodedEdits = append(decodedEdits, Edit{Span: part.Tokens[i].Span}, Edit{Span: part.Tokens[len(part.Tokens)-1-i].Span})
			}
		}
		ordered, err := orderedEdits(decodedEdits)
		if err != nil || len(ordered) == 0 {
			continue
		}
		expected = string(applyEdits([]byte(expected), ordered))
		if !equivalentExpressionScalar(e.node.Value, expected) {
			continue
		}
		fixes = append(fixes, structuralFix{rule: "jinja-redundant-conditional-parentheses", span: e.Tokens[0].Span, node: e.node, value: expected, edits: edits, valueEdits: ordered})
	}
	return fixes
}

func whenListFix(s *Source, e Expression, operands [][]Token) (structuralFix, bool) {
	n := e.node
	if n.Style != "plain" || string(s.Data[n.Span.Start:n.Span.End]) != n.Value {
		return structuralFix{}, false
	}
	start := bytes.LastIndexByte(s.Data[:n.Span.Start], '\n') + 1
	prefix := string(s.Data[start:n.Span.Start])
	indent := prefix[:len(prefix)-len(strings.TrimLeft(prefix, " "))]
	if strings.TrimSpace(prefix) != "when:" {
		return structuralFix{}, false
	}
	end := len(s.Data)
	if next := bytes.IndexByte(s.Data[n.Span.End:], '\n'); next >= 0 {
		end = n.Span.End + next
	}
	if strings.TrimSpace(string(s.Data[n.Span.End:end])) != "" {
		return structuralFix{}, false
	}
	newline := "\n"
	if bytes.Contains(s.Data, []byte("\r\n")) {
		newline = "\r\n"
	}
	var items []string
	var text strings.Builder
	text.WriteString("when:")
	for _, tokens := range operands {
		parsed, ok := parseFixExpression(tokens)
		if !ok || !parsed.boolean {
			return structuralFix{}, false
		}
		value := string(s.Data[tokens[0].Span.Start:tokens[len(tokens)-1].Span.End])
		if len(stripGrouping(tokens)) == len(tokens) {
			value = "(" + value + ")"
		}
		items = append(items, value)
		text.WriteString(newline + indent + "  - " + value)
	}
	return structuralFix{rule: "ansible-when-list", span: Span{e.Tokens[0].Span.Start, e.Tokens[len(e.Tokens)-1].Span.End}, node: n, items: items, edits: []Edit{{Span: Span{start + len(indent), n.Span.End}, Text: text.String()}}}, true
}

func equivalentExpressionScalar(a, b string) bool {
	signature := func(value string) (string, bool) {
		var out strings.Builder
		pos := 0
		for _, e := range scanExpressions(value) {
			if !e.Complete || e.Kind != "output" {
				return "", false
			}
			parsed, ok := parseFixExpression(e.Tokens)
			if !ok {
				return "", false
			}
			out.WriteString(strconv.Quote(value[pos:e.opening.End]))
			out.WriteString(parsed.signature)
			out.WriteString(value[e.closing.Start:e.Span.End])
			pos = e.Span.End
		}
		out.WriteString(strconv.Quote(value[pos:]))
		return out.String(), true
	}
	x, ok := signature(a)
	y, other := signature(b)
	return ok && other && x == y
}
