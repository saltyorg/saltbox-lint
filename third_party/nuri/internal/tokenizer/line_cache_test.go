package tokenizer

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
)

type cacheResolver struct{ identity byte }

func (*cacheResolver) GetGrammarByScope(string) (*grammar.Grammar, error) { return nil, nil }

func TestTokenizeLineCacheReusesCompleteLinesWithoutSharingTokens(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	cache := NewLineCache(1 << 20)
	opts := TokenizeOptions{LineCache: cache}

	first, err := Tokenize(t.Context(), []byte("alpha\nbeta\n"), g, nil, opts)
	if err != nil {
		t.Fatal(err)
	}
	before := cache.Stats()
	if before.Stores != 2 || before.Hits != 0 {
		t.Fatalf("first pass stats = %+v, want 2 stores and no hits", before)
	}

	first.Lines[0][0].Scopes[0] = "consumer mutation"
	second, err := Tokenize(t.Context(), []byte("alpha\nbeta\n"), g, nil, opts)
	if err != nil {
		t.Fatal(err)
	}
	after := cache.Stats()
	if after.Hits-before.Hits != 2 {
		t.Fatalf("second pass added %d hits, want 2; stats=%+v", after.Hits-before.Hits, after)
	}
	if got := second.Lines[0][0].Scopes; !slices.Equal(got, []string{"source.test"}) {
		t.Fatalf("cached scopes = %v, want immutable source.test", got)
	}
}

func TestTokenizeLineCacheSkipsDegradedLinesAndStillChecksCancellation(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	cache := NewLineCache(1 << 20)
	opts := TokenizeOptions{MaxLineLength: 1, LineCache: cache}

	result, err := Tokenize(t.Context(), []byte("too long\nx"), g, nil, opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diagnostics) != 1 || result.Diagnostics[0].Kind != "too_long" {
		t.Fatalf("diagnostics = %+v, want too_long", result.Diagnostics)
	}
	if stats := cache.Stats(); stats.Stores != 0 {
		t.Fatalf("degraded line cache stats = %+v, want no stores", stats)
	}

	panicOnLineHook = 0
	t.Cleanup(func() { panicOnLineHook = -1 })
	if _, err := Tokenize(t.Context(), []byte("panic\nfollowing"), g, nil, TokenizeOptions{LineCache: cache}); err != nil {
		t.Fatal(err)
	}
	if stats := cache.Stats(); stats.Stores != 0 {
		t.Fatalf("panicked line cache stats = %+v, want no stores", stats)
	}
	panicOnLineHook = -1

	warmOpts := TokenizeOptions{LineCache: cache}
	if _, err := Tokenize(t.Context(), []byte("cached"), g, nil, warmOpts); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := Tokenize(ctx, []byte("cached"), g, nil, warmOpts); !errors.Is(err, context.Canceled) {
		t.Fatalf("cached canceled tokenize error = %v, want context.Canceled", err)
	}
}

type scriptedScanner struct {
	find func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error)
}

func (s *scriptedScanner) FindNextMatchCtx(ctx context.Context, text []byte, start int, opts oniguruma.SearchOptions) (*oniguruma.Match, error) {
	return s.find(ctx, text, start, opts)
}

func (*scriptedScanner) Close() error { return nil }

type scriptedLib struct {
	scanners map[string]oniguruma.OnigScanner
}

func (l *scriptedLib) NewScannerCtx(ctx context.Context, patterns [][]byte) (oniguruma.OnigScanner, error) {
	return l.GetOrCreateScannerCtx(ctx, patterns)
}

func (l *scriptedLib) GetOrCreateScannerCtx(_ context.Context, patterns [][]byte) (oniguruma.OnigScanner, error) {
	if len(patterns) == 0 {
		return nil, nil
	}
	return l.scanners[string(patterns[0])], nil
}

func (*scriptedLib) Close() error { return nil }

func TestTokenizeLineCacheRejectsCompleteLookingScannerErrors(t *testing.T) {
	calls := 0
	scanner := &scriptedScanner{find: func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error) {
		calls++
		if calls == 1 {
			return &oniguruma.Match{Index: 0, Captures: []oniguruma.Capture{{Start: 0, End: 4}}}, nil
		}
		return nil, errors.New("sentinel scan failed")
	}}
	g := &grammar.Grammar{ScopeName: "source.test", Patterns: []grammar.Rule{&grammar.MatchRule{ID: 1, Name: "keyword.test", Match: "main"}}}
	cache := NewLineCache(1 << 20)
	result, err := Tokenize(t.Context(), []byte("line"), g, &scriptedLib{scanners: map[string]oniguruma.OnigScanner{"main": scanner}}, TokenizeOptions{LineCache: cache})
	if err != nil {
		t.Fatal(err)
	}
	if !completeLineTokens([]byte("line"), result.Lines[0]) {
		t.Fatalf("test setup did not cover the complete bare line: %+v", result.Lines)
	}
	if stats := cache.Stats(); stats.Stores != 0 {
		t.Fatalf("errored complete-looking line cache stats = %+v, want no stores", stats)
	}
}

