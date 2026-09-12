package highlight

import (
	"context"
	"fmt"
	"strings"

	"github.com/frostybee/nuri"
	"github.com/frostybee/nuri/theme"
	"github.com/saltyorg/saltbox-lint/highlight/semantics"
	"github.com/saltyorg/saltbox-lint/yamlindex"
)

// SourcePath records logical identity; Collections supplies explicit metadata
// precedence. Runtime highlighting never discovers files adjacent to SourcePath.
type DocumentOptions struct {
	SourcePath  string
	Collections []string
	// SourceIndex may share a validated proposal lexical pass.
	SourceIndex *yamlindex.Index
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
	return h.highlightDocument(ctx, source, source, name, opts)
}

// HighlightDocumentThroughLine keeps semantic classification on the complete
// source while limiting TextMate work to the prefix needed for display.
func (h *Highlighter) HighlightDocumentThroughLine(ctx context.Context, source, name string, opts DocumentOptions, throughLine int) (*DocumentResult, error) {
	return h.highlightDocument(ctx, source, sourcePrefixThroughLine(source, throughLine), name, opts)
}

// HighlightDisplayThroughLine returns only the tokens used for presentation.
// Display enables Ansible semantic categories for every supported theme using
// that theme's own semantic rules and TextMate fallbacks. Complete evidence APIs
// continue to report and honor the theme's configured semantic enablement.
func (h *Highlighter) HighlightDisplayThroughLine(ctx context.Context, source, name string, opts DocumentOptions, throughLine int) (*nuri.TokensResult, error) {
	return h.highlightDisplay(ctx, source, name, opts, throughLine, nil)
}

// DisplayDocument owns full-source semantic tokens independently of lexical
// prefixes and themes. Its private contents are immutable and never exposed by
// returned display tokens. Callers control its lifetime; there is no global cache.
type DisplayDocument struct {
	source  string
	tokens  []semantics.Token
	err     error
	lexical *nuri.Document
}

// PrepareDisplayDocument classifies a complete document once. Invalid YAML is
// retained as a display fallback, exactly as in HighlightDisplayThroughLine.
func (h *Highlighter) PrepareDisplayDocument(ctx context.Context, source string, opts DocumentOptions) (*DisplayDocument, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	tokens, err := semantics.Classify(source, semantics.Options{Catalog: h.catalog, Collections: opts.Collections, SourceIndex: opts.SourceIndex})
	if cancellation := ctx.Err(); cancellation != nil {
		return nil, cancellation
	}
	return &DisplayDocument{source: source, tokens: tokens, err: err, lexical: h.engine.NewDocument(source)}, nil
}

// HighlightPreparedDisplayThroughLine extends display from immutable semantic
// analysis while applying the requested theme to the current lexical prefix.
func (h *Highlighter) HighlightPreparedDisplayThroughLine(ctx context.Context, document *DisplayDocument, name string, throughLine int) (*nuri.TokensResult, error) {
	if document == nil {
		return nil, fmt.Errorf("prepared display document is nil")
	}
	return h.highlightDisplay(ctx, document.source, name, DocumentOptions{}, throughLine, document)
}

func (h *Highlighter) highlightDisplay(ctx context.Context, source, name string, opts DocumentOptions, throughLine int, document *DisplayDocument) (*nuri.TokensResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var raw *nuri.TokensResult
	var err error
	if document != nil {
		raw, err = h.engine.CodeToDocumentTokens(ctx, document.lexical, throughLine, nuri.CodeToTokensOptions{Lang: "ansible", Theme: name})
		if err == nil && len(raw.Diagnostics) > 0 {
			err = fmt.Errorf("incomplete grammar tokenization: %+v", raw.Diagnostics)
		}
	} else {
		raw, err = h.HighlightThroughLine(ctx, source, name, throughLine)
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return h.overlayDisplay(ctx, source, name, opts, document, raw)
}

func (h *Highlighter) overlayDisplay(ctx context.Context, source, name string, opts DocumentOptions, document *DisplayDocument, raw *nuri.TokensResult) (*nuri.TokensResult, error) {
	var err error
	config := h.semanticThemes[name]
	if config == nil {
		return nil, fmt.Errorf("semantic theme %q is unavailable", name)
	}
	var tokens []semantics.Token
	if document != nil {
		tokens, err = document.tokens, document.err
	} else {
		tokens, err = semantics.Classify(source, semantics.Options{Catalog: h.catalog, Collections: opts.Collections, SourceIndex: opts.SourceIndex})
	}
	if err != nil {
		if cancellation := ctx.Err(); cancellation != nil {
			return nil, cancellation
		}
		return raw, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return overlay(source, raw, tokens, config), nil
}

func (h *Highlighter) highlightDocument(ctx context.Context, source, lexicalSource, name string, opts DocumentOptions) (*DocumentResult, error) {
	raw, err := h.Highlight(ctx, lexicalSource, name)
	if err != nil {
		return nil, err
	}
	tokens, err := semantics.Classify(source, semantics.Options{Catalog: h.catalog, Collections: opts.Collections, SourceIndex: opts.SourceIndex})
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

func sourcePrefixThroughLine(source string, throughLine int) string {
	if throughLine <= 0 {
		return ""
	}
	offset := 0
	for range throughLine {
		newline := strings.IndexByte(source[offset:], '\n')
		if newline < 0 {
			return source
		}
		offset += newline + 1
		if offset == len(source) {
			return source
		}
	}
	return source[:offset]
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

// WarmPreparedDisplayThroughLine retains only complete lexical checkpoints;
// full-source semantic analysis is already owned by document.
func (h *Highlighter) WarmPreparedDisplayThroughLine(ctx context.Context, document *DisplayDocument, name string, throughLine int) error {
	if document == nil {
		return fmt.Errorf("prepared display document is nil")
	}
	return h.engine.WarmDocument(ctx, document.lexical, throughLine, nuri.CodeToTokensOptions{Lang: "ansible", Theme: name})
}

// HighlightEditedDisplayThroughLine keeps semantic classification on the full
// candidate while direct lexical reuse follows validated original-byte edits.
func (h *Highlighter) HighlightEditedDisplayThroughLine(ctx context.Context, original *DisplayDocument, source, name string, opts DocumentOptions, edits []nuri.DocumentEdit, throughLine int) (*nuri.TokensResult, error) {
	if original == nil {
		return h.HighlightDisplayThroughLine(ctx, source, name, opts, throughLine)
	}
	raw, err := h.engine.CodeToEditedDocumentTokens(ctx, original.lexical, source, edits, throughLine, nuri.CodeToTokensOptions{Lang: "ansible", Theme: name})
	if err != nil {
		return nil, err
	}
	if len(raw.Diagnostics) > 0 {
		return nil, fmt.Errorf("incomplete grammar tokenization: %+v", raw.Diagnostics)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return h.overlayDisplay(ctx, source, name, opts, nil, raw)
}
