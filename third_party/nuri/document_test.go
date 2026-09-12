package nuri

import (
	"context"
	"errors"
	"fmt"
	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/tokenizer"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestDocumentTokensReuseWithoutSharingAndRespectBounds(t *testing.T) {
	h, err := New(t.Context(), WithGrammar("test.json", []byte(`{"scopeName":"source.test","patterns":[{"match":"foo","name":"keyword.test"}]}`)), WithTheme("test", []byte(`{"name":"test","tokenColors":[]}`)), WithAlias("test", "test.json"), WithLineCache(4096), WithDocumentCache(4096))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	opts := CodeToTokensOptions{Lang: "test", Theme: "test"}
	d := h.NewDocument("foo\nplain\nfoo\n")
	first, err := h.CodeToDocumentTokens(t.Context(), d, 3, opts)
	if err != nil {
		t.Fatal(err)
	}
	first.Tokens[0][0].Scopes[0] = "mutated"
	before := h.DocumentCacheStats()
	got, err := h.CodeToDocumentTokens(t.Context(), d, 3, opts)
	if err != nil {
		t.Fatal(err)
	}
	want, err := h.CodeToTokens(t.Context(), "foo\nplain\nfoo\n", opts)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot shares caller output: got=%+v want=%+v", got, want)
	}
	after := h.DocumentCacheStats()
	if after.Reused-before.Reused != 3 || after.Visited != before.Visited {
		t.Fatalf("stats before=%+v after=%+v", before, after)
	}
	for range 30 {
		d := h.NewDocument("foo\nplain\nfoo\n")
		if _, err := h.CodeToDocumentTokens(t.Context(), d, 3, opts); err != nil {
			t.Fatal(err)
		}
	}
	if stats := h.DocumentCacheStats(); stats.Bytes > 4096 || stats.LineBytes+stats.Bytes > 8192 {
		t.Fatalf("unbounded cache: %+v", stats)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := h.CodeToDocumentTokens(ctx, d, 3, opts); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled error=%v", err)
	}
	if err := h.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.CodeToDocumentTokens(t.Context(), d, 3, opts); err == nil {
		t.Fatal("closed highlighter reused snapshot")
	}
	if stats := h.DocumentCacheStats(); stats.Bytes != 0 {
		t.Fatalf("closed cache retains %d bytes", stats.Bytes)
	}
}

func TestDocumentTokensKeepJoinedSuffixContentAndStyles(t *testing.T) {
	h, err := New(t.Context(), WithGrammar("test.json", []byte(`{"scopeName":"source.test","patterns":[{"match":"b+","name":"keyword.test"},{"match":"c","name":"string.test"}]}`)), WithTheme("test", []byte(`{"name":"test","tokenColors":[{"scope":"keyword.test","settings":{"foreground":"#123456","fontStyle":"bold"}},{"scope":"string.test","settings":{"foreground":"#654321","fontStyle":"italic"}}]}`)), WithAlias("test", "test.json"), WithDocumentCache(1<<20))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	opts := CodeToTokensOptions{Lang: "test", Theme: "test"}
	for _, source := range []string{"a\nbbbb\nc\n", "a\nb\nc\n", "a\r\nbbbb\r\nc\r\n"} {
		t.Run(fmt.Sprintf("%q", source), func(t *testing.T) {
			document := h.NewDocument(source)
			if err := h.WarmDocument(t.Context(), document, 100, opts); err != nil {
				t.Fatal(err)
			}
			end := strings.IndexByte(source, '\n') + 1
			candidate := source[:1] + source[end:]
			got, err := h.CodeToEditedDocumentTokens(t.Context(), document, candidate, []DocumentEdit{{Start: 1, End: end}}, 100, opts)
			if err != nil {
				t.Fatal(err)
			}
			want, err := h.CodeToTokens(t.Context(), candidate, opts)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("joined suffix lost content/scopes/RGB/fonts: got=%+v want=%+v", got.Tokens, want.Tokens)
			}
			if len(got.Tokens) != 2 || len(got.Tokens[1]) != 1 || got.Tokens[1][0].Content != "c" {
				t.Fatalf("joined suffix lost literal c: %+v", got.Tokens)
			}
		})
	}
}

func TestDocumentTokensDiscardPriorSnapshotAfterDegradation(t *testing.T) {
	h, err := New(t.Context(), WithGrammar("test.json", []byte(`{"scopeName":"source.test","patterns":[]}`)), WithTheme("test", []byte(`{"name":"test","tokenColors":[]}`)), WithAlias("test", "test.json"), WithDocumentCache(1<<20))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	maximum := 2
	opts := CodeToTokensOptions{Lang: "test", Theme: "test", MaxLineLength: &maximum}
	document := h.NewDocument("ok\nlong\n")
	if _, err := h.CodeToDocumentTokens(t.Context(), document, 1, opts); err != nil {
		t.Fatal(err)
	}
	degraded, err := h.CodeToDocumentTokens(t.Context(), document, 2, opts)
	if err != nil || len(degraded.Diagnostics) != 1 {
		t.Fatalf("degraded=%+v err=%v", degraded, err)
	}
	before := h.DocumentCacheStats()
	if _, err := h.CodeToDocumentTokens(t.Context(), document, 1, opts); err != nil {
		t.Fatal(err)
	}
	after := h.DocumentCacheStats()
	if after.Reused != before.Reused {
		t.Fatalf("degraded document retained prior snapshot: before=%+v after=%+v", before, after)
	}
}