func TestTokenizeLineCacheRejectsNestedCaptureErrors(t *testing.T) {
	outerCalls := 0
	outer := &scriptedScanner{find: func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error) {
		outerCalls++
		if outerCalls == 1 {
			captures := []oniguruma.Capture{{Start: 0, End: 4}, {Start: 0, End: 4}}
			return &oniguruma.Match{Index: 0, Captures: captures}, nil
		}
		return nil, nil
	}}
	nested := &scriptedScanner{find: func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error) {
		return nil, errors.New("nested scan failed")
	}}
	capture := &grammar.CaptureRule{ID: 2, Patterns: []grammar.Rule{&grammar.MatchRule{ID: 3, Match: "nested"}}}
	g := &grammar.Grammar{ScopeName: "source.test", Patterns: []grammar.Rule{&grammar.MatchRule{ID: 1, Match: "outer", Captures: grammar.Captures{"1": capture}}}}
	cache := NewLineCache(1 << 20)
	lib := &scriptedLib{scanners: map[string]oniguruma.OnigScanner{"outer": outer, "nested": nested}}
	if _, err := Tokenize(t.Context(), []byte("line"), g, lib, TokenizeOptions{LineCache: cache}); err != nil {
		t.Fatal(err)
	}
	if stats := cache.Stats(); stats.Stores != 0 {
		t.Fatalf("nested-error line cache stats = %+v, want no stores", stats)
	}
}

func TestTokenizeLineCacheRejectsInjectionErrors(t *testing.T) {
	selector, err := grammar.ParseSelector("L:source.test")
	if err != nil {
		t.Fatal(err)
	}
	g := &grammar.Grammar{
		ScopeName: "source.test",
		Injections: []grammar.Injection{{
			Selector: selector,
			Rule:     &grammar.MatchRule{ID: 1, Match: "injection"},
		}},
	}
	scanner := &scriptedScanner{find: func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error) {
		return nil, errors.New("injection scan failed")
	}}
	cache := NewLineCache(1 << 20)
	lib := &scriptedLib{scanners: map[string]oniguruma.OnigScanner{"injection": scanner}}
	if _, err := Tokenize(t.Context(), []byte("line"), g, lib, TokenizeOptions{LineCache: cache}); err != nil {
		t.Fatal(err)
	}
	if stats := cache.Stats(); stats.Stores != 0 {
		t.Fatalf("injection-error line cache stats = %+v, want no stores", stats)
	}
}

func TestTokenizeLineCacheTaintsStateAfterWhileError(t *testing.T) {
	beginCalls := 0
	begin := &scriptedScanner{find: func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error) {
		beginCalls++
		if beginCalls == 1 {
			return &oniguruma.Match{Index: 0, Captures: []oniguruma.Capture{{Start: 0, End: 4}}}, nil
		}
		return nil, nil
	}}
	while := &scriptedScanner{find: func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error) {
		return nil, errors.New("while scan failed")
	}}
	rule := &grammar.BeginWhileRule{ID: 1, Begin: "begin", While: "while"}
	g := &grammar.Grammar{ScopeName: "source.test", Patterns: []grammar.Rule{rule}}
	cache := NewLineCache(1 << 20)
	lib := &scriptedLib{scanners: map[string]oniguruma.OnigScanner{"begin": begin, "while": while}}
	if _, err := Tokenize(t.Context(), []byte("line\nnext\nafter"), g, lib, TokenizeOptions{LineCache: cache}); err != nil {
		t.Fatal(err)
	}
	if stats := cache.Stats(); stats.Stores != 1 {
		t.Fatalf("while-error cache stats = %+v, want only the clean first line stored", stats)
	}
}

func TestTokenizeReturnsCancellationObservedDuringCompleteLine(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	calls := 0
	scanner := &scriptedScanner{find: func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error) {
		calls++
		if calls == 1 {
			return &oniguruma.Match{Index: 0, Captures: []oniguruma.Capture{{Start: 0, End: 4}}}, nil
		}
		cancel()
		return nil, context.Canceled
	}}
	g := &grammar.Grammar{ScopeName: "source.test", Patterns: []grammar.Rule{&grammar.MatchRule{ID: 1, Match: "main"}}}
	cache := NewLineCache(1 << 20)
	lib := &scriptedLib{scanners: map[string]oniguruma.OnigScanner{"main": scanner}}
	if _, err := Tokenize(ctx, []byte("line"), g, lib, TokenizeOptions{LineCache: cache}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Tokenize() error = %v, want context.Canceled", err)
	}
	if stats := cache.Stats(); stats.Stores != 0 {
		t.Fatalf("canceled line cache stats = %+v, want no stores", stats)
	}
}

