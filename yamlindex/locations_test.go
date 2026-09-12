package yamlindex

import (
	"strings"
	"testing"

	"github.com/goccy/go-yaml/lexer"
	"github.com/goccy/go-yaml/token"
)

// Exact byte bounds catch normalized escape lengths, repeated-value searches,
// and accidental loss of the whitespace belonging to block scalar origins.
func TestLocateTokensPreservesTrimmedBoundsAndCompleteOrigins(t *testing.T) {
	for _, tt := range []struct {
		name, source string
		want         []TokenLocation
	}{
		{"escapes and CRLF", "x: \"\\u0061\\\"b\"\r\ny: \"\\x61\"\r\n", []TokenLocation{
			{0, 1, 1}, {1, 2, 2}, {3, 14, 14}, {16, 17, 17}, {17, 18, 18}, {19, 25, 25},
		}},
		{"tags anchors and duplicates", "x: !unsafe &a 'same'\ny: 'same'\n", []TokenLocation{
			{0, 1, 1}, {1, 2, 2}, {3, 10, 11}, {11, 12, 12}, {12, 13, 13}, {14, 20, 20}, {21, 22, 22}, {22, 23, 23}, {24, 30, 30},
		}},
		{"folded and literal", "x: >-\r\n  same\r\n  same\r\ny: |\n  hi\n\n", []TokenLocation{
			{0, 1, 1}, {1, 2, 2}, {3, 5, 7}, {9, 21, 23}, {23, 24, 24}, {24, 25, 25}, {26, 27, 28}, {30, 32, 34},
		}},
		{"empty block token", "x: |\n\ny:\n", []TokenLocation{
			{0, 1, 1}, {1, 2, 2}, {3, 4, 5}, {6, 6, 0}, {6, 7, 7}, {7, 8, 8},
		}},
		{"empty quotes", "x: \"\"\ny: ''\n", []TokenLocation{
			{0, 1, 1}, {1, 2, 2}, {3, 5, 5}, {6, 7, 7}, {7, 8, 8}, {9, 11, 11},
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := LocateTokens(tt.source, lexer.Tokenize(tt.source))
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("locations=%v, want %v", got, tt.want)
			}
			for i, want := range tt.want {
				if got[i] != want {
					t.Errorf("token %d=%+v, want %+v", i, got[i], want)
				}
			}
		})
	}
}

func TestLocationProjectionsPreserveOriginMatchingPolicy(t *testing.T) {
	// The tokens are real lexer output, but the source supplied by this caller
	// has different whitespace. Semantic indexing only promises trimmed bounds.
	tokens := lexer.Tokenize("x: !unsafe 'a'\n")
	source := "x: !unsafe\t'a'\n"
	index, err := FromTokens(source, tokens)
	if err != nil {
		t.Fatal(err)
	}
	start, end, ok := index.ScalarRange(1, 4, "a")
	if !ok || start != 11 || end != 14 {
		t.Fatalf("range=%d:%d %v", start, end, ok)
	}
	if _, err := LocateTokens(source, tokens); err == nil || !strings.Contains(err.Error(), "cannot locate original YAML token") {
		t.Fatalf("complete origins accepted: %v", err)
	}
}

func TestLocateTokensRejectsNonWhitespaceGapsAndMissingQuotes(t *testing.T) {
	for _, source := range []string{`other "later"`, `"unfinished`, `"escaped\"`, " \t\n"} {
		tokens := token.Tokens{{Type: token.DoubleQuoteType}}
		if _, err := LocateTokens(source, tokens); err == nil || err.Error() != "cannot locate double-quoted YAML scalar at byte 0" {
			t.Errorf("source %q: %v", source, err)
		}
		if _, err := FromTokens(source, tokens); err == nil || err.Error() != "cannot locate double-quoted YAML scalar at byte 0" {
			t.Errorf("index source %q: %v", source, err)
		}
	}
	tokens := lexer.Tokenize("x: same\n")
	for _, source := range []string{"other x: same\n", "x: other same\n"} {
		if _, err := LocateTokens(source, tokens); err == nil {
			t.Errorf("unverified gap accepted for %q", source)
		}
		if _, err := FromTokens(source, tokens); err == nil {
			t.Errorf("unverified index gap accepted for %q", source)
		}
	}
}

