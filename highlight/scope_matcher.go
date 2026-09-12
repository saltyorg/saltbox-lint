package highlight

import (
	"regexp"
	"strings"
)

// Adapted from VS Code textMateScopeMatcher.ts and colorThemeData.ts at
// 88e44fa0e00b08f7758b4f6d05632e4fd5e4df6f (Microsoft, MIT; see testdata/README).
// Our standard fallback probes each contain exactly one scope. Parent stacks
// therefore cannot match; grouping, negation and alternatives retain upstream
// scores. Scope priorities are ignored by VS Code's getScopeMatcher too.
type scopeMatcher func(string) int

var scopeLexemes = regexp.MustCompile(`([LR]:|[\w\.:][\w\.:\-]*|[,|\-()])`)

type scopeParser struct {
	tokens []string
	index  int
}

func (p *scopeParser) peek() string {
	if p.index >= len(p.tokens) {
		return ""
	}
	return p.tokens[p.index]
}
func (p *scopeParser) take() string {
	v := p.peek()
	if v != "" {
		p.index++
	}
	return v
}
func parseScopeMatchers(selector string) []scopeMatcher {
	p := scopeParser{tokens: scopeLexemes.FindAllString(selector, -1)}
	var result []scopeMatcher
	for p.peek() != "" {
		if p.peek() == "L:" || p.peek() == "R:" {
			p.take()
		}
		if m := p.conjunction(); m != nil {
			result = append(result, m)
		}
		if p.peek() != "," {
			break
		}
		p.take()
	}
	return result
}
func (p *scopeParser) operand() scopeMatcher {
	switch p.peek() {
	case "-":
		p.take()
		inner := p.operand()
		if inner == nil {
			return nil
		}
		return func(scope string) int {
			if inner(scope) < 0 {
				return 0
			}
			return -1
		}
	case "(":
		p.take()
		inner := p.expression()
		if p.peek() == ")" {
			p.take()
		}
		return inner
	}
	var names []string
	for token := p.peek(); isScopeIdentifier(token); token = p.peek() {
		names = append(names, p.take())
	}
	if len(names) == 0 {
		return nil
	}
	return func(scope string) int {
		if len(names) != 1 {
			return -1
		}
		name := names[0]
		if scope == name || strings.HasPrefix(scope, name+".") {
			return 0x10000 + len(name)
		}
		return -1
	}
}
func isScopeIdentifier(token string) bool {
	return token != "" && !strings.ContainsAny(token[:1], ",|-()")
}

func (p *scopeParser) conjunction() scopeMatcher {
	var all []scopeMatcher
	for m := p.operand(); m != nil; m = p.operand() {
		all = append(all, m)
	}
	if len(all) == 0 {
		return nil
	}
	return func(scope string) int {
		score := all[0](scope)
		for _, m := range all[1:] {
			if score < 0 {
				break
			}
			score = min(score, m(scope))
		}
		return score
	}
}
func (p *scopeParser) expression() scopeMatcher {
	var any []scopeMatcher
	for m := p.conjunction(); m != nil; m = p.conjunction() {
		any = append(any, m)
		if p.peek() != "|" && p.peek() != "," {
			break
		}
		for p.peek() == "|" || p.peek() == "," {
			p.take()
		}
	}
	if len(any) == 0 {
		return nil
	}
	return func(scope string) int {
		score := -1
		for _, m := range any {
			score = max(score, m(scope))
		}
		return score
	}
}