func TestLineCacheBoundsRetainedDataAndClonesOutputState(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	cache := NewLineCache(700)
	opts := TokenizeOptions{LineCache: cache}
	input := newStateStack(nil, g.ScopeName)
	firstOutput := input.clone()
	firstOutput.frames[0].NameScope = "source.first"
	cache.store([]byte("first"), g, nil, opts, false, input, []Token{{Scopes: []string{"source.first"}, End: 5}}, firstOutput)

	tokens, output, ok := cache.lookup([]byte("first"), g, nil, opts, false, input)
	if !ok {
		t.Fatal("expected cached first line")
	}
	tokens[0].Scopes[0] = "consumer mutation"
	output.frames[0].NameScope = "consumer mutation"
	tokens, output, ok = cache.lookup([]byte("first"), g, nil, opts, false, input)
	if !ok || tokens[0].Scopes[0] != "source.first" || output.frames[0].NameScope != "source.first" {
		t.Fatalf("cache returned shared data: tokens=%+v state=%+v", tokens, output.frames)
	}

	secondOutput := input.clone()
	secondOutput.frames[0].NameScope = "source.second"
	cache.store([]byte("second"), g, nil, opts, false, input, []Token{{Scopes: []string{"source.second"}, End: 6}}, secondOutput)
	stats := cache.Stats()
	if stats.Bytes > 700 || stats.Entries > 1 {
		t.Fatalf("cache exceeded budget: %+v", stats)
	}
	if _, _, ok := cache.lookup([]byte("first"), g, nil, opts, false, input); ok {
		t.Fatal("oldest entry survived bounded eviction")
	}
}

func TestLineCacheEvictionDropsRemovedBucketReference(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	cache := NewLineCache(1 << 20)
	opts := TokenizeOptions{LineCache: cache}
	states := make([]*StateStack, 3)
	for i, name := range []string{"one", "two", "three"} {
		states[i] = newStateStack(nil, name)
		cache.store([]byte("line"), g, nil, opts, false, states[i], []Token{{Start: 0, End: 4}}, states[i])
	}
	key := makeLineCacheKey("line", g, resolverKey{}, opts, false)
	removed := cache.entries[key][2]

	cache.lookup([]byte("line"), g, nil, opts, false, states[0])
	cache.lookup([]byte("line"), g, nil, opts, false, states[1])
	cache.removeOldest()

	bucket := cache.entries[key]
	backing := bucket[:cap(bucket)]
	if len(backing) > len(bucket) && backing[len(bucket)] == removed {
		t.Fatal("evicted entry remains referenced by the retained bucket backing array")
	}
}

