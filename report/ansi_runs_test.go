package report

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	charmansi "github.com/charmbracelet/x/ansi"
	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
)

// Coalescing before shaping could lose control escaping, grapheme ownership,
// comparison backgrounds, or the reset separating source rows from gutters.
func TestANSIRunsKeepWrappedRowsAndGuttersIndependent(t *testing.T) {
	text := "e\u0301界\talpha\x1b[0m omega"
	tokens := &nuri.TokensResult{Tokens: [][]nuri.ThemedToken{{{Content: text, Color: "#123456", BgColor: "#654321", FontStyle: theme.FontStyleBold | theme.FontStyleItalic | theme.FontStyleUnderline | theme.FontStyleStrikethrough}}}}
	original := fmt.Sprintf("%#v", tokens.Tokens)
	for _, kind := range []byte{' ', '-', '+'} {
		r, err := newHumanRenderer(&bytes.Buffer{}, nil, HumanOptions{Context: t.Context(), ColorProfile: ColorTrueColor, Width: 16})
		if err != nil {
			t.Fatal(err)
		}
		var out strings.Builder
		r.comparisonLine(&out, sourceLine{text: text, ending: "\n"}, tokens, comparisonRow{old: 1, new: 1, kind: kind}, 1)
		r.close()
		rows := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
		if len(rows) < 2 {
			t.Fatal("fixture did not wrap")
		}
		for _, line := range rows {
			opening := strings.IndexByte(line, '\x1b')
			if opening < 0 || !strings.HasSuffix(line, "\x1b[0m") {
				t.Fatalf("row/gutter style boundary lost: %q", line)
			}
			prefix := line[:opening]
			if !strings.HasSuffix(prefix, fmt.Sprintf("│ %c ", kind)) && !strings.HasSuffix(prefix, fmt.Sprintf("↪ %c ", kind)) {
				t.Fatalf("styling reached gutter: %q", prefix)
			}
			if strings.Contains(line, "\x1b[0m omega") {
				t.Fatal("source control reached terminal")
			}
			if kind == ' ' && strings.Count(line, "\x1b[0m") > 2 {
				t.Fatalf("equal wrapped cluster styles did not coalesce: %q", line)
			}
			background := "48;2;101;67;33"
			if kind == '-' {
				background = "48;2;58;44;50"
			}
			if kind == '+' {
				background = "48;2;44;58;50"
			}
			for _, want := range []string{"1;3;4;9", "38;2;18;52;86", background} {
				if !strings.Contains(line, want) {
					t.Fatalf("lost %s in %q", want, line)
				}
			}
		}
	}
	if got := fmt.Sprintf("%#v", tokens.Tokens); got != original {
		t.Fatal("render mutated source tokens")
	}
}

// A long coalesced run must still stream at UTF-8/CSI-safe boundaries, retain
// every byte and stop on cancellation even if no new style starts are emitted.
func TestANSICompressedRunStreamsAndCancels(t *testing.T) {
	text := strings.Repeat("界e\u0301", 30000)
	tokens := &nuri.TokensResult{Tokens: [][]nuri.ThemedToken{{{Content: text, Color: "#123456"}}}}
	r, err := newHumanRenderer(&bytes.Buffer{}, nil, HumanOptions{Context: t.Context(), ColorProfile: ColorTrueColor})
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	var encoded string
	for row := range visualRows(sourceLine{text: text}, 300000) {
		encoded = r.codeRow(row, tokens, 1, ' ', 300000)
	}
	if strings.Count(encoded, "\x1b[") != 4 {
		t.Fatal("fixture is not an initial token followed by one coalesced run")
	}
	for _, cancelAfterFirst := range []bool{false, true} {
		ctx, cancel := context.WithCancel(t.Context())
		var chunks []string
		w := &fragmentWriter{ctx: ctx, emit: func(s string) error {
			chunks = append(chunks, s)
			if cancelAfterFirst {
				cancel()
			}
			return nil
		}}
		_, err := w.WriteString(encoded)
		if cancelAfterFirst {
			if !errors.Is(err, context.Canceled) || len(chunks) != 1 {
				t.Fatalf("cancellation: chunks %d err %v", len(chunks), err)
			}
			cancel()
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(chunks) == 0 {
			t.Fatal("no progressive output")
		}
		if err := w.flush(); err != nil {
			t.Fatal(err)
		}
		cancel()
		var plain strings.Builder
		for _, s := range chunks {
			if len(s) > 65536 || !utf8.ValidString(s) {
				t.Fatal("invalid fragment")
			}
			plain.WriteString(charmansi.Strip(s))
		}
		if strings.Join(chunks, "") != encoded || plain.String() != text {
			t.Fatal("fragmented run lost or reordered text")
		}
	}
}
