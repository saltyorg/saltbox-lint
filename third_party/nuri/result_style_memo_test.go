package nuri

import (
	"testing"

	"github.com/frostybee/nuri/internal/tokenizer"
	"github.com/frostybee/nuri/theme"
)

func TestResultStyleMemoMatchesDirectResolutionAndExactScopes(t *testing.T) {
	thm := &theme.Theme{
		DefaultForeground: "#DEFA01",
		TokenColors: []theme.TokenColor{
			{Scopes: []string{"source.test"}, Settings: theme.TokenSettings{Foreground: "#111111"}},
			{Scopes: []string{"source.test meta"}, Settings: theme.TokenSettings{Background: "#222222"}},
			{Scopes: []string{"meta.deep"}, Settings: theme.TokenSettings{Foreground: "#333333", FontStyle: theme.FontStyleBold}},
			{Scopes: []string{"b"}, Settings: theme.TokenSettings{Foreground: "#00BB00"}},
			{Scopes: []string{"a\x00b"}, Settings: theme.TokenSettings{Foreground: "#BB0000"}},
		},
	}
	memo := newResultStyleMemo()
	tests := []struct {
		name   string
		scopes []string
		want   TokenStyle
	}{
		{
			name:   "per-property selector precedence",
			scopes: []string{"source.test", "meta.deep"},
			want:   TokenStyle{Color: "#333333", BgColor: "#222222", FontStyle: theme.FontStyleBold},
		},
		{
			name:   "default foreground and font style",
			scopes: []string{"source.test", "plain.test"},
			want:   TokenStyle{Color: "#111111", FontStyle: theme.FontStyleNone},
		},
		{
			name:   "two scopes containing no delimiter",
			scopes: []string{"a", "b"},
			want:   TokenStyle{Color: "#00BB00", FontStyle: theme.FontStyleNone},
		},
		{
			name:   "one scope containing a zero byte",
			scopes: []string{"a\x00b"},
			want:   TokenStyle{Color: "#BB0000", FontStyle: theme.FontStyleNone},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			key := scopeStackKey(tt.scopes)
			got := memo.resolve(thm, tt.scopes, key)
			if direct := resolveStyle(thm, tt.scopes); got != direct {
				t.Fatalf("memoized style = %+v, direct style = %+v", got, direct)
			}
			if got != tt.want {
				t.Fatalf("memoized style = %+v, want %+v", got, tt.want)
			}
		})
	}
	if left, right := scopeStackKey([]string{"a", "b"}), scopeStackKey([]string{"a\x00b"}); left == right {
		t.Fatalf("scope boundaries collided in key %q", left)
	}
	if forward, reverse := scopeStackKey([]string{"a", "b"}), scopeStackKey([]string{"b", "a"}); forward == reverse {
		t.Fatalf("scope order collided in key %q", forward)
	}

	other := &theme.Theme{
		DefaultForeground: "#C0FFEE",
		TokenColors: []theme.TokenColor{{
			Scopes:   []string{"b"},
			Settings: theme.TokenSettings{Foreground: "#0000BB"},
		}},
	}
	otherScopes := []string{"a", "b"}
	if got := memo.resolve(other, otherScopes, scopeStackKey(otherScopes)); got.Color != "#0000BB" {
		t.Fatalf("second theme reused first theme style: %+v", got)
	}
}

func TestResultStyleMemoReusesWithinResultAndExpiresBetweenResults(t *testing.T) {
	thm := &theme.Theme{
		DefaultForeground: "#FFFFFF",
		TokenColors: []theme.TokenColor{{
			Scopes:   []string{"keyword.test"},
			Settings: theme.TokenSettings{Foreground: "#111111"},
		}},
	}
	scopes := []string{"source.test", "keyword.test"}
	key := scopeStackKey(scopes)
	memo := newResultStyleMemo()
	first := memo.resolve(thm, scopes, key)

	thm.TokenColors[0].Settings.Foreground = "#222222"
	if got := memo.resolve(thm, scopes, key); got != first {
		t.Fatalf("same result recomputed repeated scopes: got %+v, want %+v", got, first)
	}
	if got := newResultStyleMemo().resolve(thm, scopes, key); got.Color != "#222222" {
		t.Fatalf("new result did not observe theme mutation: %+v", got)
	}
}

func TestBuildResultMultiStyleMemoPreservesThemeIdentity(t *testing.T) {
	dark := &theme.Theme{
		Name:              "dark",
		DefaultForeground: "#FFFFFF",
		DefaultBackground: "#000000",
		TokenColors: []theme.TokenColor{{
			Scopes:   []string{"keyword.test"},
			Settings: theme.TokenSettings{Foreground: "#DD0000", Background: "#220000", FontStyle: theme.FontStyleBold},
		}},
	}
	light := &theme.Theme{
		Name:              "light",
		DefaultForeground: "#000000",
		DefaultBackground: "#FFFFFF",
		TokenColors: []theme.TokenColor{{
			Scopes:   []string{"keyword.test"},
			Settings: theme.TokenSettings{Foreground: "#0000DD", Background: "#EEEEFF", FontStyle: theme.FontStyleItalic},
		}},
	}
	scopes := []string{"source.test", "keyword.test"}
	tokResult := &tokenizer.TokenizeResult{Lines: [][]tokenizer.Token{{
		{Scopes: scopes, Start: 0, End: 1},
		{Scopes: scopes, Start: 1, End: 2},
	}}}

	result := new(Highlighter).buildResultMulti(
		"xx",
		tokResult,
		map[string]*theme.Theme{"dark": dark, "light": light},
		[]string{"dark", "light"},
		"dark",
	)
	if len(result.Tokens) != 1 || len(result.Tokens[0]) != 2 {
		t.Fatalf("tokens = %+v, want one line with two tokens", result.Tokens)
	}
	wantDark := TokenStyle{Color: "#DD0000", BgColor: "#220000", FontStyle: theme.FontStyleBold}
	wantLight := TokenStyle{Color: "#0000DD", BgColor: "#EEEEFF", FontStyle: theme.FontStyleItalic}
	for i, token := range result.Tokens[0] {
		gotDark := TokenStyle{Color: token.Color, BgColor: token.BgColor, FontStyle: token.FontStyle}
		if gotDark != wantDark || token.ThemeStyles["light"] != wantLight {
			t.Fatalf("token %d styles = dark %+v light %+v, want dark %+v light %+v", i, gotDark, token.ThemeStyles["light"], wantDark, wantLight)
		}
	}
}
