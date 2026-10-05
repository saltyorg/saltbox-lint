package lint

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// templateScan inspects original bytes only. It has no renderer or edit provider.
// Reasons describe grammar outside its bounded delimiter/block checks.
type templateScan struct {
	expressions []Expression
	diagnostics []Diagnostic
	reasons     []string
}
type templateDelimiters struct{ starts, ends [3]string }
type templateBlock struct {
	name, label string
	span        Span
	alternate   bool
}

func scanTemplate(s *Source) templateScan {
	result := templateScan{}
	diagnosticLimit := false
	partial := func(reason string) { result.reasons = append(result.reasons, reason) }
	failure := func(span Span, message string) {
		if len(result.diagnostics) == 128 {
			if !diagnosticLimit {
				partial("template diagnostics exceed the 128 finding static limit")
			}
			diagnosticLimit = true
			return
		}
		result.diagnostics = append(result.diagnostics, Diagnostic{Path: s.Path, RuleID: "template-syntax", Severity: "error", Span: span, Message: message, Expected: "Correct the indicated Jinja delimiter or block. Template bytes and layout are never changed automatically."})
	}
	if len(s.Data) > 16*1024*1024 {
		partial("template exceeds the 16 MiB static scanner limit")
		return result
	}
	if !utf8.Valid(s.Data) {
		partial("template is not valid UTF-8; static checks are unavailable")
		return result
	}
	text := string(s.Data)
	delimiters, offset, reason := templateConfiguration(text)
	if reason != "" {
		partial(reason)
		return result
	}
	node := &Node{Kind: "string", Value: text, Span: Span{0, len(text)}}
	var blocks []templateBlock
	reliable := true
	tags, totalTokens := 0, 0
	for offset < len(text) && !diagnosticLimit {
		start, kind := -1, 0
		for k, opening := range delimiters.starts {
			if n := strings.Index(text[offset:], opening); n >= 0 && (start < 0 || offset+n < start) {
				start = offset + n
				kind = k
			}
		}
		if start < 0 {
			break
		}
		tags++
		if tags > 4096 {
			partial("template exceeds the 4096 tag static limit")
			reliable = false
			blocks = nil
			break
		}
		bodyStart := start + len(delimiters.starts[kind])
		if bodyStart < len(text) && (text[bodyStart] == '-' || kind == 1 && text[bodyStart] == '+') {
			bodyStart++
		}
		closeStart, end, message := templateTagEnd(text, bodyStart, delimiters.ends[kind], kind)
		if message == "static-nesting-limit" {
			partial("template bracket nesting exceeds the 128 level static limit")
			reliable = false
			blocks = nil
			break
		}
		if message != "" {
			failure(Span{start, max(bodyStart, end)}, message)
			break
		}
		offset = end
		if kind == 2 {
			continue
		}
		if closeStart-bodyStart > 64*1024 {
			partial("template tag exceeds the 64 KiB static lexing limit")
			if kind == 1 {
				reliable = false
				blocks = nil
				break
			}
			continue
		}
		body := text[bodyStart:closeStart]
		// The shared lexer accepts the same expression token grammar. Wrapper bytes
		// are ephemeral; map every token back to the untouched template source.
		parsed := scanExpressions("{{" + body + "}}")
		if len(parsed) != 1 || !parsed[0].Complete {
			partial("unsupported template token grammar")
			continue
		}
		expression := parsed[0]
		expression.Kind = "output"
		if kind == 1 {
			expression.Kind = "statement"
		}
		expression.Span = Span{start, end}
		expression.opening = Span{start, bodyStart}
		expression.closing = Span{closeStart, end}
		expression.node = node
		expression.mapped = true
		expression.text = text[start:end]
		for i := range expression.Tokens {
			expression.Tokens[i].Span.Start += bodyStart - 2
			expression.Tokens[i].Span.End += bodyStart - 2
		}
		tokens := expression.Tokens
		totalTokens += len(tokens)
		if totalTokens > 32768 {
			partial("template exceeds the 32768 token aggregate static limit")
			reliable = false
			blocks = nil
			break
		}
		if slices.ContainsFunc(tokens, func(token Token) bool {
			return token.Span.Start < len(s.Data) && !utf8.RuneStart(s.Data[token.Span.Start]) || token.Span.End < len(s.Data) && !utf8.RuneStart(s.Data[token.Span.End])
		}) {
			partial("template token grammar cannot preserve Unicode source boundaries")
			if kind == 1 {
				reliable = false
				blocks = nil
				offset = len(text)
			}
			continue
		}
		if len(tokens) > 512 {
			partial("template tag exceeds the 512 token static grammar limit")
			reliable = false
			blocks = nil
			continue
		}
		if len(tokens) == 0 {
			failure(expression.Span, "empty Jinja tag")
			continue
		}
		if kind == 0 {
			if _, ok := parseFixExpression(tokens); !ok {
				partial("expression grammar outside the supported static subset")
			}
			result.expressions = append(result.expressions, expression)
			continue
		}
		name := tokens[0].Text
		if name == "raw" {
			if len(tokens) != 1 {
				failure(expression.Span, "raw tag does not accept arguments")
			}
			rawEnd, ok := templateRawEnd(text, offset, delimiters)
			if !ok {
				failure(expression.Span, "raw block is missing endraw")
				break
			}
			offset = rawEnd
			continue
		}
		result.expressions = append(result.expressions, expression)
		if len(blocks) >= 128 {
			partial("template nesting exceeds the 128 block static limit")
			reliable = false
			blocks = nil
		}
		switch name {
		case "if", "for", "macro", "call", "block", "filter", "with", "autoescape":
			if len(tokens) == 1 && name != "with" {
				failure(expression.Span, name+" tag requires arguments")
			}
			label := ""
			if (name == "block" || name == "macro") && len(tokens) > 1 {
				label = tokens[1].Text
			}
			if reliable {
				blocks = append(blocks, templateBlock{name: name, label: label, span: expression.Span})
			}
			if !supportedTemplateStatement(expression) {
				partial("statement argument grammar outside the supported static subset: " + name)
			}
		case "set":
			if len(tokens) == 1 {
				failure(expression.Span, "set tag requires a target")
			}
			assignment := templateAssignment(tokens)
			if !assignment && reliable {
				blocks = append(blocks, templateBlock{name: "set", span: expression.Span})
			}
			if !supportedTemplateStatement(expression) {
				partial("statement argument grammar outside the supported static subset: set")
			}
		case "elif", "else":
			if !reliable {
				continue
			}
			if len(blocks) == 0 || (blocks[len(blocks)-1].name != "if" && (name != "else" || blocks[len(blocks)-1].name != "for")) {
				failure(expression.Span, name+" has no matching if or for block")
				continue
			}
			top := &blocks[len(blocks)-1]
			if top.alternate {
				failure(expression.Span, name+" follows an else branch")
			}
			if name == "else" {
				top.alternate = true
				if len(tokens) != 1 {
					failure(expression.Span, "else tag does not accept arguments")
				}
			} else if len(tokens) == 1 {
				failure(expression.Span, "elif tag requires a condition")
			}
			if name == "elif" {
				if _, ok := parseFixExpression(tokens[1:]); !ok {
					partial("expression grammar outside the supported static subset")
				}
			}
		case "endif", "endfor", "endmacro", "endcall", "endblock", "endfilter", "endwith", "endautoescape", "endset", "endraw":
			if !reliable {
				continue
			}
			expected := strings.TrimPrefix(name, "end")
			if len(blocks) == 0 || blocks[len(blocks)-1].name != expected {
				failure(expression.Span, "unexpected "+name+" block ending")
				continue
			}
			top := blocks[len(blocks)-1]
			blocks = blocks[:len(blocks)-1]
			if len(tokens) > 1 {
				if name != "endblock" || len(tokens) != 2 || tokens[1].Text != top.label {
					failure(expression.Span, "invalid or mismatched "+name+" label")
				}
			}
		case "include", "import", "from", "extends":
			partial("template loading and import statement grammar is not validated: " + name)
		default:
			if tokens[0].Kind != "name" {
				partial("unsupported template statement syntax")
			} else if len(name) > 64 {
				partial("unsupported template statement identifier exceeds 64 bytes")
			} else {
				partial("unsupported template statement: " + name)
			}
			// An extension tag may introduce its own nesting. Do not fabricate a
			// missing/unexpected built-in ending once its grammar is unknown.
			reliable = false
			blocks = nil
			offset = len(text)
		}
	}
	if reliable && !diagnosticLimit {
		for _, block := range blocks {
			failure(block.span, block.name+" block is missing end"+block.name)
		}
	}
	if !reliable || diagnosticLimit {
		result.expressions = nil
	}
	slices.Sort(result.reasons)
	result.reasons = slices.Compact(result.reasons)
	return result
}

