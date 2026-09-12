package tokenizer

import (
	"context"
	"fmt"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
)

// memoKey identifies one compiled rule context within a single Tokenize call.
//
// Key completeness (verified):
//   - The resolver is constant per Tokenize, so it is excluded. Add it if
//     this memo ever becomes persistent across calls.
//   - $base currently resolves like $self (compile.go), so the base grammar
//     is not part of the key. Fixing $base later requires adding a
//     base-grammar key component here.
//   - hasEnd is required: backref resolution can legitimately produce
//     EndPattern == "", which must not collide with "no end rule".
type memoKey struct {
	rule       grammar.Rule     // state.top().Rule; nil = grammar root
	compileG   *grammar.Grammar // grammar whose repository resolves includes
	hasEnd     bool
	endPattern string
	applyLast  bool
}

// memoEntry is the compile result for one rule context: the flattened rule
// list (end rule already inserted) plus its compiled scanner. Compile and
// scanner-create errors are memoized too, preserving the per-position error
// behavior of the uncached path. The scanner is owned by the OnigLib's
// persistent cache — never closed here.
type memoEntry struct {
	rules   []grammar.CompiledRule
	scanner oniguruma.OnigScanner
	err     error
}

// compileMemo caches pattern flattening and scanner resolution for the
// duration of one Tokenize call, so the per-position loop does one map
// lookup instead of re-resolving includes and re-hashing pattern bytes.
// Plain maps, no locking: a Tokenize call is single-goroutine (the pool
// checkout guarantees exclusivity).
type compileMemo struct {
	onigLib      oniguruma.OnigLib
	resolver     grammar.GrammarResolver
	entries      map[memoKey]*memoEntry
	whiles       map[*grammar.WhileRule]*memoEntry
	injections   map[int]*memoEntry // keyed by index into the injections slice
	captureRoots map[*grammar.CaptureRule]*grammar.CollectionRule
}

func newCompileMemo(onigLib oniguruma.OnigLib, resolver grammar.GrammarResolver) *compileMemo {
	return &compileMemo{
		onigLib:      onigLib,
		resolver:     resolver,
		entries:      make(map[memoKey]*memoEntry),
		whiles:       make(map[*grammar.WhileRule]*memoEntry),
		injections:   make(map[int]*memoEntry),
		captureRoots: make(map[*grammar.CaptureRule]*grammar.CollectionRule),
	}
}

// getOrCompile returns the memoized compile result for the current rule
// context, compiling it on first sight.
func (m *compileMemo) getOrCompile(
	ctx context.Context,
	rule grammar.Rule,
	activeRules []grammar.Rule,
	compileG *grammar.Grammar,
	endRule *grammar.EndRule,
) *memoEntry {
	key := memoKey{rule: rule, compileG: compileG}
	if endRule != nil {
		key.hasEnd = true
		key.endPattern = endRule.EndPattern
		key.applyLast = endRule.Parent != nil && endRule.Parent.ApplyEndPatternLast
	}
	if e, ok := m.entries[key]; ok {
		return e
	}

	e := m.compileContext(ctx, activeRules, compileG, endRule, key.applyLast)
	m.entries[key] = e
	return e
}

func (m *compileMemo) compileContext(
	ctx context.Context,
	activeRules []grammar.Rule,
	compileG *grammar.Grammar,
	endRule *grammar.EndRule,
	applyLast bool,
) *memoEntry {
	compiled, err := grammar.CompilePatterns(activeRules, compileG, compileG.Repository, nil, m.resolver)
	if err != nil {
		return &memoEntry{err: err}
	}

	// Build the combined slice once, as a copy. Never append the end rule
	// into a cached backing array per position — an ApplyEndPatternLast
	// append into shared capacity would shift the Match.Index mapping.
	rules := compiled.Rules
	if endRule != nil {
		endCR := grammar.CompiledRule{
			Pattern: []byte(endRule.EndPattern),
			Rule:    endRule,
		}
		rules = make([]grammar.CompiledRule, 0, len(compiled.Rules)+1)
		if applyLast {
			rules = append(rules, compiled.Rules...)
			rules = append(rules, endCR)
		} else {
			rules = append(rules, endCR)
			rules = append(rules, compiled.Rules...)
		}
	}

	return m.resolveScanner(ctx, rules)
}

// resolveScanner finishes an entry by resolving the scanner for a flattened
// rule list through the OnigLib's persistent cache.
func (m *compileMemo) resolveScanner(ctx context.Context, rules []grammar.CompiledRule) *memoEntry {
	if len(rules) == 0 {
		return &memoEntry{}
	}
	patterns := make([][]byte, len(rules))
	for i, cr := range rules {
		patterns[i] = cr.Pattern
	}
	scanner, err := m.onigLib.GetOrCreateScannerCtx(ctx, patterns)
	if err != nil {
		return &memoEntry{err: fmt.Errorf("tokenizer: create scanner: %w", err)}
	}
	return &memoEntry{rules: rules, scanner: scanner}
}

// getOrCompileWhile memoizes the single-pattern scanner for a resolved
// while rule (checked once per line per while frame).
func (m *compileMemo) getOrCompileWhile(ctx context.Context, wr *grammar.WhileRule) *memoEntry {
	if e, ok := m.whiles[wr]; ok {
		return e
	}
	e := m.resolveScanner(ctx, []grammar.CompiledRule{{
		Pattern: []byte(wr.WhilePattern),
		Rule:    wr,
	}})
	m.whiles[wr] = e
	return e
}

// getOrCompileInjection memoizes the compile result for injections[idx].
// Compile inputs are constant per Tokenize (root grammar + resolver);
// selector matching stays per-position because it depends on the live scope
// stack. Failed or empty compiles memoize as skippable entries, matching the
// uncached path's continue-on-error behavior.
func (m *compileMemo) getOrCompileInjection(
	ctx context.Context,
	idx int,
	inj *grammar.Injection,
	g *grammar.Grammar,
) *memoEntry {
	if e, ok := m.injections[idx]; ok {
		return e
	}

	var rules []grammar.Rule
	switch r := inj.Rule.(type) {
	case *grammar.CollectionRule:
		rules = r.Patterns
	default:
		rules = []grammar.Rule{inj.Rule}
	}

	var e *memoEntry
	compiled, err := grammar.CompilePatterns(rules, g, g.Repository, nil, m.resolver)
	if err != nil {
		e = &memoEntry{err: err}
	} else {
		e = m.resolveScanner(ctx, compiled.Rules)
	}
	m.injections[idx] = e
	return e
}

// captureRoot returns a stable CollectionRule for a capture rule's patterns,
// so capture retokenization memo-hits across calls within one Tokenize.
// Sharing one root across differing scope names is safe — the root rule only
// feeds getActivePatterns; scopes live in the stack frame.
func (m *compileMemo) captureRoot(cr *grammar.CaptureRule) *grammar.CollectionRule {
	if root, ok := m.captureRoots[cr]; ok {
		return root
	}
	root := &grammar.CollectionRule{
		ID:       grammar.InvalidRuleID,
		Patterns: cr.Patterns,
	}
	m.captureRoots[cr] = root
	return root
}
