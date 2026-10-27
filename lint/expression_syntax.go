package lint

import (
	"slices"
	"strconv"
	"strings"
)

// parsedExpression is the deliberately bounded grammar used by structural fixes.
// Its signature ignores grouping, but preserves precedence, token spellings and
// every operation. Unsupported syntax fails closed; the diagnostic lexer remains
// independent and can still explain expressions outside this subset.
type parsedExpression struct {
	signature string
	boolean   bool
	kind      string
}
type expressionParser struct {
	tokens         []Token
	pos            int
	invalid        bool
	templateSyntax bool
}

func parseFixExpression(tokens []Token) (parsedExpression, bool) {
	p := expressionParser{tokens: tokens}
	result := p.conditional()
	return result, !p.invalid && p.pos == len(tokens) && len(tokens) > 0
}
func expressionTree(kind string, boolean bool, children ...parsedExpression) parsedExpression {
	var b strings.Builder
	b.WriteString(strconv.Quote(kind))
	b.WriteByte('(')
	for _, child := range children {
		b.WriteString(child.signature)
		b.WriteByte(',')
	}
	b.WriteByte(')')
	return parsedExpression{signature: b.String(), boolean: boolean, kind: kind}
}
func (p *expressionParser) take(text string) bool {
	if p.pos < len(p.tokens) && p.tokens[p.pos].Text == text {
		p.pos++
		return true
	}
	return false
}
func (p *expressionParser) conditional() parsedExpression {
	result := p.binary(0)
	for p.take("if") {
		test := p.binary(0)
		if p.take("else") {
			return expressionTree("conditional", false, result, test, p.conditional())
		}
		result = expressionTree("conditional", false, result, test)
	}
	return result
}
func (p *expressionParser) binary(level int) parsedExpression {
	if level == 2 {
		if p.take("not") {
			return expressionTree("not", true, p.binary(2))
		}
		return p.compare()
	}
	op := "or"
	if level == 1 {
		op = "and"
	}
	left := p.binary(level + 1)
	for p.take(op) {
		right := p.binary(level + 1)
		left = expressionTree(op, left.boolean && right.boolean, left, right)
	}
	return left
}
func (p *expressionParser) compare() parsedExpression {
	left := p.operand()
	var operands []parsedExpression
	var ops strings.Builder
	for p.pos < len(p.tokens) {
		op := p.tokens[p.pos].Text
		switch op {
		case "==", "!=", "<", ">", "<=", ">=", "in":
			p.pos++
		case "not":
			if p.pos+1 >= len(p.tokens) || p.tokens[p.pos+1].Text != "in" {
				return comparisonTree(left, operands, ops.String())
			}
			p.pos += 2
			op = "not in"
		default:
			return comparisonTree(left, operands, ops.String())
		}
		ops.WriteString(op)
		ops.WriteByte(';')
		operands = append(operands, p.operand())
	}
	return comparisonTree(left, operands, ops.String())
}

// templateArithmetic lists Jinja's arithmetic and concatenation levels from
// loosest to tightest binding. Jinja's ** is also left-associative but binds
// tighter than unary signs only on its right, so it has its own level.
var templateArithmetic = [][]string{{"+", "-"}, {"~"}, {"*", "/", "//", "%"}}

// operand parses a comparison operand. Template checks accept Jinja arithmetic
// and concatenation; fix expressions keep the narrower grammar, so structural
// fixes still decline expressions that contain these operators.
func (p *expressionParser) operand() parsedExpression {
	if !p.templateSyntax {
		return p.value()
	}
	return p.arithmetic(0)
}
func (p *expressionParser) arithmetic(level int) parsedExpression {
	if level == len(templateArithmetic) {
		return p.power()
	}
	left := p.arithmetic(level + 1)
	for p.pos < len(p.tokens) && p.tokens[p.pos].Kind == "punctuation" && slices.Contains(templateArithmetic[level], p.tokens[p.pos].Text) {
		op := p.tokens[p.pos].Text
		p.pos++
		left = expressionTree("arithmetic:"+op, false, left, p.arithmetic(level+1))
	}
	return left
}
func (p *expressionParser) power() parsedExpression {
	left := p.unary()
	for p.pos < len(p.tokens) && p.tokens[p.pos].Kind == "punctuation" && p.tokens[p.pos].Text == "**" {
		p.pos++
		left = expressionTree("arithmetic:**", false, left, p.unary())
	}
	return left
}