func templateTagEnd(text string, start int, ending string, kind int) (closeStart, end int, message string) {
	if kind == 2 {
		n := strings.Index(text[start:], ending)
		if n < 0 {
			return 0, len(text), "unterminated Jinja comment"
		}
		return start + n, start + n + len(ending), ""
	}
	var stack []byte
	for i := start; i < len(text); {
		if len(stack) == 0 && strings.HasPrefix(text[i:], ending) {
			return i, i + len(ending), ""
		}
		if len(stack) == 0 && (text[i] == '-' || kind == 1 && text[i] == '+') && strings.HasPrefix(text[i+1:], ending) {
			return i, i + 1 + len(ending), ""
		}
		if text[i] == '\'' || text[i] == '"' {
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
				return 0, i, "unterminated quoted string in Jinja tag"
			}
			continue
		}
		c := text[i]
		i++
		if strings.ContainsRune("([{", rune(c)) {
			stack = append(stack, c)
			if len(stack) > 128 {
				return 0, i, "static-nesting-limit"
			}
		}
		if strings.ContainsRune(")]}", rune(c)) {
			if len(stack) == 0 || !matching(stack[len(stack)-1], c) {
				return 0, i, "mismatched bracket in Jinja tag"
			}
			stack = stack[:len(stack)-1]
		}
	}
	return 0, len(text), "unterminated Jinja tag or bracket"
}

