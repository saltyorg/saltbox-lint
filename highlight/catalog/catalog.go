// Package catalog contains the frozen module knowledge used by semantic highlighting.
package catalog

// Source identifies the actual file, rather than inferring ownership from a name.
type Source struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
	Kind   string `json:"kind"`
}

type Option struct {
	Type       string            `json:"type,omitempty"`
	Aliases    []string          `json:"aliases,omitempty"`
	Suboptions map[string]Option `json:"suboptions,omitempty"`
}

type Module struct {
	CanonicalName          string            `json:"canonical_name"`
	Source                 Source            `json:"source"`
	DiscoveryNames         []string          `json:"discovery_names"`
	DocumentationAvailable bool              `json:"documentation_available"`
	Options                map[string]Option `json:"options,omitempty"`
}

type Route struct {
	Redirect  string `json:"redirect,omitempty"`
	Tombstone bool   `json:"tombstone,omitempty"`
}

type Catalog struct {
	SchemaVersion int               `json:"schema_version"`
	Problems      []Problem         `json:"problems"`
	Provenance    Provenance        `json:"provenance"`
	Modules       map[string]Module `json:"modules"`
	Routes        map[string]Route  `json:"routes"`
}

// FindOption uses exact, case-sensitive canonical names before aliases.
func FindOption(options map[string]Option, name string) (Option, bool) {
	if option, ok := options[name]; ok {
		return option, true
	}
	for _, option := range options {
		for _, alias := range option.Aliases {
			if alias == name {
				return option, true
			}
		}
	}
	return Option{}, false
}
