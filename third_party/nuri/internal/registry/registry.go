package registry

import (
	"errors"
	"fmt"
	"io/fs"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/theme"
)

var (
	ErrLanguageNotFound = errors.New("nuri: language not found")
	ErrThemeNotFound    = errors.New("nuri: theme not found")
)

// Registry bridges grammar loading and theme resolution with alias support.
type Registry struct {
	grammars *Repository
	themes   *theme.Store
	aliases  map[string]string // alias → canonical name
}

// New creates a Registry backed by the given filesystems.
// Either FS may be nil for register-only mode.
func New(grammarFS, themeFS fs.FS) (*Registry, error) {
	repo, err := NewRepository(grammarFS)
	if err != nil {
		return nil, fmt.Errorf("registry: grammars: %w", err)
	}
	return &Registry{
		grammars: repo,
		themes:   theme.NewStore(themeFS),
		aliases:  make(map[string]string),
	}, nil
}

// GetGrammar returns a parsed grammar by name, resolving aliases.
func (r *Registry) GetGrammar(name string) (*grammar.Grammar, error) {
	resolved := r.resolveAlias(name)
	g, err := r.grammars.Get(resolved)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", resolved, ErrLanguageNotFound)
	}
	return g, nil
}

// GetTheme returns a parsed theme by name.
func (r *Registry) GetTheme(name string) (*theme.Theme, error) {
	t, err := r.themes.Get(name)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, ErrThemeNotFound)
	}
	return t, nil
}

// RegisterGrammar adds a grammar from raw JSON bytes.
func (r *Registry) RegisterGrammar(name string, data []byte) error {
	return r.grammars.Register(name, data)
}

// RegisterTheme adds a theme from raw JSON bytes.
func (r *Registry) RegisterTheme(name string, data []byte) error {
	return r.themes.Register(name, data)
}

// RegisterAlias maps an alias to a canonical language name.
func (r *Registry) RegisterAlias(alias, target string) {
	r.aliases[alias] = target
}

// GetGrammarByScope satisfies grammar.GrammarResolver for cross-grammar includes.
func (r *Registry) GetGrammarByScope(scope string) (*grammar.Grammar, error) {
	return r.grammars.GetByScope(scope)
}

// LoadedLanguages returns the names of all currently cached grammars.
func (r *Registry) LoadedLanguages() []string {
	return r.grammars.LoadedGrammars()
}

// LoadedThemes returns the names of all currently cached themes.
func (r *Registry) LoadedThemes() []string {
	return r.themes.LoadedThemes()
}

// DetectByFilename resolves a grammar name from a filename or path.
func (r *Registry) DetectByFilename(filename string) (string, bool) {
	return r.grammars.DetectByFilename(filename)
}

// DetectByFirstLine resolves a grammar name from the first line of content.
func (r *Registry) DetectByFirstLine(line string) (string, bool) {
	return r.grammars.DetectByFirstLine(line)
}

// RegisterExtension maps a file extension to a grammar name.
func (r *Registry) RegisterExtension(ext, name string) {
	r.grammars.RegisterExtension(ext, name)
}

// RegisterExtensionIfAbsent maps a file extension only if no mapping exists.
func (r *Registry) RegisterExtensionIfAbsent(ext, name string) {
	r.grammars.RegisterExtensionIfAbsent(ext, name)
}

// RegisterFilename maps an exact filename to a grammar name.
func (r *Registry) RegisterFilename(filename, name string) {
	r.grammars.RegisterFilename(filename, name)
}

func (r *Registry) resolveAlias(name string) string {
	if target, ok := r.aliases[name]; ok {
		return target
	}
	return name
}
