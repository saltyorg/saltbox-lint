package report

import (
	"context"
	"crypto/sha256"
	"slices"
	"sync"

	"github.com/frostybee/nuri"
	"github.com/saltyorg/saltbox-lint/highlight"
	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/yamlindex"
)

type documentKey struct {
	path string
	sum  [32]byte
}

type cachedDocumentTokens struct {
	throughLine int
	result      *nuri.TokensResult
	collections []string
	theme       string
}

// Each renderer retains at most one immutable semantic document, replaced when
// it moves to another original source. Suggested variants are never retained.
type cachedDisplayDocument struct {
	key         documentKey
	collections []string
	document    *highlight.DisplayDocument
}

func (r *humanRenderer) releaseDisplayData() {
	r.lines = make(map[string][]sourceLine)
	r.tokens = make(map[documentKey]cachedDocumentTokens)
	r.prepared = cachedDisplayDocument{}
}

type highlightSession struct {
	ctx      context.Context
	poolSize int
	once     sync.Once
	engine   *highlight.Highlighter
}

func newHighlightSession(ctx context.Context, poolSize int) *highlightSession {
	return &highlightSession{ctx: ctx, poolSize: max(1, poolSize)}
}

func (s *highlightSession) get() *highlight.Highlighter {
	s.once.Do(func() {
		s.engine, _ = highlight.NewWithPoolSize(s.ctx, s.poolSize)
	})
	return s.engine
}

func (r *humanRenderer) close() {
	if r.highlights != nil {
		if engine := r.highlights.engine; engine != nil {
			_ = engine.Close(context.WithoutCancel(r.ctx))
		}
	}
}

// Decoration is optional; errors never hide a diagnostic. The semantic parser
// can reject malformed YAML while the TextMate grammar can still color it.
func (r *humanRenderer) documentTokens(path, source string, throughLine int) *nuri.TokensResult {
	return r.documentTokensWithIndex(path, source, throughLine, nil)
}

func (r *humanRenderer) documentTokensWithIndex(path, source string, throughLine int, index *yamlindex.Index) *nuri.TokensResult {
	if !r.color || r.ctx.Err() != nil {
		return nil
	}
	key := documentKey{path, sha256.Sum256([]byte(source))}
	collections := r.roleCollections(path)
	if cached, ok := r.tokens[key]; ok && cached.throughLine >= throughLine && cached.theme == r.themeName && slices.Equal(cached.collections, collections) {
		return cached.result
	}
	highlighter := r.highlights.get()
	if highlighter == nil {
		r.tokens[key] = cachedDocumentTokens{throughLine: throughLine}
		return nil
	}
	opts := highlight.DocumentOptions{SourcePath: path, Collections: collections, SourceIndex: index}
	original := r.project != nil && r.project.Sources[path] != nil && string(r.project.Sources[path].Data) == source
	var tokens *nuri.TokensResult
	if original {
		document := r.prepareOriginalDocument(highlighter, key, source, opts)
		tokens, _ = highlighter.HighlightPreparedDisplayThroughLine(r.ctx, document, r.themeName, throughLine)
	} else {
		tokens, _ = highlighter.HighlightDisplayThroughLine(r.ctx, source, r.themeName, opts, throughLine)
	}
	// Suggestions are used once after proposal deduplication. Retain only the
	// original document across findings, avoiding a cache of full-file variants.
	if original {
		r.tokens[key] = cachedDocumentTokens{throughLine: throughLine, result: tokens, collections: collections, theme: r.themeName}
	}
	return tokens
}

// Only already-loaded metadata participates. Reporting never discovers or reads
// adjacent files, and does not widen the linter's source selection.
func (r *humanRenderer) roleCollections(path string) []string {
	if r.project == nil {
		return nil
	}
	source := r.project.Sources[path]
	if source == nil || source.RolePath == "" {
		return nil
	}
	for _, extension := range []string{".yml", ".yaml"} {
		metadata := r.project.Sources[source.RolePath+"/meta/main"+extension]
		if metadata == nil || len(metadata.Documents) == 0 {
			continue
		}
		value := metadata.Documents[0].Get("collections")
		if value == nil || value.Kind != "sequence" {
			return nil
		}
		var collections []string
		for _, item := range value.Items {
			if item != nil && item.Kind == "string" && item.Tag == "" {
				collections = append(collections, item.Value)
			}
		}
		return collections
	}
	return nil
}

func (r *humanRenderer) prepareOriginalDocument(h *highlight.Highlighter, key documentKey, source string, opts highlight.DocumentOptions) *highlight.DisplayDocument {
	if r.prepared.document == nil || r.prepared.key != key || !slices.Equal(r.prepared.collections, opts.Collections) {
		document, _ := h.PrepareDisplayDocument(r.ctx, source, opts)
		r.prepared = cachedDisplayDocument{key: key, collections: opts.Collections, document: document}
	}
	return r.prepared.document
}

func (r *humanRenderer) editedDocumentTokens(path, before, after string, throughLine int, index *yamlindex.Index, edits []lint.Edit) *nuri.TokensResult {
	if !r.color || r.ctx.Err() != nil {
		return nil
	}
	h := r.highlights.get()
	if h == nil {
		return nil
	}
	key := documentKey{path, sha256.Sum256([]byte(before))}
	collections := r.roleCollections(path)
	if r.prepared.document == nil || r.prepared.key != key || !slices.Equal(r.prepared.collections, collections) {
		return r.documentTokensWithIndex(path, after, throughLine, index)
	}
	replacements := make([]nuri.DocumentEdit, len(edits))
	for i, edit := range edits {
		replacements[i] = nuri.DocumentEdit{Start: edit.Span.Start, End: edit.Span.End, Text: edit.Text}
	}
	tokens, _ := h.HighlightEditedDisplayThroughLine(r.ctx, r.prepared.document, after, r.themeName, highlight.DocumentOptions{SourcePath: path, Collections: collections, SourceIndex: index}, replacements, throughLine)
	return tokens
}
