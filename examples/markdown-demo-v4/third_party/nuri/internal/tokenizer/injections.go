package tokenizer

import (
	"context"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
)

// collectInjections gathers all injections that apply to grammar g:
// its own self-injections plus external grammars that injectTo g's scope.
func collectInjections(g *grammar.Grammar, resolver grammar.GrammarResolver) []grammar.Injection {
	all := make([]grammar.Injection, len(g.Injections))
	copy(all, g.Injections)

	if resolver == nil {
		return all
	}

	provider, ok := resolver.(grammar.InjectionProvider)
	if !ok {
		return all
	}

	injectors, err := provider.GetInjectors(g.ScopeName)
	if err != nil || len(injectors) == 0 {
		return all
	}

	for _, ext := range injectors {
		if ext.InjectionSelector == nil || len(ext.Patterns) == 0 {
			continue
		}
		all = append(all, grammar.Injection{
			RawSelector: "",
			Selector:    ext.InjectionSelector,
			Rule:        &grammar.CollectionRule{Patterns: ext.Patterns},
		})
	}

	return all
}

// matchInjections finds the best injection match for the current scope stack.
// Compilation is memoized per injection index; selector matching stays
// per-position because it depends on the live scope stack.
func matchInjections(
	ctx context.Context,
	injections []grammar.Injection,
	g *grammar.Grammar,
	state *StateStack,
	line []byte,
	pos int,
	memo *compileMemo,
	options oniguruma.SearchOptions,
) (*matchResult, grammar.Priority, error) {
	if len(injections) == 0 {
		return nil, grammar.PriorityNone, nil
	}

	scopeSlice := state.scopeSlice()
	var bestResult *matchResult
	var bestPriority grammar.Priority
	bestStart := len(line) + 1

	for i := range injections {
		inj := &injections[i]
		if inj.Selector == nil {
			continue
		}
		matches, priority := inj.Selector.Matches(scopeSlice)
		if !matches {
			continue
		}

		entry := memo.getOrCompileInjection(ctx, i, inj, g)
		if entry.err != nil || len(entry.rules) == 0 {
			continue
		}

		mr, err := findNextMatch(ctx, entry, line, pos, options)
		if err != nil || mr == nil {
			continue
		}

		matchStart := mr.match.Captures[0].Start
		if matchStart < bestStart || (matchStart == bestStart && priority == grammar.PriorityLeft && bestPriority != grammar.PriorityLeft) {
			bestStart = matchStart
			bestResult = mr
			bestPriority = priority
		}
	}

	return bestResult, bestPriority, nil
}
