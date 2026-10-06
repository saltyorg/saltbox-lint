package lint

import (
	"bytes"
	"slices"
	"strings"
	"unicode/utf8"
)

// templateScan inspects original bytes only. It has no renderer or edit provider.
// Reasons describe grammar outside its bounded delimiter/block checks.
type templateScan struct {
	expressions              []Expression
	diagnostics              []Diagnostic
	reasons                  []templateReason
	configurationUnavailable bool
}

type templateReasonKind uint8

const (
	templateReasonOther templateReasonKind = iota
	templateReasonExpressionGrammar
	templateReasonSetGrammar
	templateReasonIfGrammar
	templateReasonElifGrammar
)

// Scanner categories stay independent of the text shown in coverage reports.
type templateReason struct {
	kind    templateReasonKind
	message string
}

func templateReasonMessages(reasons []templateReason) []string {
	if reasons == nil {
		return nil
	}
	messages := make([]string, len(reasons))
	for i, reason := range reasons {
		messages[i] = reason.message
	}
	return messages
}

func (scan templateScan) reasonMessages() []string {
	return templateReasonMessages(scan.reasons)
}

type templateDelimiters struct{ starts, ends [3]string }
type templateBlock struct {
	name, label string
	span        Span
	alternate   bool
}

func scanTemplate(s *Source) templateScan {
	return scanProjectTemplate(s.templateProject, s)
}

