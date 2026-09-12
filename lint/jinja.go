package lint

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Token contains YAML-decoded Jinja text and its exact original source span.
// Kinds are name, number, string, and punctuation. Whitespace is not a token.
type Token struct {
	Kind, Text string
	Span       Span
}

// Expression spans include opening and closing delimiters. Incomplete expressions
// are available for diagnostics but cannot support edits or call analysis.
type Expression struct {
	Kind             string
	Span             Span
	Tokens           []Token
	Complete         bool
	node             *Node
	text             string
	mapped           bool
	opening, closing Span
}
type Argument struct {
	Name   string
	Tokens []Token
}
type Call struct {
	Name      string
	Span      Span
	Arguments []Argument
}

type indexedExpression struct {
	order      int
	expression Expression
}

type expressionIndex map[*Node][]indexedExpression

func newExpressionIndex(source *Source) expressionIndex {
	expressions := Expressions(source)
	if len(expressions) == 0 {
		return nil
	}
	index := make(expressionIndex)
	for order, expression := range expressions {
		index[expression.node] = append(index[expression.node], indexedExpression{order: order, expression: expression})
	}
	return index
}

// Expressions scans parsed scalar values, never YAML comments or unsafe values.
// Statement tags remain distinct from output expressions for policy consumers.
func Expressions(source *Source) []Expression {
	return expressionsMatching(source, nil)
}

// Filtering precedes scanning, while traversal from the source documents still
// enforces source membership and unsafe ancestors. Nil includes every scalar.
func expressionsMatching(source *Source, include func(*Node) bool) []Expression {
	if source == nil || len(source.parseDiagnostics) > 0 {
		return nil
	}
	var out []Expression
	var walk func(*Node)
	walk = func(n *Node) {
		if n == nil || n.Tag == "!unsafe" {
			return
		}
		if n.Kind == "string" && (include == nil || include(n)) {
			expressions := scanExpressions(n.Value)
			var spans []Span
			var ok bool
			if len(expressions) > 0 {
				spans, ok = scalarPositions(source, n)
			}
			for _, e := range expressions {
				e.node = n
				e.mapped = ok
				if ok {
					e.Span = mapSpan(spans, e.Span)
					e.opening = mapSpan(spans, e.opening)
					if e.Complete {
						e.closing = mapSpan(spans, e.closing)
					}
					for i := range e.Tokens {
						e.Tokens[i].Span = mapSpan(spans, e.Tokens[i].Span)
					}
				} else {
					e.Span = n.Span
					e.Complete = false
					e.Tokens = nil
				}
				out = append(out, e)
			}
		}
		for _, e := range n.Entries {
			walk(e.Key)
			walk(e.Value)
		}
		for _, i := range n.Items {
			walk(i)
		}
	}
	for _, n := range source.Documents {
		walk(n)
	}
	return out
}

func mapSpan(positions []Span, s Span) Span {
	if s.Start >= len(positions) || s.End <= s.Start {
		return Span{}
	}
	return Span{positions[s.Start].Start, positions[s.End-1].End}
}

