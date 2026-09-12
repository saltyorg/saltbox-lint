package highlight

import (
	"encoding/json"
	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"os"
	"slices"
	"strings"
	"testing"
)

// Fixtures are independently produced by VS Code TextMate 9.3.2 + Oniguruma
// 1.7.0, using the original installed grammars and unnormalized theme assets.
// Compare every source character to allow harmless equivalent token boundaries.
func TestCompleteSourceMatchesVSCode(t *testing.T) {
	source, err := os.ReadFile("testdata/compatibility.yaml")
	if err != nil {
		t.Fatal(err)
	}
	h, err := New(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close(t.Context())
	for _, variant := range []struct{ name, theme string }{{"dark", "one-dark-pro"}, {"light", "one-light"}} {
		t.Run(variant.name, func(t *testing.T) {
			data, err := os.ReadFile("testdata/oracle-" + variant.name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			var oracle struct {
				Tokens []struct {
					Line      int             `json:"line"`
					Text      string          `json:"text"`
					Scopes    []string        `json:"scopes"`
					Color     string          `json:"color"`
					FontStyle theme.FontStyle `json:"fontStyle"`
				} `json:"tokens"`
			}
			if err := json.Unmarshal(data, &oracle); err != nil {
				t.Fatal(err)
			}
			got, err := h.Highlight(t.Context(), string(source), variant.theme)
			if err != nil {
				t.Fatal(err)
			}
			want := make([][]nuri.ThemedToken, len(got.Tokens))
			for _, token := range oracle.Tokens {
				want[token.Line-1] = append(want[token.Line-1], nuri.ThemedToken{Content: token.Text, Scopes: token.Scopes, Color: token.Color, FontStyle: token.FontStyle})
			}
			for i, line := range got.Tokens {
				actual, expected := characters(line), characters(want[i])
				if len(actual) != len(expected) {
					t.Fatalf("line %d character count %d != %d", i+1, len(actual), len(expected))
				}
				for column, token := range actual {
					other := expected[column]
					if token.Content != other.Content || !slices.Equal(token.Scopes, other.Scopes) || !strings.EqualFold(token.Color, other.Color) || token.FontStyle != other.FontStyle {
						t.Errorf("line %d column %d got %+v; oracle %+v", i+1, column+1, token, other)
					}
				}
			}
		})
	}
}

func characters(tokens []nuri.ThemedToken) []nuri.ThemedToken {
	var chars []nuri.ThemedToken
	for _, token := range tokens {
		for _, char := range token.Content {
			copy := token
			copy.Content = string(char)
			chars = append(chars, copy)
		}
	}
	return chars
}
