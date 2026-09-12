package tokenizer

import (
	"context"
	"errors"
	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
	"reflect"
	"strings"
	"testing"
	"unsafe"
)

func TestDocumentCheckpointsResumeAndConverge(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	source := "first\nsecond\nthird\nfourth\n"
	_, original, initial, err := TokenizeDocument(t.Context(), source, 4, g, nil, TokenizeOptions{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Visited != 4 || original == nil {
		t.Fatalf("initial=%+v snapshot=%v", initial, original)
	}
	got, next, stats, err := TokenizeDocument(t.Context(), "first\nSECOND\nthird\nfourth\n", 4, g, nil, TokenizeOptions{}, original, []Edit{{Start: 6, End: 12, Text: "SECOND"}})
	if err != nil {
		t.Fatal(err)
	}
	want, err := Tokenize(t.Context(), []byte("first\nSECOND\nthird\nfourth\n"), g, nil, TokenizeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got=%+v want=%+v", got, want)
	}
	t.Logf("initial=%+v edited=%+v retained=%d bytes", initial, stats, next.Bytes())
	if stats.Visited != 1 || stats.Reused != 3 || next == nil {
		t.Fatalf("edit stats=%+v", stats)
	}
	_, _, stats, err = TokenizeDocument(t.Context(), source, 2, g, nil, TokenizeOptions{}, original, nil)
	if err != nil || stats.Visited != 0 || stats.Reused != 2 {
		t.Fatalf("repeat stats=%+v err=%v", stats, err)
	}
}

// Equal grammar state cannot authorize tokens from a different physical line.
// Joining a boundary must advance both suffix offsets past the same newline.
func TestDocumentCheckpointsAlignEditedPhysicalLines(t *testing.T) {
	cases := []struct {
		name, source, candidate string
		edits                   []Edit
	}{
		{"delete LF", "a\nbbbb\nc\n", "abbbb\nc\n", []Edit{{Start: 1, End: 2}}},
		{"replace line without terminator", "a\nbbbb\nc\n", "zbbbb\nc\n", []Edit{{Start: 0, End: 2, Text: "z"}}},
		{"delete CRLF", "a\r\nbbbb\r\nc\r\n", "abbbb\r\nc\r\n", []Edit{{Start: 1, End: 3}}},
		{"delete LF after CR", "a\r\nbbbb\r\nc\r\n", "a\rbbbb\r\nc\r\n", []Edit{{Start: 2, End: 3}}},
		{"insert text at boundary", "a\nbbbb\nc\n", "a\nxbbbb\nc\n", []Edit{{Start: 2, End: 2, Text: "x"}}},
		{"insert LF within line", "aaaa\nbb\nc\n", "aa\naa\nbb\nc\n", []Edit{{Start: 2, End: 2, Text: "\n"}}},
		{"insert CRLF within line", "aaaa\r\nbb\r\nc\r\n", "aa\r\naa\r\nbb\r\nc\r\n", []Edit{{Start: 2, End: 2, Text: "\r\n"}}},
		{"replace within line", "aaaa\nbb\nc\n", "axa\nbb\nc\n", []Edit{{Start: 1, End: 3, Text: "x"}}},
		{"join before unterminated EOF", "a\nbbbb\nc", "abbbb\nc", []Edit{{Start: 1, End: 2}}},
		{"multiple edits ending at joined boundary", "aa\nbbbb\nc\nddd\n", "za\nbbbbc\nddd\n", []Edit{{Start: 0, End: 1, Text: "z"}, {Start: 7, End: 8}}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			g := &grammar.Grammar{ScopeName: "source.test"}
			_, original, _, err := TokenizeDocument(t.Context(), test.source, 100, g, nil, TokenizeOptions{}, nil, nil)
			if err != nil || original == nil {
				t.Fatalf("original snapshot=%v err=%v", original, err)
			}
			want, err := Tokenize(t.Context(), []byte(test.candidate), g, nil, TokenizeOptions{})
			if err != nil {
				t.Fatal(err)
			}
			got, _, _, err := TokenizeDocument(t.Context(), test.candidate, 100, g, nil, TokenizeOptions{}, original, test.edits)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("physical-line tokens differ: got=%+v want=%+v", got.Lines, want.Lines)
			}
		})
	}
}