// scalarPositions aligns decoded YAML bytes to independently decoded source units.
// Only YAML whitespace folding may differ. No parser-library byte offsets or
// searches for repeated token spellings are used to guess a token location.
func scalarPositions(s *Source, n *Node) ([]Span, bool) {
	raw := string(s.Data[n.Span.Start:n.Span.End])
	start := 0
	end := len(raw)
	start = scalarSyntaxStart(raw)
	switch n.Style {
	case "single-quoted", "double-quoted":
		if end-start < 2 {
			return nil, false
		}
		start++
		end--
	case "literal", "folded":
		i := strings.IndexByte(raw[start:], '\n')
		if i < 0 {
			return nil, false
		}
		start += i + 1
	}
	var decoded strings.Builder
	var positions []Span
	for i := start; i < end; {
		j := i + 1
		v := raw[i:j]
		if n.Style == "single-quoted" && raw[i] == '\'' && j < end && raw[j] == '\'' {
			j++
			v = "'"
		}
		if n.Style == "double-quoted" && raw[i] == '\\' {
			if j >= end {
				return nil, false
			}
			j++
			c := raw[i+1]
			switch c {
			case '\n':
				i = j
				for i < end && (raw[i] == ' ' || raw[i] == '\t') {
					i++
				}
				continue
			case '\r':
				if j < end && raw[j] == '\n' {
					j++
				}
				i = j
				for i < end && (raw[i] == ' ' || raw[i] == '\t') {
					i++
				}
				continue
			case 'x', 'u', 'U':
				count := 2
				if c == 'u' {
					count = 4
				}
				if c == 'U' {
					count = 8
				}
				j += count
				if j > end {
					return nil, false
				}
				code, err := strconv.ParseUint(raw[i+2:j], 16, 32)
				if err != nil || !utf8.ValidRune(rune(code)) {
					return nil, false
				}
				v = string(rune(code))
			default:
				escapes := map[byte]string{'0': "\x00", 'a': "\a", 'b': "\b", 't': "\t", 'n': "\n", 'v': "\v", 'f': "\f", 'r': "\r", 'e': "\x1b", ' ': " ", '"': "\"", '/': "/", '\\': "\\", 'N': "\u0085", '_': "\u00a0", 'L': "\u2028", 'P': "\u2029"}
				var found bool
				v, found = escapes[c]
				if !found {
					return nil, false
				}
			}
		}
		decoded.WriteString(v)
		for range len(v) {
			positions = append(positions, Span{n.Span.Start + i, n.Span.Start + j})
		}
		i = j
	}
	// YAML folding and indentation only affect whitespace runs. Keep decoded
	// whitespace authoritative, mapping each such run to its complete source run.
	d := decoded.String()
	value := n.Value
	result := make([]Span, 0, len(value))
	i, j := 0, 0
	for j < len(value) {
		if space(value[j]) {
			vs := j
			for j < len(value) && space(value[j]) {
				j++
			}
			ds := i
			for i < len(d) && space(d[i]) {
				i++
			}
			if ds == i {
				return nil, false
			}
			p := Span{positions[ds].Start, positions[i-1].End}
			for range j - vs {
				result = append(result, p)
			}
			continue
		}
		for i < len(d) && space(d[i]) {
			i++
		}
		if i >= len(d) || d[i] != value[j] {
			return nil, false
		}
		result = append(result, positions[i])
		i++
		j++
	}
	for i < len(d) && space(d[i]) {
		i++
	}
	return result, i == len(d)
}
func space(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func scanExpressions(text string) []Expression {
	var out []Expression
	for i := 0; i+1 < len(text); {
		if text[i] != '{' || !strings.ContainsRune("{%#", rune(text[i+1])) {
			i++
			continue
		}
		start := i
		marker := text[i : i+2]
		i += 2
		if marker == "{#" {
			end := strings.Index(text[i:], "#}")
			if end < 0 {
				break
			}
			i += end + 2
			continue
		}
		kind, close := "output", "}}"
		if marker == "{%" {
			kind, close = "statement", "%}"
		}
		if i < len(text) && (text[i] == '-' || text[i] == '+') {
			i++
		}
		opening := Span{start, i}
		var closing Span
		var tokens []Token
		var stack []byte
		complete := false
		for i < len(text) {
			if len(stack) == 0 && (strings.HasPrefix(text[i:], close) || ((text[i] == '-' || text[i] == '+') && strings.HasPrefix(text[i+1:], close))) {
				closing.Start = i
				if text[i] == '-' || text[i] == '+' {
					i++
				}
				i += 2
				closing.End = i
				complete = true
				break
			}
			if space(text[i]) {
				i++
				continue
			}
			a := i
			k := "punctuation"
			if text[i] == '\'' || text[i] == '"' {
				k = "string"
				quote := text[i]
				i++
				closed := false
				for i < len(text) {
					if text[i] == '\\' {
						i += min(2, len(text)-i)
						continue
					}
					if text[i] == quote {
						i++
						closed = true
						break
					}
					i++
				}
				if !closed {
					tokens = append(tokens, Token{k, text[a:i], Span{a, i}})
					break
				}
			} else if r, _ := utf8.DecodeRuneInString(text[i:]); unicode.IsLetter(r) || r == '_' {
				k = "name"
				for i < len(text) {
					r, size := utf8.DecodeRuneInString(text[i:])
					if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
						break
					}
					i += size
				}
			} else if text[i] >= '0' && text[i] <= '9' {
				k = "number"
				match := ""
				if i == 0 || text[i-1] != '.' {
					match = jinjaFloat.FindString(text[i:])
				}
				if match == "" {
					match = jinjaInteger.FindString(text[i:])
				}
				i += len(match)
			} else {
				c := text[i]
				i++
				if strings.ContainsRune("([{", rune(c)) {
					stack = append(stack, c)
				}
				if strings.ContainsRune(")]}", rune(c)) {
					if len(stack) == 0 || !matching(stack[len(stack)-1], c) {
						break
					}
					stack = stack[:len(stack)-1]
				}
				if i < len(text) && strings.Contains(" == != <= >= ** // ", " "+text[a:i+1]+" ") {
					i++
				}
			}
			tokens = append(tokens, Token{k, text[a:i], Span{a, i}})
		}
		e := Expression{Kind: kind, Span: Span{start, i}, Tokens: tokens, Complete: complete, text: text[start:i], opening: opening, closing: closing}
		if kind == "statement" && len(tokens) == 1 && tokens[0].Text == "raw" && complete {
			// Raw content is literal; scan only for its matching endraw statement.
			found := false
			for j := i; j+1 < len(text); j++ {
				if !strings.HasPrefix(text[j:], "{%") {
					continue
				}
				end := strings.Index(text[j+2:], "%}")
				if end < 0 {
					break
				}
				end += j + 4
				tag := strings.Trim(strings.TrimSpace(text[j+2:end-2]), "+- \t\r\n")
				if tag == "endraw" {
					i = end
					found = true
					break
				}
			}
			if !found {
				break
			}
			continue
		}
		out = append(out, e)
		if !complete {
			break
		}
	}
	return out
}
func matching(a, b byte) bool {
	return a == '(' && b == ')' || a == '[' && b == ']' || a == '{' && b == '}'
}

