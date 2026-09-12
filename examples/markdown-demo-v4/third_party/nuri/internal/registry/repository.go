package registry

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"maps"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/frostybee/nuri/internal/assetfs"
	"github.com/frostybee/nuri/internal/grammar"
)

type Repository struct {
	fsys           fs.FS
	mu             sync.RWMutex
	grammars       map[string]*grammar.Grammar // name → parsed grammar
	scopeIndex     map[string]string           // scopeName → name
	registered     map[string][]byte           // name → raw JSON (programmatic)
	injectionIndex map[string][]string         // targetScope → []grammarNames that inject into it
	extIndex       map[string]string           // extension (no dot, lowercase) → grammar name
	filenameIndex  map[string]string           // exact filename → grammar name
	firstLineIndex map[string]*regexp.Regexp   // grammar name → compiled firstLineMatch
}

func NewRepository(fsys fs.FS) (*Repository, error) {
	r := &Repository{
		fsys:           fsys,
		grammars:       make(map[string]*grammar.Grammar),
		scopeIndex:     make(map[string]string),
		registered:     make(map[string][]byte),
		injectionIndex: make(map[string][]string),
		extIndex:       make(map[string]string),
		filenameIndex:  make(map[string]string),
		firstLineIndex: make(map[string]*regexp.Regexp),
	}
	if err := r.buildIndexes(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Repository) Get(name string) (*grammar.Grammar, error) {
	r.mu.RLock()
	if g, ok := r.grammars[name]; ok {
		r.mu.RUnlock()
		return g, nil
	}
	r.mu.RUnlock()

	r.mu.Lock()
	defer r.mu.Unlock()

	if g, ok := r.grammars[name]; ok {
		return g, nil
	}

	data, err := r.readGrammarData(name)
	if err != nil {
		return nil, fmt.Errorf("grammar %q: %w", name, err)
	}

	g, err := grammar.ParseGrammar(data)
	if err != nil {
		return nil, fmt.Errorf("grammar %q: %w", name, err)
	}

	r.grammars[name] = g
	return g, nil
}

func (r *Repository) GetByScope(scope string) (*grammar.Grammar, error) {
	r.mu.RLock()
	name, ok := r.scopeIndex[scope]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("no grammar for scope %q", scope)
	}
	return r.Get(name)
}

func (r *Repository) Register(name string, data []byte) error {
	var probe struct {
		ScopeName      string   `json:"scopeName"`
		InjectTo       []string `json:"injectTo"`
		FileTypes      []string `json:"fileTypes"`
		FirstLineMatch string   `json:"firstLineMatch"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return fmt.Errorf("register %q: %w", name, err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	r.registered[name] = data
	delete(r.grammars, name)
	if probe.ScopeName != "" {
		r.scopeIndex[probe.ScopeName] = name
	}
	for _, target := range probe.InjectTo {
		r.injectionIndex[target] = append(r.injectionIndex[target], name)
	}
	for _, ext := range probe.FileTypes {
		ext = strings.ToLower(ext)
		r.extIndex[ext] = name
	}
	if probe.FirstLineMatch != "" {
		if re, err := regexp.Compile(probe.FirstLineMatch); err == nil {
			r.firstLineIndex[name] = re
		}
	}
	return nil
}

// GetGrammarByScope satisfies grammar.GrammarResolver.
func (r *Repository) GetGrammarByScope(scope string) (*grammar.Grammar, error) {
	return r.GetByScope(scope)
}

// LoadedGrammars returns the names of all currently cached grammars, sorted.
func (r *Repository) LoadedGrammars() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.grammars))
	for name := range r.grammars {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func (r *Repository) readGrammarData(name string) ([]byte, error) {
	if data, ok := r.registered[name]; ok {
		return data, nil
	}
	if r.fsys == nil {
		return nil, fmt.Errorf("not found")
	}
	return fs.ReadFile(r.fsys, name+".json")
}

func (r *Repository) buildIndexes() error {
	if r.fsys == nil {
		return nil
	}

	// Fast path: a generated metadata index ships with the bundle packages
	// so construction does not read every grammar file.
	if data, err := fs.ReadFile(r.fsys, assetfs.IndexFileName); err == nil {
		if r.loadIndexFile(data) {
			return nil
		}
	}

	entries, err := fs.ReadDir(r.fsys, ".")
	if err != nil {
		return nil
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if e.Name() == assetfs.IndexFileName {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".json")

		data, err := fs.ReadFile(r.fsys, e.Name())
		if err != nil {
			continue
		}
		var probe struct {
			ScopeName      string   `json:"scopeName"`
			InjectTo       []string `json:"injectTo"`
			FileTypes      []string `json:"fileTypes"`
			FirstLineMatch string   `json:"firstLineMatch"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			continue
		}
		if probe.ScopeName != "" {
			r.scopeIndex[probe.ScopeName] = name
		}
		for _, target := range probe.InjectTo {
			r.injectionIndex[target] = append(r.injectionIndex[target], name)
		}
		for _, ext := range probe.FileTypes {
			ext = strings.ToLower(ext)
			if _, exists := r.extIndex[ext]; !exists {
				r.extIndex[ext] = name
			}
		}
		if probe.FirstLineMatch != "" {
			if re, err := regexp.Compile(probe.FirstLineMatch); err == nil {
				r.firstLineIndex[name] = re
			}
		}
	}
	return nil
}