// unary accepts only negation. A leading + stays outside the subset because
// Jinja reads "{{+" as a whitespace-control modifier, not as unary plus.
func (p *expressionParser) unary() parsedExpression {
	if p.pos < len(p.tokens) && p.tokens[p.pos].Kind == "punctuation" && p.tokens[p.pos].Text == "-" {
		p.pos++
		return expressionTree("unary:-", false, p.unary())
	}
	return p.value()
}
func comparisonTree(left parsedExpression, operands []parsedExpression, ops string) parsedExpression {
	if len(operands) == 0 {
		return left
	}
	return expressionTree("compare:"+ops, true, append([]parsedExpression{left}, operands...)...)
}
func (p *expressionParser) value() parsedExpression {
	result := p.atom()
	filtered := false
	for p.pos < len(p.tokens) {
		switch p.tokens[p.pos].Text {
		case ".":
			if p.templateSyntax && filtered {
				p.invalid = true
				return result
			}
			p.pos++
			name, ok := p.name()
			if !ok {
				p.invalid = true
				return result
			}
			result = expressionTree("attribute:"+name, false, result)
		case "[":
			if p.templateSyntax && filtered {
				p.invalid = true
				return result
			}
			p.pos++
			key := p.conditional()
			if !p.take("]") {
				p.invalid = true
			}
			result = expressionTree("item", false, result, key)
		case "(":
			result = expressionTree("call", false, append([]parsedExpression{result}, p.arguments()...)...)
		case "|":
			filtered = true
			p.pos++
			name, ok := p.name()
			if !ok {
				p.invalid = true
				return result
			}
			var args []parsedExpression
			if p.pos < len(p.tokens) && p.tokens[p.pos].Text == "(" {
				args = p.arguments()
			}
			result = expressionTree("filter:"+name, false, append([]parsedExpression{result}, args...)...)
		case "is":
			filtered = true
			p.pos++
			negated := p.take("not")
			name, ok := p.name()
			if !ok {
				p.invalid = true
				return result
			}
			var args []parsedExpression
			if p.pos < len(p.tokens) && p.tokens[p.pos].Text == "(" {
				args = p.arguments()
			}
			// Only zero-argument built-ins whose return contract is boolean qualify.
			boolean := len(args) == 0 && (name == "defined" || name == "undefined" || name == "none" || name == "boolean" || name == "true" || name == "false" || name == "string" || name == "number" || name == "integer" || name == "float" || name == "mapping" || name == "sequence" || name == "iterable")
			if negated {
				name = "not " + name
			}
			result = expressionTree("test:"+name, boolean, append([]parsedExpression{result}, args...)...)
			if p.pos < len(p.tokens) && p.tokens[p.pos].Text == "is" {
				p.invalid = true
				return result
			}
		default:
			return result
		}
	}
	return result
}
func (p *expressionParser) name() (string, bool) {
	if p.pos >= len(p.tokens) || p.tokens[p.pos].Kind != "name" {
		return "", false
	}
	name := p.tokens[p.pos].Text
	p.pos++
	for p.take(".") {
		if p.pos >= len(p.tokens) || p.tokens[p.pos].Kind != "name" {
			return "", false
		}
		name += "." + p.tokens[p.pos].Text
		p.pos++
	}
	return name, true
}
func (p *expressionParser) atom() parsedExpression {
	if p.pos >= len(p.tokens) {
		p.invalid = true
		return parsedExpression{}
	}
	token := p.tokens[p.pos]
	p.pos++
	if token.Text == "(" {
		value := p.conditional()
		if !p.take(")") {
			p.invalid = true
		}
		return value
	}
	if p.templateSyntax && token.Kind == "punctuation" && (token.Text == "[" || token.Text == "{") {
		return p.collection(token.Text)
	}
	switch token.Kind {
	case "name":
		switch token.Text {
		case "and", "or", "not", "if", "else", "is", "in", "for":
			p.invalid = true
		}
		return expressionTree("name:"+token.Text, token.Text == "true" || token.Text == "false" || token.Text == "True" || token.Text == "False")
	case "string", "number":
		return expressionTree(token.Kind+":"+token.Text, false)
	default:
		p.invalid = true
		return parsedExpression{}
	}
}

// collection parses a Jinja list or dict literal after its opening bracket.
// Items are full expressions; a trailing comma is allowed as in Jinja.
func (p *expressionParser) collection(open string) parsedExpression {
	closing, kind := "]", "list"
	if open == "{" {
		closing, kind = "}", "dict"
	}
	var items []parsedExpression
	for !p.take(closing) {
		if p.invalid || p.pos >= len(p.tokens) {
			p.invalid = true
			return parsedExpression{}
		}
		if len(items) > 0 && !p.take(",") {
			p.invalid = true
			return parsedExpression{}
		}
		if p.take(closing) {
			break
		}
		item := p.conditional()
		if kind == "dict" {
			if !p.take(":") {
				p.invalid = true
				return parsedExpression{}
			}
			item = expressionTree("pair", false, item, p.conditional())
		}
		items = append(items, item)
	}
	return expressionTree(kind, false, items...)
}
func (p *expressionParser) arguments() []parsedExpression {
	if !p.take("(") {
		p.invalid = true
		return nil
	}
	var args []parsedExpression
	if p.take(")") {
		return args
	}
	keywords := map[string]bool{}
	for !p.invalid {
		key := ""
		if p.pos+1 < len(p.tokens) && p.tokens[p.pos].Kind == "name" && p.tokens[p.pos+1].Text == "=" {
			key = p.tokens[p.pos].Text
			p.pos += 2
		}
		if key != "" {
			if keywords[key] {
				p.invalid = true
				return args
			}
			keywords[key] = true
		} else if len(keywords) > 0 {
			p.invalid = true
			return args
		}
		value := p.conditional()
		args = append(args, expressionTree("argument:"+key, false, value))
		if p.take(")") {
			return args
		}
		if !p.take(",") {
			p.invalid = true
			return args
		}
		if p.take(")") {
			return args
		}
	}
	return args
}