// Exhaustive short edits exercise both sides of every LF/CRLF boundary,
// including empty lines and edits that split or create a terminator.
func TestDocumentCheckpointsMatchEveryShortPhysicalLineEdit(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	sources := []string{""}
	frontier := []string{""}
	for range 4 {
		var next []string
		for _, prefix := range frontier {
			for _, char := range []byte{'a', 'b', '\r', '\n'} {
				next = append(next, prefix+string(char))
			}
		}
		sources = append(sources, next...)
		frontier = next
	}
	checked := 0
	for _, source := range sources {
		_, original, _, err := TokenizeDocument(t.Context(), source, 100, g, nil, TokenizeOptions{}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		for start := 0; start <= len(source); start++ {
			for end := start; end <= len(source); end++ {
				for _, replacement := range []string{"", "x", "\n", "\r", "\r\n", "x\n", "\nx"} {
					candidate := source[:start] + replacement + source[end:]
					got, _, _, err := TokenizeDocument(t.Context(), candidate, 100, g, nil, TokenizeOptions{}, original, []Edit{{Start: start, End: end, Text: replacement}})
					if err != nil {
						t.Fatal(err)
					}
					want, err := Tokenize(t.Context(), []byte(candidate), g, nil, TokenizeOptions{})
					if err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("source=%q edit=[%d,%d) %q: got=%+v want=%+v", source, start, end, replacement, got, want)
					}
					checked++
				}
			}
		}
	}
	t.Logf("matched %d complete uncached edit oracles", checked)
}

