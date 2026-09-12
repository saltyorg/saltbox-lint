package nuri

import (
	"fmt"
	"runtime"
	"strings"
	"testing"

	"github.com/frostybee/nuri/internal/tokenizer"
	"github.com/frostybee/nuri/theme"
)

func BenchmarkBuildResultRepeatedScopes(b *testing.B) {
	const tokenCount = 2048
	scopes := []string{"source.test", "meta.block.test", "keyword.control.test"}
	tokens := make([]tokenizer.Token, tokenCount)
	for i := range tokens {
		tokens[i] = tokenizer.Token{Scopes: scopes, Start: i, End: i + 1}
	}
	rules := make([]theme.TokenColor, 256)
	for i := range rules {
		rules[i] = theme.TokenColor{
			Scopes:   []string{fmt.Sprintf("unused.scope.%d", i)},
			Settings: theme.TokenSettings{Foreground: "#111111"},
		}
	}
	rules = append(rules, theme.TokenColor{
		Scopes: []string{"keyword.control.test"},
		Settings: theme.TokenSettings{
			Foreground: "#ABCDEF",
			Background: "#123456",
			FontStyle:  theme.FontStyleBold,
		},
	})
	thm := &theme.Theme{
		Name:              "benchmark",
		DefaultForeground: "#FFFFFF",
		DefaultBackground: "#000000",
		TokenColors:       rules,
	}
	tokResult := &tokenizer.TokenizeResult{Lines: [][]tokenizer.Token{tokens}}
	code := strings.Repeat("x", tokenCount)
	h := new(Highlighter)

	b.ReportAllocs()
	var result *TokensResult
	for b.Loop() {
		result = h.buildResult(code, tokResult, thm)
	}
	runtime.KeepAlive(result)
}
