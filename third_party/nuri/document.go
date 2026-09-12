package nuri

import (
	"context"
	"fmt"
	"strings"

	"github.com/frostybee/nuri/internal/oniguruma"
	"github.com/frostybee/nuri/internal/tokenizer"
)

// Document is an immutable source identity owned by one Highlighter. Checkpoints
// live in its bounded cache, so retaining a handle cannot pin a cache entry.
type Document struct {
	owner  *Highlighter
	source string
}

// DocumentEdit uses byte offsets in the exact original Document source.
type DocumentEdit = tokenizer.Edit

func (h *Highlighter) NewDocument(source string) *Document {
	return &Document{owner: h, source: source}
}

// CodeToDocumentTokens returns a themed prefix with independent mutable scopes.
// Grammar snapshots remain theme-independent; styles are resolved on every call.
func (h *Highlighter) CodeToDocumentTokens(ctx context.Context, document *Document, throughLine int, opts CodeToTokensOptions) (*TokensResult, error) {
	if document == nil {
		return nil, fmt.Errorf("document is nil")
	}
	return h.documentTokens(ctx, document, document.source, nil, throughLine, opts, true, false)
}

// CodeToEditedDocumentTokens validates the complete original-byte replacement
// map before reusing an original checkpoint. Invalid maps fall back to the actual
// supplied source; this display API never authorizes edits or validates YAML.
// Variants are ephemeral and never retained by the cache.
func (h *Highlighter) CodeToEditedDocumentTokens(ctx context.Context, document *Document, source string, edits []DocumentEdit, throughLine int, opts CodeToTokensOptions) (*TokensResult, error) {
	return h.documentTokens(ctx, document, source, edits, throughLine, opts, false, false)
}

func (h *Highlighter) documentTokens(ctx context.Context, document *Document, source string, edits []DocumentEdit, throughLine int, opts CodeToTokensOptions, retain, warm bool) (*TokensResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if document == nil || document.owner != h {
		return nil, fmt.Errorf("document belongs to another highlighter")
	}
	h.documentMu.RLock()
	defer h.documentMu.RUnlock()
	h.documents.mu.Lock()
	closed := h.documents.closed
	h.documents.mu.Unlock()
	if closed {
		return nil, fmt.Errorf("highlighter is closed")
	}
	if len(opts.Themes) > 0 || opts.Lang == "ansi" {
		return h.CodeToTokens(ctx, documentPrefix(source, throughLine), opts)
	}
	thm, err := h.getTheme(opts.Theme)
	if err != nil {
		return nil, err
	}
	g, err := h.reg.GetGrammar(opts.Lang)
	if err != nil || g == nil {
		return h.CodeToTokens(ctx, documentPrefix(source, throughLine), opts)
	}
	previous, release := h.documents.acquire(document)
	// Borrowed snapshots remain charged while their raw scopes are being copied.
	defer func() { release() }()
	tokOpts := h.resolveTokenizeOpts(opts.MaxLineLength, opts.TimeoutMs)
	var raw *tokenizer.TokenizeResult
	var next *tokenizer.DocumentSnapshot
	var stats tokenizer.DocumentStats
	err = h.pool.Do(ctx, func(lib oniguruma.OnigLib) error {
		var scanErr error
		raw, next, stats, scanErr = tokenizer.TokenizeDocument(ctx, source, throughLine, g, lib, tokOpts, previous, edits, h.reg)
		return scanErr
	})
	h.documents.record(stats)
	if retain && (err != nil || next == nil) {
		h.documents.invalidate(document)
	}
	if err != nil {
		return nil, err
	}
	var prefix string
	if next != nil {
		prefix = next.Prefix(throughLine)
	} else {
		prefix = documentPrefix(source, throughLine)
	}
	var result *TokensResult
	if !warm {
		result = h.buildResult(prefix, raw, thm)
		for _, line := range result.Tokens {
			for i := range line {
				line[i].Scopes = append([]string(nil), line[i].Scopes...)
			}
		}
	}
	if err := ctx.Err(); err != nil {
		if retain {
			h.documents.invalidate(document)
		}
		return nil, err
	}
	// Release the borrowed version before replacing it. The deferred closure now
	// becomes a no-op; concurrent readers may still keep the old entry pinned.
	release()
	release = func() {}
	if retain && next != previous {
		h.documents.store(document, next)
	}
	return result, nil
}

func documentPrefix(source string, throughLine int) string {
	if throughLine <= 0 {
		return ""
	}
	offset := 0
	for range throughLine {
		next := strings.IndexByte(source[offset:], '\n')
		if next < 0 {
			return source
		}
		offset += next + 1
		if offset == len(source) {
			return source
		}
	}
	return source[:offset]
}

// WarmDocument prepares lexical checkpoints without allocating public styled tokens.
func (h *Highlighter) WarmDocument(ctx context.Context, document *Document, throughLine int, opts CodeToTokensOptions) error {
	if document == nil {
		return fmt.Errorf("document is nil")
	}
	_, err := h.documentTokens(ctx, document, document.source, nil, throughLine, opts, true, true)
	return err
}