// Calls returns balanced direct named function calls in source order, including
// nested calls. Attribute/filter/test names and statement bindings are excluded
// through the shared lexical name boundary. Named argument Tokens exclude the
// name and equals sign. This does not resolve function values or runtime scope.
func Calls(e Expression, name string) []Call {
	if !e.Complete {
		return nil
	}
	var calls []Call
	ts := e.Tokens
	bindings := statementBindings(e)
	for i := 0; i+1 < len(ts); i++ {
		if ts[i].Text != name || ts[i+1].Text != "(" || !nameReference(ts, i, bindings) {
			continue
		}
		depth := 0
		start := i + 2
		call := Call{Name: name}
		for j := i + 2; j < len(ts); j++ {
			v := ts[j].Text
			if depth == 0 && (v == "," || v == ")") {
				if j > start {
					arg := Argument{Tokens: ts[start:j]}
					if j-start >= 2 && ts[start].Kind == "name" && ts[start+1].Text == "=" {
						arg.Name = ts[start].Text
						arg.Tokens = ts[start+2 : j]
					}
					call.Arguments = append(call.Arguments, arg)
				}
				start = j + 1
			}
			if v == ")" && depth == 0 {
				call.Span = Span{ts[i].Span.Start, ts[j].Span.End}
				calls = append(calls, call)
				break
			}
			if v == "(" || v == "[" || v == "{" {
				depth++
			}
			if v == ")" || v == "]" || v == "}" {
				depth--
			}
		}
	}
	return calls
}

// These boundaries follow Jinja's integer/float lexical grammar. Keeping complete
// numeric literals atomic is necessary for whitespace-edit token equivalence.
var jinjaFloat = regexp.MustCompile(`(?i)^(?:[0-9]+_)*[0-9]+(?:(?:\.(?:[0-9]+_)*[0-9]+)?e[+\-]?(?:[0-9]+_)*[0-9]+|\.(?:[0-9]+_)*[0-9]+)`)
var jinjaInteger = regexp.MustCompile(`(?i)^(?:0b(?:_?[01])+|0o(?:_?[0-7])+|0x(?:_?[0-9a-f])+|[1-9](?:_?[0-9])*|0(?:_?0)*)`)

func scalarSyntaxStart(raw string) int {
	start := 0
	for start < len(raw) && (raw[start] == '!' || raw[start] == '&') {
		for start < len(raw) && !space(raw[start]) {
			start++
		}
		for start < len(raw) && space(raw[start]) {
			start++
		}
	}
	return start
}