// Raw content may contain millions of incomplete statement-like fragments.
// Inspect only each candidate's endraw spelling, never search the remainder
// for an arbitrary closing tag. Whitespace runs cannot contain an opening tag.
func templateRawEnd(text string, start int, d templateDelimiters) (int, bool) {
	for start < len(text) {
		n := strings.Index(text[start:], d.starts[1])
		if n < 0 {
			return 0, false
		}
		candidate := start + n
		bodyStart := candidate + len(d.starts[1])
		next := bodyStart
		if next < len(text) && (text[next] == '-' || text[next] == '+') {
			next++
		}
		next = templateSpaceEnd(text, next)
		if strings.HasPrefix(text[next:], "endraw") {
			next = templateSpaceEnd(text, next+len("endraw"))
			if strings.HasPrefix(text[next:], d.ends[1]) {
				return next + len(d.ends[1]), true
			}
			if next < len(text) && (text[next] == '-' || text[next] == '+') {
				next++
			}
			if strings.HasPrefix(text[next:], d.ends[1]) {
				return next + len(d.ends[1]), true
			}
		}
		start = candidate + 1
	}
	return 0, false
}
func templateSpaceEnd(text string, start int) int {
	for start < len(text) {
		r, size := utf8.DecodeRuneInString(text[start:])
		// Python's regular-expression whitespace additionally admits these four
		// separators, used by Jinja's raw-end lexer.
		if !unicode.IsSpace(r) && (r < 0x1c || r > 0x1f) {
			break
		}
		start += size
	}
	return start
}

