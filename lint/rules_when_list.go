package lint

import (
	"strings"

	"github.com/goccy/go-yaml"
)

// rootConjunction returns ordered indivisible operands only when and is the
// root operation. Inspect each delimiter depth without distributing into or,
// conditional branches, call arguments, or operands of higher-precedence uses.
// Retain the original groups on leaves; only conjunction groups are removed.
func rootConjunction(tokens []Token) [][]Token {
	ungrouped := stripGrouping(tokens)
	if conditionalResultTuple(ungrouped) {
		return nil
	}
	syntax := inspectRegion(ungrouped, 0, len(ungrouped))
	if syntax.If >= 0 || syntax.Or || len(syntax.And) == 0 {
		return nil
	}
	var operands [][]Token
	start := 0
	for _, end := range append(syntax.And, len(ungrouped)) {
		if start == end {
			return nil
		}
		operand := ungrouped[start:end]
		nested := rootConjunction(operand)
		if len(nested) > 0 {
			operands = append(operands, nested...)
		} else {
			operands = append(operands, operand)
		}
		start = end + 1
	}
	return operands
}

func checkWhenList(_ *Project, s *Source) []Diagnostic {
	nodes := whenNodes(s)
	var ds []Diagnostic
	for _, e := range RuntimeExpressions(s) {
		kind, _ := EffectiveScalar(e.node)
		if e.Kind != "implicit" || !e.Complete || !nodes[e.node] || kind != "string" || len(rootConjunction(e.Tokens)) == 0 {
			continue
		}
		span := Span{e.Tokens[0].Span.Start, e.Tokens[len(e.Tokens)-1].Span.End}
		ds = append(ds, ansibleDiagnostic(s, "ansible-when-list", span, "when conjunction needs separate block-list items", whenListHint(e)))
	}
	return ds
}

func whenListHint(e Expression) string {
	// Reuse the lexer on decoded text for slicing: the original token spans map
	// to YAML source bytes, which may contain escapes, folding and indentation.
	decoded := "{{ " + e.text + " }}"
	expression := scanExpressions(decoded)[0]
	var items []string
	for _, tokens := range rootConjunction(expression.Tokens) {
		value := decoded[tokens[0].Span.Start:tokens[len(tokens)-1].Span.End]
		item := Expression{Kind: "implicit", Complete: true, Tokens: tokens}
		if !whenConditionGroupedOrRead(item) {
			value = "(" + value + ")"
		}
		items = append(items, value)
	}
	data, err := yaml.MarshalWithOptions(map[string][]string{"when": items}, yaml.Indent(2), yaml.IndentSequence(true))
	if err != nil {
		// The encoder receives only strings, never user-defined marshal methods.
		return "Use separate block-list items for the conjunction operands, preserving order and enclosing nontrivial conditions in parentheses."
	}
	return "Use these items in the when block list, preserving any other items:\n" + strings.TrimSuffix(string(data), "\n")
}
