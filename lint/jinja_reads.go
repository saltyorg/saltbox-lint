package lint

import "slices"

// VariableReads returns lexical variable-read tokens from one complete Jinja
// tag, in source order. It excludes attribute/filter/test names, callees,
// keyword labels, and statement binding positions, but includes macro-default
// expressions and block-set filter arguments. It does not resolve values or
// track bindings across separate tags.
func VariableReads(expression Expression) []Token {
	if !expression.Complete {
		return nil
	}
	tokens := expression.Tokens
	bindings := statementBindings(expression)
	var reads []Token
	for index, token := range tokens {
		if token.Kind != "name" || bindings[index] || jinjaReadKeyword(token.Text) {
			continue
		}
		if index > 0 && slices.Contains([]string{".", "|", "is", "as"}, tokens[index-1].Text) {
			continue
		}
		if index > 1 && tokens[index-1].Text == "not" && tokens[index-2].Text == "is" {
			continue
		}
		if index+1 < len(tokens) && slices.Contains([]string{"(", "="}, tokens[index+1].Text) {
			continue
		}
		reads = append(reads, token)
	}
	return reads
}

func jinjaReadKeyword(name string) bool {
	switch name {
	case "and", "or", "not", "in", "is", "as", "if", "else", "for", "true", "false", "none", "True", "False", "None":
		return true
	default:
		return false
	}
}

func statementBindings(expression Expression) map[int]bool {
	bindings := make(map[int]bool)
	tokens := expression.Tokens
	if expression.Kind != "statement" || len(tokens) == 0 {
		return bindings
	}
	bindings[0] = true
	markUntil := func(start int, stops ...string) {
		for index := start; index < len(tokens) && !slices.Contains(stops, tokens[index].Text); index++ {
			bindings[index] = true
		}
	}
	switch tokens[0].Text {
	case "set":
		markUntil(1, "=", "|")
	case "for":
		markUntil(1, "in")
	case "from":
		for index, token := range tokens {
			if token.Text == "import" {
				markUntil(index, "")
				break
			}
		}
	case "filter":
		bindings[1] = true
	case "macro":
		bindings[1] = true
		if len(tokens) > 2 && tokens[2].Text == "(" {
			markParameterBindings(tokens, 2, bindings)
		}
	case "call":
		if len(tokens) > 1 && tokens[1].Text == "(" {
			markParameterBindings(tokens, 1, bindings)
		}
	}
	return bindings
}

// Parameter labels precede the first equals sign in each top-level parameter
// segment. Nested default calls/collections remain expressions, not bindings.
func markParameterBindings(tokens []Token, open int, bindings map[int]bool) {
	close := balancedEnd(tokens, open, len(tokens))
	if close < 0 {
		return
	}
	inDefault := false
	for index := open + 1; index < close; index++ {
		token := tokens[index]
		switch token.Text {
		case "=":
			inDefault = true
		case ",":
			inDefault = false
		case "(", "[", "{":
			end := balancedEnd(tokens, index, close)
			if end < 0 {
				return
			}
			if !inDefault {
				for binding := index; binding <= end; binding++ {
					bindings[binding] = true
				}
			}
			index = end
		default:
			if !inDefault {
				bindings[index] = true
			}
		}
	}
}
