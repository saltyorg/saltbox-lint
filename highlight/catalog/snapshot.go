package catalog

import (
	"cmp"
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
)

//go:embed data/catalog.json
var embedded []byte

type Problem struct {
	Kind    string `json:"kind"`
	Module  string `json:"module,omitempty"`
	Message string `json:"message"`
}

type InstalledCollection struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Path    string `json:"path"`
}

type Provenance struct {
	SemanticModel   string                `json:"semantic_model"`
	AnsibleVersion  string                `json:"ansible_version"`
	ConfigPath      string                `json:"config_path"`
	PlaybookDir     string                `json:"playbook_dir"`
	ModulePaths     []string              `json:"module_paths"`
	CollectionPaths []string              `json:"collection_paths"`
	Collections     []InstalledCollection `json:"collections"`
	Inputs          map[string]string     `json:"inputs_sha256"`
}

// Load reads the embedded snapshot. It never refreshes it or invokes Ansible.
func Load() (*Catalog, error) { return decode(embedded) }

func decode(data []byte) (*Catalog, error) {
	var c Catalog
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("decode module catalog: %w", err)
	}
	if c.SchemaVersion != 1 {
		return nil, fmt.Errorf("unsupported module catalog schema %d", c.SchemaVersion)
	}
	if c.Modules == nil || c.Routes == nil {
		return nil, fmt.Errorf("module catalog lacks inventory or routing")
	}
	return &c, nil
}

// Marshal writes a stable snapshot without wall-clock or command timing data.
func (c *Catalog) Marshal() ([]byte, error) {
	copy := *c
	copy.Problems = slices.Clone(c.Problems)
	slices.SortFunc(copy.Problems, func(a, b Problem) int {
		return cmp.Or(cmp.Compare(a.Kind, b.Kind), cmp.Compare(a.Module, b.Module), cmp.Compare(a.Message, b.Message))
	})
	copy.Problems = slices.Compact(copy.Problems)
	data, err := json.MarshalIndent(copy, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode module catalog: %w", err)
	}
	return append(data, '\n'), nil
}
