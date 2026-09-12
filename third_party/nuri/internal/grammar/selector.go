package grammar

import (
	"strings"
	"unicode"
)

// Priority determines how an injection match interacts with grammar matches.
type Priority int

const (
	PriorityNone  Priority = 0
	PriorityLeft  Priority = -1 // L: injection wins ties
	PriorityRight Priority = 1  // R: grammar wins ties
)

// Selector is a parsed injection selector.
// Grammar: selector = composite (',' composite)*
type Selector struct {
	Composites []Composite
}

// Composite is a space-separated sequence of expressions (ancestor path).
// Grammar: composite = ('L:' | 'R:')? expression+
type Composite struct {
	Priority    Priority
	Expressions []Expression
}

// Expression is a scope filter with optional negation.
// Grammar: expression = '-'? (group | scopePath)
type Expression struct {
	Negate bool
	Group  *Group     // non-nil if parenthesized group
	Path   *ScopePath // non-nil if plain scope path
}

// Group is a parenthesized set of alternatives.
// Grammar: group = '(' composite ('|' composite)* ')'
type Group struct {
	Alternatives []Composite
}

// ScopePath is a dotted scope name like "source.js" or "meta.function".
type ScopePath struct {
	Scope string
}

// Matches tests whether this selector matches the given scope stack.
// Returns true and the priority if any composite matches.
func (s *Selector) Matches(scopes []string) (bool, Priority) {
	for _, c := range s.Composites {
		if c.matches(scopes) {
			return true, c.Priority
		}
	}
	return false, PriorityNone
}

func (c *Composite) matches(scopes []string) bool {
	if len(c.Expressions) == 0 {
		return false
	}

	// Split into positive and negative expressions.
	var positive []Expression
	var negative []Expression
	for _, expr := range c.Expressions {
		if expr.Negate {
			negative = append(negative, expr)
		} else {
			positive = append(positive, expr)
		}
	}

	// Check negative expressions against the full scope stack.
	// vscode-textmate's nameMatcher requires all identifiers in a
	// conjunction to match as an ordered subsequence — not per-scope.
	for _, neg := range negative {
		if neg.matchesStack(scopes) {
			return false
		}
	}

	// Positive expressions must match as a subsequence of the scope stack
	// (right to left: last positive expression matches deepest scope).
	if len(positive) == 0 {
		return true
	}

	posIdx := len(positive) - 1
	for scopeIdx := len(scopes) - 1; scopeIdx >= 0 && posIdx >= 0; scopeIdx-- {
		if positive[posIdx].matchesSingle(scopes[scopeIdx]) {
			posIdx--
		}
	}

	return posIdx < 0
}

func (e *Expression) matchesSingle(scope string) bool {
	if e.Group != nil {
		return e.Group.matchesSingle(scope)
	}
	if e.Path != nil {
		return scopeMatches(e.Path.Scope, scope)
	}
	return false
}

func (g *Group) matchesSingle(scope string) bool {
	for _, alt := range g.Alternatives {
		// For a group used in single-scope context, check if any alternative
		// has a single positive expression that matches
		for _, expr := range alt.Expressions {
			if !expr.Negate && expr.matchesSingle(scope) {
				return true
			}
		}
	}
	return false
}

// matchesStack checks if this expression matches against the full scope stack.
func (e *Expression) matchesStack(scopes []string) bool {
	if e.Group != nil {
		return e.Group.matchesStack(scopes)
	}
	if e.Path != nil {
		for _, scope := range scopes {
			if scopeMatches(e.Path.Scope, scope) {
				return true
			}
		}
	}
	return false
}

func (g *Group) matchesStack(scopes []string) bool {
	for _, alt := range g.Alternatives {
		if alt.matchesAsSubsequence(scopes) {
			return true
		}
	}
	return false
}