func supportedTemplateStatement(e Expression) bool {
	t := e.Tokens
	name := t[0].Text
	switch name {
	case "if", "autoescape":
		_, ok := parseFixExpression(t[1:])
		return ok
	case "for":
		in := -1
		for i := 1; i < len(t); i++ {
			if t[i].Text == "in" {
				in = i
				break
			}
			if t[i].Kind != "name" && t[i].Text != "," {
				return false
			}
		}
		if in < 2 {
			return false
		}
		end := len(t)
		if t[end-1].Text == "recursive" {
			end--
		}
		_, ok := parseFixExpression(t[in+1 : end])
		return ok
	case "block":
		return len(t) == 2 && t[1].Kind == "name" || len(t) == 3 && t[1].Kind == "name" && t[2].Text == "scoped"
	case "set":
		if len(t) == 2 && t[1].Kind == "name" {
			return true
		}
		if len(t) > 3 && t[1].Kind == "name" && t[2].Text == "=" {
			_, ok := parseFixExpression(t[3:])
			return ok
		}
		return false
	case "filter":
		_, ok := parseFixExpression(t[1:])
		return ok
	case "macro":
		return len(t) > 3 && t[1].Kind == "name" && templateSignature(t[2:])
	case "call":
		rest := t[1:]
		if len(rest) > 0 && rest[0].Text == "(" {
			end := balancedEnd(rest, 0, len(rest))
			if end < 0 || !templateSignature(rest[:end+1]) {
				return false
			}
			rest = rest[end+1:]
		}
		parsed, ok := parseFixExpression(rest)
		return ok && parsed.kind == "call"
	case "with":
		return len(t) == 1
	}
	return false
}

func templateConfiguration(text string) (templateDelimiters, int, string) {
	d := templateDelimiters{starts: [3]string{"{{", "{%", "{#"}, ends: [3]string{"}}", "%}", "#}"}}
	if !strings.HasPrefix(text, "#jinja2:") {
		return d, 0, ""
	}
	end := strings.IndexByte(text, '\n')
	if end > 4096 {
		return d, 0, "unsupported #jinja2 configuration: header exceeds the 4 KiB static limit"
	}
	if end < 0 {
		return d, 0, "unsupported #jinja2 configuration: missing header newline"
	}
	seen := map[string]bool{}
	for pair := range strings.SplitSeq(text[len("#jinja2:"):end], ",") {
		key, value, ok := strings.Cut(pair, ":")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !ok || seen[key] {
			return d, 0, "unsupported #jinja2 configuration: malformed or repeated option"
		}
		seen[key] = true
		var index int
		opening := false
		switch key {
		case "variable_start_string":
			index = 0
			opening = true
		case "variable_end_string":
			index = 0
		case "block_start_string":
			index = 1
			opening = true
		case "block_end_string":
			index = 1
		case "comment_start_string":
			index = 2
			opening = true
		case "comment_end_string":
			index = 2
		case "trim_blocks", "lstrip_blocks", "keep_trailing_newline":
			if value != "True" && value != "False" {
				return d, 0, "unsupported #jinja2 configuration: " + key + " requires a Python boolean"
			}
			continue
		case "line_statement_prefix", "line_comment_prefix":
			if value == "None" {
				continue
			}
			return d, 0, "unsupported #jinja2 configuration: line statements/comments are not scanned"
		default:
			return d, 0, "unsupported #jinja2 configuration option: " + key
		}
		// Python literal escapes/concatenation require a separate grammar. Admit
		// plain quoted strings only, preserving their bytes rather than guessing.
		if len(value) < 3 || (value[0] != '\'' && value[0] != '"') || value[len(value)-1] != value[0] || strings.ContainsAny(value[1:len(value)-1], "\\\r\n\t") || strings.ContainsRune(value[1:len(value)-1], rune(value[0])) {
			return d, 0, "unsupported #jinja2 configuration: delimiter must be a nonempty plain quoted string"
		}
		literal := value[1 : len(value)-1]
		if len(literal) > 32 || strings.TrimSpace(literal) != literal {
			return d, 0, "unsupported #jinja2 configuration: delimiter size or whitespace"
		}
		if opening {
			d.starts[index] = literal
		} else {
			d.ends[index] = literal
		}
	}
	all := append(slices.Clone(d.starts[:]), d.ends[:]...)
	for i, a := range all {
		for j, b := range all {
			if i != j && (strings.HasPrefix(a, b) || strings.HasPrefix(b, a)) {
				return d, 0, "unsupported #jinja2 configuration: overlapping delimiters"
			}
		}
	}
	return d, end + 1, ""
}

