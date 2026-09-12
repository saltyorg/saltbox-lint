package highlight

import (
	"context"
	"fmt"
	"strings"

	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"saltbox-lint-markdown-demo-v4/semantics"
)

// SourcePath records logical identity; Collections supplies explicit metadata
// precedence. Runtime highlighting never discovers files adjacent to SourcePath.
type DocumentOptions struct {
	SourcePath  string
	Collections []string
}
type DocumentResult struct {
	SourcePath      string             `json:"sourcePath"`
	SemanticEnabled bool               `json:"semanticEnabled"`
	SemanticTokens  []semantics.Token  `json:"semanticTokens"`
	Lexical         *nuri.TokensResult `json:"lexical"`
	Combined        *nuri.TokensResult `json:"combined"`
}

// HighlightDocument classifies and composes the complete source. The original
// lexical result and semantic ranges remain separate evidence, even when the
// theme disables the visual overlay (configuredByTheme).
func (h *Highlighter) HighlightDocument(ctx context.Context, source, name string, opts DocumentOptions) (*DocumentResult, error) {
	raw, err := h.Highlight(ctx, source, name)
	if err != nil {
		return nil, err
	}
	tokens, err := semantics.Classify(source, semantics.Options{Catalog: h.catalog, Collections: opts.Collections})
	if err != nil {
		return nil, fmt.Errorf("semantic source %q: %w", opts.SourcePath, err)
	}
	config := h.semanticThemes[name]
	result := &DocumentResult{SourcePath: opts.SourcePath, SemanticEnabled: config.enabled, SemanticTokens: tokens, Lexical: raw, Combined: raw}
	if config.enabled {
		result.Combined = overlay(source, raw, tokens, config)
	}
	return result, nil
}

func overlay(source string, raw *nuri.TokensResult, tokens []semantics.Token, config *semanticTheme) *nuri.TokensResult {
	result := *raw
	result.Tokens = make([][]nuri.ThemedToken, len(raw.Tokens))
	// Byte offsets include original line endings. Token content excludes line
	// endings; retain both conventions without rebuilding or normalizing source.
	lines := strings.SplitAfter(source, "\n")
	lineStart, semanticIndex := 0, 0
	for lineNumber, line := range raw.Tokens {
		position := lineStart
		for _, lexical := range line {
			end := position + len(lexical.Content)
			for position < end {
				for semanticIndex < len(tokens) && tokens[semanticIndex].End <= position {
					semanticIndex++
				}
				next := end
				var semantic *semantics.Token
				if semanticIndex < len(tokens) {
					candidate := &tokens[semanticIndex]
					if candidate.Start > position {
						next = min(next, candidate.Start)
					} else {
						semantic = candidate
						next = min(next, candidate.End)
					}
				}
				piece := lexical
				offset := len(lexical.Content) - (end - position)
				piece.Content = lexical.Content[offset : offset+next-position]
				if semantic != nil {
					applySemanticStyle(&piece, config.resolve(semantic.Type, semantic.Modifiers, "ansible"))
				}
				result.Tokens[lineNumber] = append(result.Tokens[lineNumber], piece)
				position = next
			}
			if lexical.Content == "" {
				result.Tokens[lineNumber] = append(result.Tokens[lineNumber], lexical)
			}
		}
		if lineNumber < len(lines) {
			lineStart += len(lines[lineNumber])
		}
	}
	return &result
}
func applySemanticStyle(token *nuri.ThemedToken, style semanticStyle) {
	if style.Foreground != "" {
		token.Color = style.Foreground
	}
	flags := []theme.FontStyle{theme.FontStyleBold, theme.FontStyleUnderline, theme.FontStyleStrikethrough, theme.FontStyleItalic}
	for i, p := range style.flags() {
		if *p == nil {
			continue
		}
		if token.FontStyle < 0 {
			token.FontStyle = theme.FontStyleNone
		}
		if **p {
			token.FontStyle |= flags[i]
		} else {
			token.FontStyle &^= flags[i]
		}
	}
}
