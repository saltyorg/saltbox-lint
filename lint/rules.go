package lint

import (
	"bytes"
	"unicode/utf8"
)

// Rules returns the enforced policy registry. Metadata travels with each checker
// so CLI documentation and integration renderers need no separate rule lists.
func Rules() []Rule {
	kinds := []Kind{Generic, Defaults, Tasks, Handlers, Vars, Inventory, Playbook}
	return []Rule{
		{ID: "jinja-layout", Summary: "Align multiline Jinja expressions", Explanation: "Align operators, conditional branches, call arguments and dictionary keys with their structural owner. Keep non-block closing braces beside the final token.", GoodExample: "v: \"{{ a\n       | f }}\"", BadExample: "v: \"{{ a\n | f }}\"", Kinds: kinds, Scope: "file", Fixable: true, Check: checkLayout},
		{ID: "jinja-conditional-length", Summary: "Wrap long inline conditionals", Explanation: "A wholly inline Jinja conditional must not occupy a source line longer than 160 Unicode characters.", GoodExample: "v: \"{{ a if enabled else b }}\"", BadExample: "v: \"{{ 'this deliberately long value makes the complete physical source line exceed the conditional length limit' if a_long_condition_name_that_keeps_the_expression_inline else another_long_fallback_value }}\"", Kinds: kinds, Scope: "file", Check: checkConditionalLength},
		{ID: "lookup-conditional-argument", Summary: "Resolve conditionals before lookup calls", Explanation: "Lookup arguments must not contain unquoted conditional expressions. Choose between lookups outside the calls or pass an already resolved value.", GoodExample: "v: \"{{ lookup('a') if enabled else lookup('b') }}\"", BadExample: "v: \"{{ lookup('a', default=x if enabled else y) }}\"", Kinds: kinds, Scope: "file", Check: checkLookupConditional},
	}
}
func conditionalTokens(ts []Token) bool {
	hasIf := false
	for _, t := range ts {
		if t.Kind != "name" {
			continue
		}
		if t.Text == "if" {
			hasIf = true
		}
		if t.Text == "else" && hasIf {
			return true
		}
	}
	return false
}
func checkConditionalLength(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, e := range Expressions(s) {
		if e.Kind != "output" || !e.Complete || !conditionalTokens(e.Tokens) || s.Position(e.Span.Start).Line != s.Position(e.Span.End-1).Line {
			continue
		}
		start := bytes.LastIndexByte(s.Data[:e.Span.Start], '\n') + 1
		end := bytes.IndexByte(s.Data[e.Span.End:], '\n')
		if end < 0 {
			end = len(s.Data)
		} else {
			end += e.Span.End
		}
		if end > start && s.Data[end-1] == '\r' {
			end--
		}
		if utf8.RuneCount(s.Data[start:end]) > 160 {
			ds = append(ds, Diagnostic{Path: s.Path, RuleID: "jinja-conditional-length", Severity: "error", Span: e.Span, Message: "inline conditional exceeds the 160-character source-line limit", Expected: "Wrap the conditional with if and else on aligned continuation lines."})
		}
	}
	return ds
}
func checkLookupConditional(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, e := range Expressions(s) {
		reported := map[Span]bool{}
		// Report the conditional's own location once, even through nested lookups.
		for _, call := range Calls(e, "lookup") {
			for _, arg := range call.Arguments {
				if !conditionalTokens(arg.Tokens) {
					continue
				}
				for _, t := range arg.Tokens {
					if t.Kind == "name" && t.Text == "if" && !reported[t.Span] {
						reported[t.Span] = true
						ds = append(ds, Diagnostic{Path: s.Path, RuleID: "lookup-conditional-argument", Severity: "error", Span: t.Span, Message: "conditional expression appears inside a lookup argument", Expected: "Resolve the conditional before passing its value to lookup()."})
						break
					}
				}
			}
		}
	}
	return ds
}
