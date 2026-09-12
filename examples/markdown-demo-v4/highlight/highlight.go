package highlight

import (
	"context"
	"embed"
	"fmt"
	"github.com/frostybee/nuri"
	"path"
	"saltbox-lint-markdown-demo-v4/catalog"
)

//go:embed assets
var assets embed.FS

type Highlighter struct {
	engine         *nuri.Highlighter
	catalog        *catalog.Catalog
	semanticThemes map[string]*semanticTheme
}

func New(ctx context.Context) (*Highlighter, error) {
	snapshot, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	semanticThemes := map[string]*semanticTheme{}
	opts := []nuri.Option{nuri.WithMinContrast(0), nuri.WithPoolSize(1)}
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
