package theme

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"slices"
	"sync"
)

// Store manages loading, caching, and retrieval of themes.
type Store struct {
	fsys       fs.FS
	mu         sync.RWMutex
	themes     map[string]*Theme
	registered map[string][]byte
}

// NewStore creates a Store backed by the given filesystem.
// Pass nil for a registry-only store with no filesystem.
func NewStore(fsys fs.FS) *Store {
	return &Store{
		fsys:       fsys,
		themes:     make(map[string]*Theme),
		registered: make(map[string][]byte),
	}
}

// Get returns a parsed theme by name, loading and caching it on first access.
func (s *Store) Get(name string) (*Theme, error) {
	s.mu.RLock()
	if t, ok := s.themes[name]; ok {
		s.mu.RUnlock()
		return t, nil
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()

	if t, ok := s.themes[name]; ok {
		return t, nil
	}

	data, err := s.readThemeData(name)
	if err != nil {
		return nil, err
	}
	t, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("theme %q: %w", name, err)
	}
	s.themes[name] = t
	return t, nil
}

// Register adds raw theme JSON under the given name.
// Overwrites any previously registered or cached theme with the same name.
func (s *Store) Register(name string, data []byte) error {
	if !json.Valid(data) {
		return fmt.Errorf("theme %q: invalid JSON", name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.registered[name] = data
	delete(s.themes, name)
	return nil
}

// LoadedThemes returns the names of all currently cached themes, sorted.
func (s *Store) LoadedThemes() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.themes))
	for name := range s.themes {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func (s *Store) readThemeData(name string) ([]byte, error) {
	if data, ok := s.registered[name]; ok {
		return data, nil
	}
	if s.fsys == nil {
		return nil, fmt.Errorf("theme %q: not found", name)
	}
	data, err := fs.ReadFile(s.fsys, name+".json")
	if err != nil {
		return nil, fmt.Errorf("theme %q: %w", name, err)
	}
	return data, nil
}
