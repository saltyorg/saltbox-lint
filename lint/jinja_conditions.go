package lint

// regionSyntax describes operator roles at one delimiter depth. If/Else are
// token indices, with -1 for absent operators. Calls contains postfix call
// openings, distinguishing keyword-named callees from boolean grouping.
type regionSyntax struct {
	If, Else int
	Calls    map[int]bool
}

// inspectRegion tracks operand and name-only grammar positions before treating
// an if/else spelling as an operator. Attribute/filter/test names are operands;
// a conditional if can only follow a complete value. Else is optional in Jinja.
// The last if before the first else owns the region: repeated omitted-else
// conditionals associate to the left, while an else value associates to the right.
func inspectRegion(tokens []Token, lo, hi int) regionSyntax {
	syntax := regionSyntax{If: -1, Else: -1, Calls: map[int]bool{}}
	operand, nameOnly, testName := true, false, false
	for i := lo; i < hi; i++ {
		token := tokens[i]
		v := token.Text
		if nameOnly {
			if testName && v == "not" {
				testName = false
				continue
			}
			nameOnly, testName, operand = false, false, false
			continue
		}
		if v == "(" || v == "[" || v == "{" {
			if v == "(" && !operand {
				syntax.Calls[i] = true
			}
			close := balancedEnd(tokens, i, hi)
			if close < 0 {
				return syntax
			}
			i = close
			operand = false
			continue
		}
		if token.Kind == "name" {
			if operand {
				if v != "not" {
					operand = false
				}
				continue
			}
			switch v {
			case "if":
				syntax.If = i
				operand = true
			case "else":
				if syntax.If >= 0 {
					syntax.Else = i
					return syntax
				}
			case "and", "or", "in":
				operand = true
			case "not":
				if i+1 < hi && tokens[i+1].Text == "in" {
					i++
					operand = true
				}
			case "is":
				nameOnly, testName = true, true
			case "for":
				// A comprehension/filter or statement binding is not a conditional
				// expression. Its nested delimited expressions are visited separately.
				syntax.If = -1
				return syntax
			}
			continue
		}
		if token.Kind == "string" || token.Kind == "number" {
			operand = false
			continue
		}
		switch v {
		case ".", "|":
			nameOnly = true
		default:
			operand = true
		}
	}
	return syntax
}

// conditionalOperators visits distinct expression regions rather than searching
// for keyword spellings. Commas, mapping colons and named-argument equals signs
// separate regions; nested delimiters retain their own conditional ownership.
// Results include omitted-else conditionals and identify the actual if token.
func conditionalOperators(tokens []Token) []int {
	var result []int
	var visit func(int, int)
	visit = func(lo, hi int) {
		if lo >= hi {
			return
		}
		start := lo
		for i := lo; i < hi; i++ {
			v := tokens[i].Text
			if v == "(" || v == "[" || v == "{" {
				close := balancedEnd(tokens, i, hi)
				if close < 0 {
					return
				}
				i = close
				continue
			}
			if v == "," || v == ":" || v == "=" {
				visit(start, i)
				start = i + 1
			}
		}
		if start != lo {
			visit(start, hi)
			return
		}
		syntax := inspectRegion(tokens, lo, hi)
		if syntax.If >= 0 {
			result = append(result, syntax.If)
			visit(lo, syntax.If)
			end := hi
			if syntax.Else >= 0 {
				end = syntax.Else
			}
			visit(syntax.If+1, end)
			if syntax.Else >= 0 {
				visit(syntax.Else+1, hi)
			}
			return
		}
		for i := lo; i < hi; i++ {
			v := tokens[i].Text
			if v == "(" || v == "[" || v == "{" {
				close := balancedEnd(tokens, i, hi)
				if close < 0 {
					return
				}
				visit(i+1, close)
				i = close
			}
		}
	}
	visit(0, len(tokens))
	return result
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