func TestDocumentCheckpointsRejectStaleAndOverlappingEdits(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	_, original, _, err := TokenizeDocument(t.Context(), "first\nsecond\nthird\n", 3, g, nil, TokenizeOptions{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, edits := range [][]Edit{nil, {{Start: 6, End: 12, Text: "WRONG"}}, {{Start: 6, End: 12, Text: "SECOND"}, {Start: 7, End: 8, Text: "x"}}, {{Start: -1, Text: "x"}}} {
		got, _, stats, err := TokenizeDocument(t.Context(), "first\nSECOND\nthird\n", 3, g, nil, TokenizeOptions{}, original, edits)
		if err != nil {
			t.Fatal(err)
		}
		if stats.Reused != 0 || len(got.Lines) != 3 {
			t.Fatalf("invalid edits reused snapshot: %+v", stats)
		}
	}
}

func TestDocumentCheckpointsNeverPublishDegradedOrCanceledSnapshots(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	result, snapshot, _, err := TokenizeDocument(t.Context(), "long\nx", 2, g, nil, TokenizeOptions{MaxLineLength: 1}, nil, nil)
	if err != nil || len(result.Diagnostics) != 1 || snapshot != nil {
		t.Fatalf("degraded result=%+v snapshot=%v err=%v", result, snapshot, err)
	}
	_, original, _, err := TokenizeDocument(t.Context(), "a\nb", 2, g, nil, TokenizeOptions{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, snapshot, _, err = TokenizeDocument(ctx, "a\nb", 2, g, nil, TokenizeOptions{}, original, nil)
	if !errors.Is(err, context.Canceled) || snapshot != nil {
		t.Fatalf("cancel snapshot=%v err=%v", snapshot, err)
	}
}

func TestDocumentCheckpointsRejectInvalidNoOpEditMaps(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	source := "first\nsecond\n"
	_, snapshot, _, err := TokenizeDocument(t.Context(), source, 2, g, nil, TokenizeOptions{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, edits := range [][]Edit{{{Start: -1, Text: ""}}, {{Start: 0, End: 2, Text: "fi"}, {Start: 1, End: 2, Text: "i"}}, {{Start: 0, Text: ""}, {Start: 0, Text: ""}}} {
		_, _, stats, err := TokenizeDocument(t.Context(), source, 2, g, nil, TokenizeOptions{}, snapshot, edits)
		if err != nil {
			t.Fatal(err)
		}
		if stats.Reused != 0 {
			t.Fatalf("invalid identical-source edit map reused %d lines", stats.Reused)
		}
	}
}

func TestDocumentCheckpointsInvalidateGrammarResolverAndSafety(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	resolver := &cacheResolver{identity: 1}
	opts := TokenizeOptions{MaxLineLength: 100, TimeoutMs: 5}
	_, snapshot, _, err := TokenizeDocument(t.Context(), "first\nsecond\n", 2, g, nil, opts, nil, nil, resolver)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		g        *grammar.Grammar
		resolver grammar.GrammarResolver
		opts     TokenizeOptions
	}{
		{"grammar", &grammar.Grammar{ScopeName: "source.test"}, resolver, opts},
		{"resolver", g, &cacheResolver{identity: 2}, opts},
		{"length", g, resolver, TokenizeOptions{MaxLineLength: 99, TimeoutMs: 5}},
		{"timeout", g, resolver, TokenizeOptions{MaxLineLength: 100, TimeoutMs: 6}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, _, stats, err := TokenizeDocument(t.Context(), "first\nsecond\n", 2, test.g, nil, test.opts, snapshot, nil, test.resolver)
			if err != nil {
				t.Fatal(err)
			}
			if stats.Reused != 0 {
				t.Fatalf("different context reused %d lines", stats.Reused)
			}
		})
	}
}

func TestDocumentCheckpointsRejectHiddenScannerFailure(t *testing.T) {
	calls := 0
	scanner := &scriptedScanner{find: func(context.Context, []byte, int, oniguruma.SearchOptions) (*oniguruma.Match, error) {
		calls++
		if calls == 1 {
			return &oniguruma.Match{Index: 0, Captures: []oniguruma.Capture{{Start: 0, End: 4}}}, nil
		}
		return nil, errors.New("sentinel scan failed")
	}}
	g := &grammar.Grammar{ScopeName: "source.test", Patterns: []grammar.Rule{&grammar.MatchRule{ID: 1, Name: "keyword.test", Match: "main"}}}
	result, snapshot, _, err := TokenizeDocument(t.Context(), "line", 1, g, &scriptedLib{scanners: map[string]oniguruma.OnigScanner{"main": scanner}}, TokenizeOptions{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !completeLineTokens([]byte("line"), result.Lines[0]) {
		t.Fatal("fixture did not look complete")
	}
	if snapshot != nil {
		t.Fatal("hidden scan error published a checkpoint")
	}
}

type documentInjectionResolver struct{ failed bool }

func (*documentInjectionResolver) GetGrammarByScope(string) (*grammar.Grammar, error) {
	return nil, nil
}
func (r *documentInjectionResolver) GetInjectors(string) ([]*grammar.Grammar, error) {
	if r.failed {
		return nil, errors.New("injection resolver failed")
	}
	return nil, nil
}

func TestDocumentCheckpointsCheckResolverBeforeCompleteReuse(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	resolver := &documentInjectionResolver{}
	_, snapshot, _, err := TokenizeDocument(t.Context(), "first\nsecond", 2, g, nil, TokenizeOptions{}, nil, nil, resolver)
	if err != nil {
		t.Fatal(err)
	}
	resolver.failed = true
	_, next, stats, err := TokenizeDocument(t.Context(), "first\nsecond", 2, g, nil, TokenizeOptions{}, snapshot, nil, resolver)
	if err != nil {
		t.Fatal(err)
	}
	if next != nil || stats.Reused != 0 {
		t.Fatalf("failed resolver reused snapshot: next=%v stats=%+v", next, stats)
	}
}

func TestDocumentCheckpointsRejectPanicAndCancellationAfterPrefix(t *testing.T) {
	g := &grammar.Grammar{ScopeName: "source.test"}
	_, snapshot, _, err := TokenizeDocument(t.Context(), "first\nsecond\nthird", 3, g, nil, TokenizeOptions{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	panicOnLineHook = 1
	t.Cleanup(func() { panicOnLineHook = -1 })
	result, next, stats, err := TokenizeDocument(t.Context(), "first\nSECOND\nthird", 3, g, nil, TokenizeOptions{}, snapshot, []Edit{{Start: 6, End: 12, Text: "SECOND"}})
	if err != nil {
		t.Fatal(err)
	}
	if next != nil || len(result.Diagnostics) != 1 || result.Diagnostics[0].Kind != "panic" || stats.Reused != 1 {
		t.Fatalf("panic snapshot=%v diagnostics=%+v stats=%+v", next, result.Diagnostics, stats)
	}
}

func TestDocumentBudgetChargesResolvedBoundaryRuleStorage(t *testing.T) {
	const count = 200
	snapshot := &DocumentSnapshot{records: make([]documentLine, count)}
	for i := range count {
		end := &grammar.EndRule{EndPattern: strings.Repeat("x", 128)}
		snapshot.records[i] = documentLine{outgoing: &StateStack{frames: []StackFrame{{EndRule: end}}}}
	}
	minimum := count * (int(unsafe.Sizeof(documentLine{})) + int(unsafe.Sizeof(StateStack{})) + int(unsafe.Sizeof(StackFrame{})) + int(unsafe.Sizeof(grammar.EndRule{})) + 128)
	if got := snapshot.Bytes(); got < minimum {
		t.Fatalf("snapshot charge %d omits retained storage; need at least %d", got, minimum)
	}
}

func TestLineCacheBudgetChargesCompleteTokenStorage(t *testing.T) {
	entry := &lineCacheEntry{tokens: make([]Token, 200)}
	if got, want := lineCacheEntryBytes(entry), 200*int(unsafe.Sizeof(Token{})); got < want {
		t.Fatalf("token charge=%d below retained token slots=%d", got, want)
	}
}