func scanProjectTemplate(p *Project, s *Source) templateScan {
	result := templateScan{}
	if reasons := templateTaskConfigurationReasons(p, s); len(reasons) > 0 {
		for _, reason := range reasons {
			result.reasons = append(result.reasons, templateReason{message: reason})
		}
		result.configurationUnavailable = true
		return result
	}
	diagnosticLimit := false
	partialGrammar := func(kind templateReasonKind, message string) {
		result.reasons = append(result.reasons, templateReason{kind: kind, message: message})
	}
	partial := func(reason string) { partialGrammar(templateReasonOther, reason) }
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
		result.configurationUnavailable = true
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
		// Delimiters and trim markers are already removed. Lex the exact body
		// without interpreting its edge tokens as synthetic whitespace controls.
		tokens, _, _, complete := scanExpressionTokens(body, 0, "")
		if !complete {
			partial("unsupported template token grammar")
			continue
		}
		expression := Expression{Tokens: tokens, Complete: true}
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
			expression.Tokens[i].Span.Start += bodyStart
			expression.Tokens[i].Span.End += bodyStart
		}
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
			if _, ok := parseTemplateExpression(tokens); !ok {
				partialGrammar(templateReasonExpressionGrammar, "expression grammar outside the supported static subset")
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
				kind := templateReasonOther
				if name == "if" {
					kind = templateReasonIfGrammar
				}
				partialGrammar(kind, "statement argument grammar outside the supported static subset: "+name)
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
				partialGrammar(templateReasonSetGrammar, "statement argument grammar outside the supported static subset: set")
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
				if !supportedTemplateCondition(tokens[1:]) {
					partialGrammar(templateReasonElifGrammar, "statement argument grammar outside the supported static subset: elif")
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
	slices.SortFunc(result.reasons, func(a, b templateReason) int { return strings.Compare(a.message, b.message) })
	result.reasons = slices.CompactFunc(result.reasons, func(a, b templateReason) bool { return a.message == b.message })
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
		if !jinjaSpace(r) {
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
	case "if":
		return supportedTemplateCondition(t[1:])
	case "autoescape":
		_, ok := parseTemplateExpression(t[1:])
		return ok
	case "for":
		return supportedTemplateFor(t[1:])
	case "block":
		return len(t) == 2 && t[1].Kind == "name" || len(t) == 3 && t[1].Kind == "name" && t[2].Text == "scoped"
	case "set":
		if len(t) == 2 && templateAssignableName(t[1]) {
			return true
		}
		if len(t) > 3 && templateAssignableName(t[1]) && t[2].Text == "=" {
			_, ok := parseTemplateExpression(t[3:])
			return ok
		}
		return false
	case "filter":
		return supportedTemplateFilter(t[1:])
	case "macro":
		return len(t) > 3 && templateAssignableName(t[1]) && templateSignature(t[2:])
	case "call":
		rest := t[1:]
		if len(rest) > 0 && rest[0].Text == "(" {
			end := balancedEnd(rest, 0, len(rest))
			if end < 0 || !templateSignature(rest[:end+1]) {
				return false
			}
			rest = rest[end+1:]
		}
		parsed, ok := parseTemplateExpression(rest)
		return ok && parsed.kind == "call"
	case "with":
		return len(t) == 1
	}
	return false
}

// Template admission follows Jinja's expression ordering: postfix attributes
// and subscripts precede filters/tests. Calls may still follow filters/tests,
// and grouping starts a new postfix expression. Structural fixes retain their
// existing expression-signature recognizer.
func parseTemplateExpression(tokens []Token) (parsedExpression, bool) {
	p := expressionParser{tokens: tokens, templateSyntax: true}
	result := p.conditional()
	return result, !p.invalid && p.pos == len(tokens) && len(tokens) > 0
}

// If/elif conditions disable top-level conditional expressions. Grouped
// expressions still use their own expression grammar, as Jinja does.
func supportedTemplateCondition(tokens []Token) bool {
	p := expressionParser{tokens: tokens, templateSyntax: true}
	p.binary(0)
	return !p.invalid && p.pos == len(tokens) && len(tokens) > 0
}

// A filter block starts with a dotted filter name, followed by optional call
// arguments and more pipe-separated filters. General expressions are not
// filter names. Reuse only the matching bounded name and argument grammars.
func supportedTemplateFilter(tokens []Token) bool {
	p := expressionParser{tokens: tokens, templateSyntax: true}
	for {
		if _, ok := p.name(); !ok {
			return false
		}
		if p.pos < len(tokens) && tokens[p.pos].Text == "(" {
			p.arguments()
		}
		if p.invalid {
			return false
		}
		if !p.take("|") {
			return p.pos == len(tokens)
		}
	}
}

func templateAssignableName(token Token) bool {
	return token.Kind == "name" && token.Text != "true" && token.Text != "True" && token.Text != "false" && token.Text != "False" && token.Text != "none" && token.Text != "None"
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
		key = strings.TrimFunc(key, jinjaSpace)
		// Ansible strips keys, but passes values to Python literal parsing.
		// Its whitespace is narrower than the Jinja expression lexer's \\s.
		value = strings.Trim(value, " \t\r\n\f")
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
		if len(literal) > 32 || strings.TrimFunc(literal, jinjaSpace) != literal {
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
	// Endings have precedence only at Jinja token boundaries. The bounded
	// scanner skips quoted strings and brackets, but does not reproduce the
	// full name, number and operator lexer. Decline endings that can begin
	// inside those tokens instead of treating a token suffix as a tag end.
	for _, ending := range d.ends[:2] {
		first := ending[0]
		exponentSign := (first == '+' || first == '-') && (len(ending) == 1 || ending[1] >= '0' && ending[1] <= '9')
		if first >= 0x80 || first >= 'a' && first <= 'z' || first >= 'A' && first <= 'Z' || first >= '0' && first <= '9' || strings.ContainsRune("_.=*/", rune(first)) || exponentSign {
			return d, 0, "unsupported #jinja2 configuration: closing delimiter may split an identifier, number or operator token"
		}
	}
	return d, end + 1, ""
}

func checkTemplateSyntax(p *Project, s *Source) []Diagnostic {
	return scanProjectTemplate(p, s).diagnostics
}
func checkTemplateCoverage(p *Project, s *Source) []Diagnostic {
	scan := scanProjectTemplate(p, s)
	if len(scan.reasons) == 0 {
		return nil
	}
	return []Diagnostic{{Path: s.Path, RuleID: "template-partial-coverage", Severity: "warning", Span: Span{0, 0}, Message: "partial template coverage: " + strings.Join(scan.reasonMessages(), "; "), Expected: "Only supported static delimiters, block structure and reference spans are checked. Unsupported grammar and runtime values remain unresolved; no template is rendered or changed."}}
}

// checkTemplateRenderer gives the selected template ownership of its existing
// YAML renderer finding. When both sources are selected, emit it only here.
func checkTemplateRenderer(p *Project, s *Source) []Diagnostic {
	if s.RolePath == "" || selectedTemplateOwner(p, s) != s {
		return nil
	}
	var result []Diagnostic
	facts := analyzeTraefikRole(p, s)
	for _, renderer := range facts.renderers {
		if !sameTemplateSource(renderer.OutputSource, s) {
			continue
		}
		if len(renderer.Unavailable) > 0 && len(facts.invalidTasks) == 0 || len(invalidTraefikRenderer(renderer)) > 0 {
			return nil
		}
		for _, d := range traefikRendererDiagnostics(facts, renderer) {
			d.Related = slices.DeleteFunc(d.Related, func(location RelatedLocation) bool {
				return sameTemplateSource(p.Sources[location.Path], s)
			})
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

func templateSourcePath(s *Source) string {
	if s.templatePath != "" {
		return s.templatePath
	}
	return s.Path
}

// Identity comes from the confined read, never file contents alone. Unequal
// buffers at aliases of one file cannot transfer source-owned diagnostics.
func sameTemplateSource(a, b *Source) bool {
	return sameTemplateIdentity(a, b) && bytes.Equal(a.Data, b.Data)
}

func sameTemplateIdentity(a, b *Source) bool {
	return a != nil && b != nil && a.Kind == Template && b.Kind == Template && templateSourcePath(a) == templateSourcePath(b)
}

// Prefer the first selected spelling deterministically; unselected canonical
// context is never a diagnostic primary. All spellings stay read-only.
func selectedTemplateOwner(p *Project, source *Source) *Source {
	for _, name := range sortedKeys(p.Selected) {
		if p.Selected[name] && sameTemplateSource(p.Sources[name], source) {
			return p.Sources[name]
		}
	}
	return nil
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
		if !templateAssignableName(tokens[0]) || names[tokens[0].Text] {
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
			if _, ok := parseTemplateExpression(tokens[:end]); !ok {
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
		if len(tokens) == 0 {
			return false
		}
	}
	return true
}

// Contract recognition supports non-output assignments, filtered captures and
// simple list guards beyond the general syntax subset. Other scanner limitations
// make absence of consumption unknown, regardless of selection.
func templateContractReasons(scan templateScan) []string {
	reasons := slices.DeleteFunc(slices.Clone(scan.reasons), func(reason templateReason) bool {
		switch reason.kind {
		case templateReasonSetGrammar, templateReasonIfGrammar, templateReasonElifGrammar, templateReasonExpressionGrammar:
		default:
			return false
		}
		for _, e := range scan.expressions {
			tokens := e.Tokens
			if e.Kind == "output" {
				if _, ok := parseTemplateExpression(tokens); !ok {
					return false
				}
				continue
			}
			if len(tokens) == 0 {
				continue
			}
			switch tokens[0].Text {
			case "set":
				if supportedTemplateStatement(e) {
					continue
				}
				if len(tokens) < 4 || !templateAssignableName(tokens[1]) {
					return false
				}
				switch tokens[2].Text {
				case "|":
					if !supportedTemplateFilter(tokens[3:]) || templateAssignment(tokens) {
						return false
					}
				case "=":
					if !traefikContractGuard(tokens[3:]) {
						return false
					}
				default:
					return false
				}
			case "if", "elif":
				condition := tokens[1:]
				listGuard := len(condition) >= 3 && condition[0].Text == "[" && condition[len(condition)-1].Text == "]" && traefikContractGuard(condition)
				if !supportedTemplateCondition(condition) && !listGuard {
					return false
				}
			}
		}
		return true
	})
	return templateReasonMessages(reasons)
}

// The legacy contract recognizer reads direct names in list guards, but neither
// evaluates the guard nor treats an assignment's value as emitted output.
func traefikContractGuard(tokens []Token) bool {
	if _, ok := parseTemplateExpression(tokens); ok {
		return true
	}
	if len(tokens) < 3 || tokens[0].Text != "[" || tokens[len(tokens)-1].Text != "]" {
		return false
	}
	tokens = tokens[1 : len(tokens)-1]
	start, depth := 0, 0
	for i, token := range tokens {
		switch token.Text {
		case "(", "[", "{":
			depth++
		case ")", "]", "}":
			depth--
		case ",":
			if depth == 0 {
				if _, ok := parseTemplateExpression(tokens[start:i]); !ok {
					return false
				}
				start = i + 1
			}
		}
	}
	if start == len(tokens) {
		return true
	}
	_, ok := parseTemplateExpression(tokens[start:])
	return ok
}

// For iterables disable top-level conditional expressions, as Jinja's for
// grammar does. A following if is a loop filter, with its own expression.
func supportedTemplateFor(tokens []Token) bool {
	pos := 0
	if !templateForTarget(tokens, &pos, 0) || pos >= len(tokens) || tokens[pos].Text != "in" {
		return false
	}
	p := expressionParser{tokens: tokens, pos: pos + 1, templateSyntax: true}
	for {
		if p.pos >= len(tokens) || tokens[p.pos].Text == "if" || tokens[p.pos].Text == "recursive" {
			return false
		}
		p.binary(0)
		if p.invalid {
			return false
		}
		if !p.take(",") {
			break
		}
		if p.pos == len(tokens) || tokens[p.pos].Text == "if" || tokens[p.pos].Text == "recursive" {
			break
		}
	}
	if p.take("if") {
		p.conditional()
	}
	p.take("recursive")
	return !p.invalid && p.pos == len(tokens)
}

// The supported assignment subset is a name or a comma-separated tuple of
// names, including grouping and nested tuples. Other targets remain partial.
func templateForTarget(tokens []Token, pos *int, depth int) bool {
	if depth > 128 || *pos >= len(tokens) {
		return false
	}
	for {
		if *pos >= len(tokens) {
			return false
		}
		token := tokens[*pos]
		*pos += 1
		if token.Text == "(" {
			if !templateForTarget(tokens, pos, depth+1) || *pos >= len(tokens) || tokens[*pos].Text != ")" {
				return false
			}
			*pos += 1
		} else if !templateAssignableName(token) || token.Text == "in" {
			return false
		}
		if *pos >= len(tokens) || tokens[*pos].Text != "," {
			return true
		}
		*pos += 1
		if *pos < len(tokens) && (tokens[*pos].Text == "in" || tokens[*pos].Text == ")") {
			return true
		}
	}
}
