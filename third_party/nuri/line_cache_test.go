package nuri

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
)

func TestLineCacheOptionPreservesOutputAndIsConcurrentSafe(t *testing.T) {
	h, err := New(t.Context(),
		WithPoolSize(2),
		WithMinContrast(0),
		WithLineCache(1<<20),
		WithGrammar("test", []byte(`{"scopeName":"source.test","patterns":[{"match":"foo","name":"keyword.test"}]}`)),
		WithTheme("test", []byte(`{"name":"test","colors":{"editor.foreground":"#FFFFFF","editor.background":"#000000"},"tokenColors":[{"scope":"keyword.test","settings":{"foreground":"#123456","fontStyle":"bold"}}]}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := h.Close(t.Context()); err != nil {
			t.Errorf("close highlighter: %v", err)
		}
	}()

	opts := CodeToTokensOptions{Lang: "test", Theme: "test"}
	want, err := h.CodeToTokens(t.Context(), "foo\nplain", opts)
	if err != nil {
		t.Fatal(err)
	}
	want.Tokens[0][0].Scopes[0] = "consumer mutation"

	const workers = 8
	results := make(chan *TokensResult, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			result, err := h.CodeToTokens(t.Context(), "foo\nplain", opts)
			results <- result
			errs <- err
		})
	}
	wg.Wait()
	close(results)
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var baseline *TokensResult
	for result := range results {
		if baseline == nil {
			baseline = result
			continue
		}
		if !reflect.DeepEqual(result, baseline) {
			t.Fatalf("concurrent cached result differs:\n got=%+v\nwant=%+v", result, baseline)
		}
	}
	if got := baseline.Tokens[0][0].Scopes[0]; got == "consumer mutation" {
		t.Fatal("consumer mutation poisoned cached token scopes")
	}
	if stats := h.lineCache.Stats(); stats.Hits == 0 {
		t.Fatalf("cache stats = %+v, want reuse", stats)
	}

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := h.CodeToTokens(ctx, "foo\nplain", opts); !errors.Is(err, context.Canceled) {
		t.Fatalf("cached canceled highlight error = %v, want context.Canceled", err)
	}
}