func TestDocumentTokensMatchUncachedMultilineAndFirstLineGrammar(t *testing.T) {
	grammarData := []byte(`{"scopeName":"source.test","patterns":[{"match":"\\Afirst","name":"keyword.first"},{"begin":"^BEGIN ([A-Z]+)$","end":"^END \\1$","name":"string.region","beginCaptures":{"1":{"name":"entity.label"}},"endCaptures":{"0":{"name":"punctuation.end"}},"patterns":[{"match":"(inner)","captures":{"1":{"patterns":[{"match":"inner","name":"keyword.inner"}]}}}]},{"begin":"^WHILE$","while":"^>","name":"meta.while","whileCaptures":{"0":{"name":"punctuation.while"}}}]}`)
	h, err := New(t.Context(), WithGrammar("test.json", grammarData), WithTheme("test", []byte(`{"name":"test","tokenColors":[]}`)), WithAlias("test", "test.json"), WithDocumentCache(1<<20))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	opts := CodeToTokensOptions{Lang: "test", Theme: "test"}
	source := "first\nBEGIN A\ninner\nEND A\nWHILE\n> inner\nplain\n"
	document := h.NewDocument(source)
	if err := h.WarmDocument(t.Context(), document, 100, opts); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, source string
		edits        []DocumentEdit
	}{
		{"first line moved", "other\n" + source, []DocumentEdit{{Start: 0, Text: "other\n"}}},
		{"backreference changed", strings.Replace(source, "BEGIN A", "BEGIN B", 1), []DocumentEdit{{Start: 6, End: 13, Text: "BEGIN B"}}},
		{"while ended", strings.Replace(source, "> inner", "inner", 1), []DocumentEdit{{Start: 32, End: 34}}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			before := h.DocumentCacheStats()
			got, err := h.CodeToEditedDocumentTokens(t.Context(), document, test.source, test.edits, 100, opts)
			if h.DocumentCacheStats().Reused == before.Reused {
				t.Fatal("fixture did not validate edits and exercise checkpoint reuse")
			}
			if err != nil {
				t.Fatal(err)
			}
			want, err := h.CodeToTokens(t.Context(), test.source, opts)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatal("checkpoint differs from uncached grammar")
			}
		})
	}
	// Loading a replacement grammar must invalidate both direct and line contexts.
	if err := h.LoadLanguage("test.json", []byte(`{"scopeName":"source.test","patterns":[{"match":"first","name":"changed.first"}]}`)); err != nil {
		t.Fatal(err)
	}
	before := h.DocumentCacheStats()
	got, err := h.CodeToDocumentTokens(t.Context(), document, 100, opts)
	if err != nil {
		t.Fatal(err)
	}
	want, err := h.CodeToTokens(t.Context(), source, opts)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) || h.DocumentCacheStats().Reused != before.Reused {
		t.Fatal("grammar replacement reused stale context")
	}
}

func TestDocumentCachePinsRemainChargedDuringEviction(t *testing.T) {
	source := "first\nsecond\n"
	_, snapshot, _, err := tokenizer.TokenizeDocument(t.Context(), source, 2, &grammar.Grammar{ScopeName: "source.test"}, nil, tokenizer.TokenizeOptions{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	cache := newDocumentCache(1800)
	original := &Document{source: source}
	other := &Document{source: source}
	cache.store(original, snapshot)
	borrowed, release := cache.acquire(original)
	if borrowed == nil {
		t.Fatal("fixture did not fit first checkpoint")
	}
	before := cache.bytes
	cache.store(other, snapshot)
	if cache.bytes != before || cache.bytes > 1800 {
		t.Fatalf("pinned charge changed from %d to %d", before, cache.bytes)
	}
	absent, done := cache.acquire(other)
	done()
	if absent != nil {
		t.Fatal("new snapshot bypassed the pinned budget")
	}
	cache.invalidate(original)
	if cache.bytes != before {
		t.Fatal("invalidation stopped charging a borrowed snapshot")
	}
	excluded, done := cache.acquire(original)
	done()
	if excluded != nil {
		t.Fatal("invalidated snapshot remained reusable")
	}
	release()
	if cache.bytes != 0 {
		t.Fatal("final borrower did not release invalidated snapshot")
	}
	cache.store(other, snapshot)
	present, done := cache.acquire(other)
	defer done()
	if present == nil {
		t.Fatal("released capacity was not reusable")
	}
}

func TestDocumentTokensAreIndependentAcrossConcurrentBorrowers(t *testing.T) {
	h, err := New(t.Context(), WithGrammar("test.json", []byte(`{"scopeName":"source.test","patterns":[{"match":"foo","name":"keyword.test"}]}`)), WithTheme("test", []byte(`{"name":"test","tokenColors":[]}`)), WithAlias("test", "test.json"), WithPoolSize(8), WithLineCache(8192), WithDocumentCache(8192))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	source := "foo\nplain\nfoo\n"
	document := h.NewDocument(source)
	opts := CodeToTokensOptions{Lang: "test", Theme: "test"}
	if err := h.WarmDocument(t.Context(), document, 3, opts); err != nil {
		t.Fatal(err)
	}
	want, err := h.CodeToTokens(t.Context(), source, opts)
	if err != nil {
		t.Fatal(err)
	}
	failures := make(chan error, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			for range 10 {
				got, err := h.CodeToDocumentTokens(t.Context(), document, 3, opts)
				if err != nil {
					failures <- err
					return
				}
				if !reflect.DeepEqual(got, want) {
					failures <- fmt.Errorf("shared checkpoint changed under concurrent output mutation")
					return
				}
				got.Tokens[0][0].Scopes[0] = "mutated"
			}
		})
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if stats := h.DocumentCacheStats(); stats.Bytes+stats.LineBytes > 16384 {
		t.Fatalf("concurrent cache exceeded combined allowance: %+v", stats)
	}
}
