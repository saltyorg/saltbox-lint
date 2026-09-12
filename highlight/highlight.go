package highlight

import (
	"context"
	"embed"
	"fmt"
	"github.com/frostybee/nuri"
	"github.com/saltyorg/saltbox-lint/highlight/catalog"
	"path"
)

//go:embed assets
var assets embed.FS

type Highlighter struct {
	engine         *nuri.Highlighter
	catalog        *catalog.Catalog
	semanticThemes map[string]*semanticTheme
}

const defaultLineCacheBytes = 32 << 20
const defaultCacheBytes = 64 << 20

func New(ctx context.Context) (*Highlighter, error) {
	return newHighlighter(ctx, defaultLineCacheBytes)
}

// NewWithPoolSize creates a highlighter that can perform at most poolSize
// concurrent grammar scans. Values below one retain the sequential default.
func NewWithPoolSize(ctx context.Context, poolSize int) (*Highlighter, error) {
	return newHighlighterWithPoolSize(ctx, defaultLineCacheBytes, max(1, poolSize))
}

func newHighlighter(ctx context.Context, lineCacheBytes int) (*Highlighter, error) {
	return newHighlighterWithPoolSize(ctx, lineCacheBytes, 1)
}

func newHighlighterWithPoolSize(ctx context.Context, lineCacheBytes, poolSize int) (*Highlighter, error) {
	snapshot, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	semanticThemes := map[string]*semanticTheme{}
	opts := []nuri.Option{nuri.WithMinContrast(0), nuri.WithPoolSize(poolSize)}
	if lineCacheBytes > 0 {
		opts = append(opts, nuri.WithLineCache(lineCacheBytes), nuri.WithDocumentCache(max(0, defaultCacheBytes-lineCacheBytes)))
	}
	entries, err := assets.ReadDir("assets/grammars")
	if err != nil {
		return nil, err
	}
	var grammars [][]byte
	for _, entry := range entries {
		data, err := assets.ReadFile("assets/grammars/" + entry.Name())
		if err != nil {
			return nil, err
		}
		grammars = append(grammars, data)
		opts = append(opts, nuri.WithGrammar(entry.Name(), data))
	}
	host, err := assets.ReadFile("assets/grammars/source.ansible.json")
	if err != nil {
		return nil, err
	}
	host, err = bindInjections(host, grammars)
	if err != nil {
		return nil, err
	}
	opts = append(opts, nuri.WithGrammar("source.ansible.json", host))
	opts = append(opts, nuri.WithAlias("ansible", "source.ansible.json"))
	for _, name := range []string{"one-dark-pro", "one-light"} {
		data, err := assets.ReadFile(path.Join("assets/themes", name+".json"))
		if err != nil {
			return nil, err
		}
		semanticThemes[name], err = parseSemanticTheme(data)
		if err != nil {
			return nil, fmt.Errorf("semantic theme %s: %w", name, err)
		}
		data, err = normalizeTheme(data)
		if err != nil {
			return nil, err
		}
		opts = append(opts, nuri.WithTheme(name, data))
	}
	engine, err := nuri.New(ctx, opts...)
	if err != nil {
		return nil, err
	}
	return &Highlighter{engine: engine, catalog: snapshot, semanticThemes: semanticThemes}, nil
}
func (h *Highlighter) Close(ctx context.Context) error { return h.engine.Close(ctx) }
func (h *Highlighter) Highlight(ctx context.Context, source, themeName string) (*nuri.TokensResult, error) {
	result, err := h.engine.CodeToTokens(ctx, source, nuri.CodeToTokensOptions{Lang: "ansible", Theme: themeName})
	if err != nil {
		return nil, err
	}
	if len(result.Diagnostics) > 0 {
		return nil, fmt.Errorf("incomplete grammar tokenization: %+v", result.Diagnostics)
	}
	return result, nil
}

// HighlightThroughLine preserves grammar context from the start of source but
// stops lexical work after the requested one-based physical line.
func (h *Highlighter) HighlightThroughLine(ctx context.Context, source, themeName string, throughLine int) (*nuri.TokensResult, error) {
	return h.Highlight(ctx, sourcePrefixThroughLine(source, throughLine), themeName)
}

// CacheStats reports the combined bounded lexical caches for profiling.
func (h *Highlighter) CacheStats() nuri.DocumentCacheStats { return h.engine.DocumentCacheStats() }