// matchesAsSubsequence checks if all positive path expressions in this
// composite match as an ordered subsequence of the scope stack.
// Mirrors vscode-textmate's nameMatcher (grammar.ts:71-85).
func (c *Composite) matchesAsSubsequence(scopes []string) bool {
	var paths []string
	for _, expr := range c.Expressions {
		if !expr.Negate && expr.Path != nil {
			paths = append(paths, expr.Path.Scope)
		}
	}
	if len(paths) == 0 {
		return true
	}
	pathIdx := 0
	for _, scope := range scopes {
		if scopeMatches(paths[pathIdx], scope) {
			pathIdx++
			if pathIdx >= len(paths) {
				return true
			}
		}
	}
	return false
}

// scopeMatches checks if selector is a prefix of scope at a dot boundary.
func scopeMatches(selector, scope string) bool {
	if !strings.HasPrefix(scope, selector) {
		return false
	}
	if len(scope) == len(selector) {
		return true
	}
	return scope[len(selector)] == '.'
}

// ParseSelector parses an injection selector string.
func ParseSelector(input string) (*Selector, error) {
	p := &selectorParser{input: input}
	sel := p.parseSelector()
	return sel, nil
}

type selectorParser struct {
	input string
	pos   int
}

func (p *selectorParser) parseSelector() *Selector {
	sel := &Selector{}
	sel.Composites = append(sel.Composites, p.parseComposite())
	for p.peek() == ',' {
		p.advance()
		p.skipSpaces()
		sel.Composites = append(sel.Composites, p.parseComposite())
	}
	return sel
}

func (p *selectorParser) parseComposite() Composite {
	p.skipSpaces()
	c := Composite{}

	// Check for L: or R: prefix
	if p.hasPrefix("L:") {
		c.Priority = PriorityLeft
		p.pos += 2
		p.skipSpaces()
	} else if p.hasPrefix("R:") {
		c.Priority = PriorityRight
		p.pos += 2
		p.skipSpaces()
	}

	for p.pos < len(p.input) && p.peek() != ',' && p.peek() != ')' && p.peek() != '|' {
		expr := p.parseExpression()
		c.Expressions = append(c.Expressions, expr)
		p.skipSpaces()
	}
	return c
}

func (p *selectorParser) parseExpression() Expression {
	p.skipSpaces()
	expr := Expression{}

	if p.peek() == '-' {
		expr.Negate = true
		p.advance()
		p.skipSpaces()
	}

	if p.peek() == '(' {
		expr.Group = p.parseGroup()
	} else {
		scope := p.parseScopePath()
		expr.Path = &ScopePath{Scope: scope}
	}
	return expr
}

func (p *selectorParser) parseGroup() *Group {
	p.advance() // skip '('
	p.skipSpaces()
	g := &Group{}
	g.Alternatives = append(g.Alternatives, p.parseComposite())
	for p.peek() == '|' || p.peek() == ',' {
		p.advance()
		p.skipSpaces()
		g.Alternatives = append(g.Alternatives, p.parseComposite())
	}
	if p.peek() == ')' {
		p.advance()
	}
	return g
}

func (p *selectorParser) parseScopePath() string {
	start := p.pos
	for p.pos < len(p.input) {
		ch := p.input[p.pos]
		if ch == '.' || ch == '-' || ch == '_' || ch == '*' || ch == '#' ||
			(ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') {
			p.pos++
		} else {
			break
		}
	}
	return p.input[start:p.pos]
}

func (p *selectorParser) peek() byte {
	p.skipSpaces()
	if p.pos >= len(p.input) {
		return 0
	}
	return p.input[p.pos]
}

func (p *selectorParser) advance() {
	if p.pos < len(p.input) {
		p.pos++
	}
}

func (p *selectorParser) skipSpaces() {
	for p.pos < len(p.input) && unicode.IsSpace(rune(p.input[p.pos])) {
		p.pos++
	}
}

func (p *selectorParser) hasPrefix(prefix string) bool {
	return strings.HasPrefix(p.input[p.pos:], prefix)
}