func checkTemplateSyntax(_ *Project, s *Source) []Diagnostic { return scanTemplate(s).diagnostics }
func checkTemplateCoverage(_ *Project, s *Source) []Diagnostic {
	scan := scanTemplate(s)
	if len(scan.reasons) == 0 {
		return nil
	}
	return []Diagnostic{{Path: s.Path, RuleID: "template-partial-coverage", Severity: "warning", Span: Span{0, 0}, Message: "partial template coverage: " + strings.Join(scan.reasons, "; "), Expected: "Only supported static delimiters, block structure and reference spans are checked. Unsupported grammar and runtime values remain unresolved; no template is rendered or changed."}}
}

// checkTemplateRenderer gives the selected template ownership of its existing
// YAML renderer finding. When both sources are selected, emit it only here.
func checkTemplateRenderer(p *Project, s *Source) []Diagnostic {
	if s.RolePath == "" {
		return nil
	}
	var result []Diagnostic
	facts := analyzeTraefikRole(p, s)
	for _, renderer := range facts.renderers {
		if renderer.OutputSource != s {
			continue
		}
		scan := scanTemplate(s)
		if len(scan.reasons) > 0 || len(scan.diagnostics) > 0 {
			return nil
		}
		evaluation := *p
		evaluation.Selected = map[string]bool{s.Path: true}
		for _, d := range checkTraefikRendererContract(&evaluation, renderer.Source) {
			d.Related = slices.DeleteFunc(d.Related, func(location RelatedLocation) bool { return location.Path == s.Path })
			d.Related = append(d.Related, RelatedLocation{Path: d.Path, Span: d.Span, Message: "template referenced by this task"})
			d.Path = s.Path
			d.Span = Span{0, len(s.Data)}
			d.Fix = nil
			result = append(result, d)
		}
		break
	}
	return result
}

// Assignment belongs at tag depth zero. A keyword inside a capture filter
// cannot turn a block set into an assignment statement.
func templateAssignment(tokens []Token) bool {
	depth := 0
	for _, t := range tokens {
		switch t.Text {
		case "(", "[", "{":
			depth++
		case ")", "]", "}":
			depth--
		case "=":
			if depth == 0 {
				return true
			}
		}
	}
	return false
}
func templateSignature(tokens []Token) bool {
	if len(tokens) < 2 || tokens[0].Text != "(" || tokens[len(tokens)-1].Text != ")" {
		return false
	}
	tokens = tokens[1 : len(tokens)-1]
	names := map[string]bool{}
	defaults := false
	for len(tokens) > 0 {
		if tokens[0].Kind != "name" || names[tokens[0].Text] {
			return false
		}
		names[tokens[0].Text] = true
		tokens = tokens[1:]
		if len(tokens) > 0 && tokens[0].Text == "=" {
			defaults = true
			tokens = tokens[1:]
			end := 0
			depth := 0
			for end < len(tokens) {
				t := tokens[end].Text
				if t == "," && depth == 0 {
					break
				}
				if t == "(" || t == "[" || t == "{" {
					depth++
				}
				if t == ")" || t == "]" || t == "}" {
					depth--
				}
				end++
			}
			if _, ok := parseFixExpression(tokens[:end]); !ok {
				return false
			}
			tokens = tokens[end:]
		} else if defaults {
			return false
		}
		if len(tokens) == 0 {
			return true
		}
		if tokens[0].Text != "," {
			return false
		}
		tokens = tokens[1:]
	}
	return true
}

// YAML-only contract context retains its established scanner. Explicit template
// selection uses the declared configuration and supported static grammar.
func selectedTemplateExpressions(p *Project, source *Source) []Expression {
	if p.Selected[source.Path] {
		return scanTemplate(source).expressions
	}
	return scanExpressions(string(source.Data))
}