// loadIndexFile populates the lookup maps from a generated metadata index.
// It returns false when the index is malformed or has an unsupported
// version, in which case the caller falls back to scanning the directory.
// Grammar names are iterated in sorted order so injectionIndex slices and
// extIndex first wins behavior stay deterministic, matching the sorted
// directory scan exactly.
func (r *Repository) loadIndexFile(data []byte) bool {
	var idx assetfs.Index
	if err := json.Unmarshal(data, &idx); err != nil {
		return false
	}
	if idx.Version != assetfs.IndexVersion {
		return false
	}

	for _, name := range slices.Sorted(maps.Keys(idx.Grammars)) {
		meta := idx.Grammars[name]
		if meta.ScopeName != "" {
			r.scopeIndex[meta.ScopeName] = name
		}
		for _, target := range meta.InjectTo {
			r.injectionIndex[target] = append(r.injectionIndex[target], name)
		}
		for _, ext := range meta.FileTypes {
			ext = strings.ToLower(ext)
			if _, exists := r.extIndex[ext]; !exists {
				r.extIndex[ext] = name
			}
		}
		if meta.FirstLineMatch != "" {
			if re, err := regexp.Compile(meta.FirstLineMatch); err == nil {
				r.firstLineIndex[name] = re
			}
		}
	}
	return true
}

// DetectByFilename resolves a grammar name from a filename or path.
func (r *Repository) DetectByFilename(filename string) (string, bool) {
	base := filepath.Base(filename)

	r.mu.RLock()
	defer r.mu.RUnlock()

	if name, ok := r.filenameIndex[base]; ok {
		return name, true
	}

	ext := strings.TrimPrefix(filepath.Ext(base), ".")
	ext = strings.ToLower(ext)
	if ext != "" {
		if name, ok := r.extIndex[ext]; ok {
			return name, true
		}
	}
	return "", false
}

// DetectByFirstLine resolves a grammar name from the first line of content.
func (r *Repository) DetectByFirstLine(line string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for name, re := range r.firstLineIndex {
		if re.MatchString(line) {
			return name, true
		}
	}
	return "", false
}

// RegisterExtension maps a file extension (without dot) to a grammar name.
func (r *Repository) RegisterExtension(ext, name string) {
	r.mu.Lock()
	r.extIndex[strings.ToLower(ext)] = name
	r.mu.Unlock()
}

// RegisterExtensionIfAbsent maps a file extension only if no mapping exists.
func (r *Repository) RegisterExtensionIfAbsent(ext, name string) {
	ext = strings.ToLower(ext)
	r.mu.Lock()
	if _, exists := r.extIndex[ext]; !exists {
		r.extIndex[ext] = name
	}
	r.mu.Unlock()
}

// RegisterFilename maps an exact filename to a grammar name.
func (r *Repository) RegisterFilename(filename, name string) {
	r.mu.Lock()
	r.filenameIndex[filename] = name
	r.mu.Unlock()
}

// GetInjectors returns parsed grammars that inject into the given target scope.
func (r *Repository) GetInjectors(targetScope string) ([]*grammar.Grammar, error) {
	r.mu.RLock()
	names := r.injectionIndex[targetScope]
	r.mu.RUnlock()

	if len(names) == 0 {
		return nil, nil
	}

	grammars := make([]*grammar.Grammar, 0, len(names))
	for _, name := range names {
		g, err := r.Get(name)
		if err != nil {
			continue
		}
		grammars = append(grammars, g)
	}
	return grammars, nil
}
