package highlight

import (
	"fmt"
	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestANSIUsesExactRGBAndStyles(t *testing.T) {
	got, err := ANSI([]nuri.ThemedToken{{Content: "when", Color: "#61AFEF", BgColor: "#282C34", FontStyle: theme.FontStyleItalic | theme.FontStyleBold | theme.FontStyleUnderline | theme.FontStyleStrikethrough}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"38;2;97;175;239", "48;2;40;44;52", "1;3;4;9", "when\x1b[0m"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
}

// Repeating an effective style must not multiply terminal instructions. The
// spellings differ deliberately: equality is about RGB and supported flags.
func TestANSICoalescesEquivalentAdjacentStyles(t *testing.T) {
	tokens := []nuri.ThemedToken{
		{Content: "e", Color: "#AaBbCc", BgColor: "010203", FontStyle: theme.FontStyleBold},
		{Content: "\u0301", Color: "aabbcc", BgColor: "#010203", FontStyle: theme.FontStyleBold | 16},
		{Content: "界", Color: "#AABBCC", BgColor: "#010203", FontStyle: theme.FontStyleBold},
	}
	got, err := ANSI(tokens)
	if err != nil {
		t.Fatal(err)
	}
	want := "\x1b[1;38;2;170;187;204;48;2;1;2;3me\x1b[0m\x1b[1;38;2;170;187;204;48;2;1;2;3m\u0301界\x1b[0m"
	if got != want {
		t.Fatalf("adjacent equal styles repeated instructions: got %q want %q", got, want)
	}
}

func TestANSITransitionsPreserveDefaultColorsAndFontState(t *testing.T) {
	tests := []struct {
		name   string
		tokens []nuri.ThemedToken
		want   string
	}{
		{"unset versus black", []nuri.ThemedToken{{Content: "a"}, {Content: "b", Color: "#000000"}, {Content: "c"}}, "a\x1b[38;2;0;0;0mb\x1b[0mc"},
		{"negative and unknown fonts", []nuri.ThemedToken{{Content: "a", FontStyle: theme.FontStyleNotSet}, {Content: "b", FontStyle: 16}, {Content: "c", FontStyle: -2}}, "abc"},
		{"font removal", []nuri.ThemedToken{{Content: "a", FontStyle: theme.FontStyleBold | theme.FontStyleItalic | theme.FontStyleUnderline | theme.FontStyleStrikethrough}, {Content: "b", FontStyle: theme.FontStyleItalic}}, "\x1b[1;3;4;9ma\x1b[0m\x1b[3mb\x1b[0m"},
		{"background removal", []nuri.ThemedToken{{Content: "a", BgColor: "#000000"}, {Content: "b", Color: "#000000"}}, "\x1b[48;2;0;0;0ma\x1b[0m\x1b[38;2;0;0;0mb\x1b[0m"},
		{"empty styled resets ambient", []nuri.ThemedToken{{Color: "#000000"}, {Content: "b"}}, "\x1b[38;2;0;0;0m\x1b[0mb"},
		{"ambient control before partial styles", []nuri.ThemedToken{{Content: "\x1b[31m"}, {Content: "a", FontStyle: theme.FontStyleBold}, {Content: "b", FontStyle: theme.FontStyleBold}}, "\x1b[31m\x1b[1ma\x1b[0m\x1b[1mb\x1b[0m"},
		{"embedded controls", []nuri.ThemedToken{{Content: "a\x1b[0m", FontStyle: theme.FontStyleBold}, {Content: "b", FontStyle: theme.FontStyleBold}}, "\x1b[1ma\x1b[0m\x1b[0m\x1b[1mb\x1b[0m"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ANSI(test.tokens)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("got %q want %q", got, test.want)
			}
		})
	}
}

func TestANSIRejectsInvalidRGBIncludingEmptyTokens(t *testing.T) {
	for _, rgb := range []string{"#123", "#gg0000", "#1234567", "red", "#", " 12345"} {
		for _, content := range []string{"", "x"} {
			for _, background := range []bool{false, true} {
				token := nuri.ThemedToken{Content: content, Color: rgb}
				if background {
					token.Color = ""
					token.BgColor = rgb
				}
				got, err := ANSI([]nuri.ThemedToken{{Content: "valid", Color: "#123456"}, token})
				if err == nil || got != "" {
					t.Fatalf("RGB %q empty=%t background=%t: got %q err %v", rgb, content == "", background, got, err)
				}
			}
		}
	}
}

func TestANSIDoesNotMutateTokens(t *testing.T) {
	tokens := []nuri.ThemedToken{{Content: "a", Color: "#123456", BgColor: "#654321", FontStyle: theme.FontStyleBold}, {Content: "b", Color: "#123456", BgColor: "#654321", FontStyle: theme.FontStyleBold}}
	tokens[0].Scopes = []string{"source.ansible", "entity.name.tag.ansible"}
	tokens[1].Scopes = []string{"source.ansible", "string.unquoted.ansible"}
	before := fmt.Sprintf("%#v", tokens)
	for range 2 {
		if _, err := ANSI(tokens); err != nil {
			t.Fatal(err)
		}
	}
	if got := fmt.Sprintf("%#v", tokens); got != before {
		t.Fatalf("source tokens mutated: %s", got)
	}
}

func BenchmarkANSIAdjacentStyles(b *testing.B) {
	for _, run := range []int{1, 8, 80} {
		b.Run(fmt.Sprint(run), func(b *testing.B) {
			tokens := make([]nuri.ThemedToken, 160)
			for i := range tokens {
				color := "#AABBCC"
				if i/run%2 == 1 {
					color = "#123456"
				}
				tokens[i] = nuri.ThemedToken{Content: "界", Color: color, BgColor: "#010203", FontStyle: theme.FontStyleBold}
			}
			b.ReportAllocs()
			for b.Loop() {
				got, err := ANSI(tokens)
				if err != nil {
					b.Fatal(err)
				}
				b.ReportMetric(float64(len(got)), "output-B/op")
			}
		})
	}
}

// The caller can start with ambient terminal colors/fonts. Only the first
// styled token inherits them; its original reset makes later defaults known.
func TestANSIResetsInheritedAmbientStyleBeforeCoalescing(t *testing.T) {
	tokens := []nuri.ThemedToken{{Content: "a", FontStyle: theme.FontStyleBold}, {Content: "b", FontStyle: theme.FontStyleBold}, {Content: "c", FontStyle: theme.FontStyleBold}}
	got, err := ANSI(tokens)
	if err != nil {
		t.Fatal(err)
	}
	cells := ansiTestCells(t, "\x1b[31;44;3m"+got+"z")
	want := []ansiTestCell{{'a', "31", "44", 1<<1 | 1<<3}, {'b', "", "", 1 << 1}, {'c', "", "", 1 << 1}, {'z', "", "", 0}}
	if !slices.Equal(cells, want) {
		t.Fatalf("ambient style leaked: got %+v want %+v", cells, want)
	}
	if strings.Count(got, "\x1b[1m") != 2 {
		t.Fatalf("later known-default tokens did not coalesce: %q", got)
	}
}

type ansiTestCell struct {
	char   rune
	fg, bg string
	flags  int
}

// A deliberately independent decoder of the SGR subset in these fixtures.
// Unknown instructions fail so text or style changes cannot silently disappear.
func ansiTestCells(t *testing.T, input string) []ansiTestCell {
	t.Helper()
	var cells []ansiTestCell
	var state ansiTestCell
	for len(input) > 0 {
		if strings.HasPrefix(input, "\x1b[") {
			end := strings.IndexByte(input, 'm')
			if end < 0 {
				t.Fatal("unterminated SGR")
			}
			parts := strings.Split(input[2:end], ";")
			for i := 0; i < len(parts); i++ {
				code, err := strconv.Atoi(parts[i])
				if err != nil {
					t.Fatal(err)
				}
				switch {
				case code == 0:
					state = ansiTestCell{}
				case code == 1 || code == 3 || code == 4 || code == 9:
					state.flags |= 1 << code
				case code == 39:
					state.fg = ""
				case code == 49:
					state.bg = ""
				case code >= 30 && code <= 37:
					state.fg = parts[i]
				case code >= 40 && code <= 47:
					state.bg = parts[i]
				case code == 38 || code == 48:
					if i+4 >= len(parts) || parts[i+1] != "2" {
						t.Fatal("unsupported color")
					}
					color := strings.Join(parts[i+2:i+5], ",")
					if code == 38 {
						state.fg = color
					} else {
						state.bg = color
					}
					i += 4
				default:
					t.Fatalf("unsupported SGR %d", code)
				}
			}
			input = input[end+1:]
			continue
		}
		char, size := utf8.DecodeRuneInString(input)
		input = input[size:]
		state.char = char
		cells = append(cells, state)
	}
	return cells
}

func TestANSIRawControlCallsPreserveTokenBoundaries(t *testing.T) {
	for _, control := range []string{"\x1b[31m", "\u009b31m", "\x9b31m", "\x1b]8;;open", "\x1b[38;", "\n", "\t"} {
		tokens := []nuri.ThemedToken{{Content: control}, {Content: "a", FontStyle: theme.FontStyleBold}, {Content: "b", FontStyle: theme.FontStyleBold}, {Content: "c", FontStyle: theme.FontStyleBold}}
		got, err := ANSI(tokens)
		if err != nil {
			t.Fatal(err)
		}
		want := control + "\x1b[1ma\x1b[0m\x1b[1mb\x1b[0m\x1b[1mc\x1b[0m"
		if got != want {
			t.Fatalf("control %q changed public token boundaries: got %q want %q", control, got, want)
		}
	}
}

func TestANSIEmptyStyledTokenResetsInheritedAmbientStyle(t *testing.T) {
	got, err := ANSI([]nuri.ThemedToken{{Color: "#FF0000"}, {Content: "A"}})
	if err != nil {
		t.Fatal(err)
	}
	cells := ansiTestCells(t, "\x1b[34;44;3m"+got)
	want := []ansiTestCell{{'A', "", "", 0}}
	if !slices.Equal(cells, want) {
		t.Fatalf("empty styled token did not reset inherited state: got %+v want %+v", cells, want)
	}
}
