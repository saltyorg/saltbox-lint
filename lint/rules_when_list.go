package lint

import (
	"bytes"
	"strings"

	"github.com/goccy/go-yaml"
)

// rootConjunction returns ordered indivisible operands only for unparenthesized
// top-level and. Explicit groups stay intact, as do conjunctions beneath or,
// conditional branches, call arguments, or operands of higher-precedence uses.
func rootConjunction(tokens []Token) [][]Token {
	if conditionalResultTuple(tokens) {
		return nil
	}
	syntax := inspectRegion(tokens, 0, len(tokens))
	if syntax.If >= 0 || syntax.Or || len(syntax.And) == 0 {
		return nil
	}
	var operands [][]Token
	start := 0
	for _, end := range append(syntax.And, len(tokens)) {
		if start == end {
			return nil
		}
		operands = append(operands, tokens[start:end])
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
		d := ansibleDiagnostic(s, "ansible-when-list", span, "when conjunction needs separate block-list items", whenListHint(e))
		d.Preview = whenListPreview(s, e)
		ds = append(ds, d)
	}
	return ds
}

func whenListData(e Expression) ([]byte, error) {
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
	return yaml.MarshalWithOptions(map[string][]string{"when": items}, yaml.Indent(2), yaml.IndentSequence(true))
}

func whenListHint(e Expression) string {
	data, err := whenListData(e)
	if err != nil {
		// The encoder receives only strings, never user-defined marshal methods.
		return "Use separate block-list items for the conjunction operands, preserving order and enclosing nontrivial conditions in parentheses."
	}
	return "Use these items in the when block list, preserving any other items:\n" + strings.TrimSuffix(string(data), "\n")
}

// Only a standalone plain when scalar has an unambiguous field-to-list edit.
// List items, flow mappings, decorated/quoted/block scalars and inline comments
// retain the illustrative Expected guidance without a fabricated patch.
func whenListPreview(s *Source, e Expression) *Preview {
	n := e.node
	if !e.mapped || !undecoratedScalar(s, n) || n.Style != "plain" || string(s.Data[n.Span.Start:n.Span.End]) != n.Value {
		return nil
	}
	start := bytes.LastIndexByte(s.Data[:n.Span.Start], '\n') + 1
	prefix := string(s.Data[start:n.Span.Start])
	indent := prefix[:len(prefix)-len(strings.TrimLeft(prefix, " "))]
	if strings.TrimSpace(prefix) != "when:" {
		return nil
	}
	end := len(s.Data)
	if next := bytes.IndexByte(s.Data[n.Span.End:], '\n'); next >= 0 {
		end = n.Span.End + next
	}
	if strings.TrimSpace(string(s.Data[n.Span.End:end])) != "" {
		return nil
	}
	newline := "\n"
	if end < len(s.Data) && end > 0 && s.Data[end-1] == '\r' || end == len(s.Data) && bytes.Contains(s.Data, []byte("\r\n")) {
		newline = "\r\n"
	}
	data, err := whenListData(e)
	if err != nil {
		return nil
	}
	replacement := strings.TrimSuffix(string(data), "\n")
	replacement = strings.ReplaceAll(replacement, "\n", newline+indent)
	return editPreview(Span{start + len(indent), n.Span.End}, replacement)
}