func TestCompleteLineTokensRejectsPartialOrInvalidCoverage(t *testing.T) {
	tests := []struct {
		name   string
		line   string
		tokens []Token
		want   bool
	}{
		{name: "empty", want: true},
		{name: "complete", line: "line", tokens: []Token{{Start: 0, End: 2}, {Start: 2, End: 4}}, want: true},
		{name: "missing suffix", line: "line", tokens: []Token{{Start: 0, End: 2}}},
		{name: "missing prefix", line: "line", tokens: []Token{{Start: 1, End: 4}}},
		{name: "gap", line: "line", tokens: []Token{{Start: 0, End: 1}, {Start: 2, End: 4}}},
		{name: "past end", line: "line", tokens: []Token{{Start: 0, End: 5}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := completeLineTokens([]byte(test.line), test.tokens); got != test.want {
				t.Fatalf("completeLineTokens() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestLineCacheKeyIncludesTokenizerOwnershipAndOptions(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	otherGrammar := &grammar.Grammar{ScopeName: "source.test"}
	resolver := &cacheResolver{identity: 1}
	otherResolver := &cacheResolver{identity: 2}
	input := newStateStack(nil, g.ScopeName)
	output := input.clone()
	cache := NewLineCache(1 << 20)
	tokens := []Token{{Scopes: []string{"source.test"}, End: 4}}
	opts := TokenizeOptions{MaxLineLength: 100, TimeoutMs: 5, LineCache: cache}

	cache.store([]byte("line"), g, resolver, opts, false, input, tokens, output)
	tests := []struct {
		name      string
		line      []byte
		grammar   *grammar.Grammar
		resolver  grammar.GrammarResolver
		opts      TokenizeOptions
		firstLine bool
	}{
		{name: "line text", line: []byte("LINE"), grammar: g, resolver: resolver, opts: opts},
		{name: "grammar", line: []byte("line"), grammar: otherGrammar, resolver: resolver, opts: opts},
		{name: "resolver", line: []byte("line"), grammar: g, resolver: otherResolver, opts: opts},
		{name: "max line", line: []byte("line"), grammar: g, resolver: resolver, opts: TokenizeOptions{MaxLineLength: 101, TimeoutMs: 5, LineCache: cache}},
		{name: "timeout", line: []byte("line"), grammar: g, resolver: resolver, opts: TokenizeOptions{MaxLineLength: 100, TimeoutMs: 6, LineCache: cache}},
		{name: "first line", line: []byte("line"), grammar: g, resolver: resolver, opts: opts, firstLine: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, ok := cache.lookup(test.line, test.grammar, test.resolver, test.opts, test.firstLine, input); ok {
				t.Fatal("cache hit for a non-identical key")
			}
		})
	}
}

func TestStateStackEqualityCoversCompleteNormalizedState(t *testing.T) {
	beginEnd := &grammar.BeginEndRule{ID: 1}
	beginWhile := &grammar.BeginWhileRule{ID: 2}
	endCapture := &grammar.CaptureRule{ID: 3, Name: "end.capture"}
	whileCapture := &grammar.CaptureRule{ID: 4, Name: "while.capture"}
	contentGrammar := &grammar.Grammar{ScopeName: "source.embedded"}
	base := &StateStack{frames: []StackFrame{
		{Rule: beginEnd, NameScope: "source.test", AnchorPosition: -1, EnterPosition: -1},
		{
			Rule:             beginWhile,
			ContentGrammar:   contentGrammar,
			NameScope:        "meta.resolved",
			ContentScope:     "string.resolved",
			EndRule:          &grammar.EndRule{ID: 1000001, Parent: beginEnd, EndPattern: "resolved-end", EndCaptures: grammar.Captures{"1": endCapture}},
			WhileRule:        &grammar.WhileRule{ID: 2000002, Parent: beginWhile, WhilePattern: "resolved-while", WhileCaptures: grammar.Captures{"1": whileCapture}},
			BeginCapturedEOL: true,
			AnchorPosition:   -1,
			EnterPosition:    -1,
		},
	}}

	mutations := []struct {
		name string
		edit func(*StateStack)
	}{
		{name: "rule ownership", edit: func(s *StateStack) { s.frames[1].Rule = &grammar.BeginWhileRule{ID: 2} }},
		{name: "content grammar ownership", edit: func(s *StateStack) { s.frames[1].ContentGrammar = &grammar.Grammar{ScopeName: "source.embedded"} }},
		{name: "resolved name scope", edit: func(s *StateStack) { s.frames[1].NameScope = "meta.other" }},
		{name: "resolved content scope", edit: func(s *StateStack) { s.frames[1].ContentScope = "string.other" }},
		{name: "end parent", edit: func(s *StateStack) {
			end := *s.frames[1].EndRule
			end.Parent = &grammar.BeginEndRule{ID: 1}
			s.frames[1].EndRule = &end
		}},
		{name: "resolved end pattern", edit: func(s *StateStack) { end := *s.frames[1].EndRule; end.EndPattern = "other"; s.frames[1].EndRule = &end }},
		{name: "end captures", edit: func(s *StateStack) {
			end := *s.frames[1].EndRule
			end.EndCaptures = grammar.Captures{"1": &grammar.CaptureRule{ID: 3, Name: "end.capture"}}
			s.frames[1].EndRule = &end
		}},
		{name: "while parent", edit: func(s *StateStack) {
			rule := *s.frames[1].WhileRule
			rule.Parent = &grammar.BeginWhileRule{ID: 2}
			s.frames[1].WhileRule = &rule
		}},
		{name: "resolved while pattern", edit: func(s *StateStack) {
			rule := *s.frames[1].WhileRule
			rule.WhilePattern = "other"
			s.frames[1].WhileRule = &rule
		}},
		{name: "while captures", edit: func(s *StateStack) {
			rule := *s.frames[1].WhileRule
			rule.WhileCaptures = grammar.Captures{"1": &grammar.CaptureRule{ID: 4, Name: "while.capture"}}
			s.frames[1].WhileRule = &rule
		}},
		{name: "begin captured eol", edit: func(s *StateStack) { s.frames[1].BeginCapturedEOL = false }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			changed := base.clone()
			mutation.edit(changed)
			if stateStacksEqual(base, changed) {
				t.Fatal("different tokenizer states compare equal")
			}
		})
	}

	transient := base.clone()
	transient.frames[0].AnchorPosition = 9
	transient.frames[1].EnterPosition = 7
	transient.resetForNewLine()
	if !stateStacksEqual(base, transient) {
		t.Fatal("reset line transients should produce the same normalized state")
	}
}