func TestRuneOffsetClampsAndCountsUnicodeCodePoints(t *testing.T) {
	source := "é😀x\r\ny\n"
	for _, tt := range []struct {
		position *token.Position
		want     int
	}{
		{nil, 0}, {&token.Position{Line: 0, Column: 2}, 0},
		{&token.Position{Line: 1, Column: 2}, 2}, {&token.Position{Line: 1, Column: 3}, 6},
		{&token.Position{Line: 1, Column: 99}, 8}, {&token.Position{Line: 2, Column: 1}, 9},
		{&token.Position{Line: 2, Column: 0}, 9}, {&token.Position{Line: 4, Column: 1}, 11},
	} {
		if got := RuneOffset(source, []int{0, 9, 11}, tt.position); got != tt.want {
			t.Errorf("position %v=%d, want %d", tt.position, got, tt.want)
		}
	}
}

func TestLocationProjectionsPreserveWhitespaceOnlyOriginsAndErrorCursors(t *testing.T) {
	tokens := token.Tokens{{Type: token.StringType, Origin: " \r\n", Position: &token.Position{Line: 1, Column: 1}}}
	locations, err := LocateTokens(" \r\n", tokens)
	if err != nil || len(locations) != 1 || locations[0] != (TokenLocation{3, 3, 3}) {
		t.Fatalf("whitespace origin=%v, error=%v", locations, err)
	}
	index, err := FromTokens(" \r\n", tokens)
	if err != nil {
		t.Fatal(err)
	}
	start, end, ok := index.ScalarRange(1, 1, "")
	if start != 0 || end != 0 || ok {
		t.Fatalf("whitespace scalar=%d:%d %v", start, end, ok)
	}

	tokens = token.Tokens{{Type: token.StringType, Origin: "x \n"}, {Type: token.DoubleQuoteType}}
	source := "x \n\"unfinished"
	if _, err := LocateTokens(source, tokens); err == nil || err.Error() != "cannot locate double-quoted YAML scalar at byte 3" {
		t.Fatalf("complete-origin error=%v", err)
	}
	if _, err := FromTokens(source, tokens); err == nil || err.Error() != "cannot locate double-quoted YAML scalar at byte 1" {
		t.Fatalf("trimmed-origin error=%v", err)
	}
}

func TestLocateTokensAcceptsOnlySharedWhitespaceAfterBlockTags(t *testing.T) {
	for _, tt := range []struct {
		source     string
		key, value TokenLocation
	}{
		{"v: !!map\n  same: same\n", TokenLocation{11, 15, 15}, TokenLocation{17, 21, 21}},
		{"v: !!map\r\n  same: same\r\n", TokenLocation{12, 16, 16}, TokenLocation{18, 22, 23}},
	} {
		got, err := LocateTokens(tt.source, lexer.Tokenize(tt.source))
		if err != nil {
			t.Fatal(err)
		}
		if got[3] != tt.key || got[5] != tt.value {
			t.Fatalf("locations: %v", got)
		}
	}
	source := "v: !!map\n  same: same\n"
	for _, origin := range []string{"map\n  same", "\n same", "\r\n  same", "\n  missing", "\n  same: same"} {
		tokens := lexer.Tokenize(source)
		tokens[3].Origin = origin
		if _, err := LocateTokens(source, tokens); err == nil {
			t.Errorf("accepted mismatched/overlapping origin %q", origin)
		}
	}
	tokens := lexer.Tokenize(source)
	for _, changed := range []string{"v: !!map\n unexpected  same: same\n", "v: !!map\r\n  same: same\r\n"} {
		if _, err := LocateTokens(changed, tokens); err == nil {
			t.Errorf("accepted changed source %q", changed)
		}
	}
}
