package lint

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

// ContextRequirement declares reads beyond the selected source. File-local
// rules use the zero value. OwningRole conservatively includes all conventional
// role directories because the shared Traefik analysis derives role-wide facts.
type ContextRequirement string

const (
	OwningRole      ContextRequirement = "owning-role"
	SharedDocker    ContextRequirement = "shared-docker"
	ProjectIdentity ContextRequirement = "project-identity"
)

// AnalysisRecord is an optional, data-only check projection. Generation hashes
// the observed source set and bytes; request ordering belongs to the consumer.
type AnalysisRecord struct {
	SchemaVersion int                  `json:"schema_version"`
	Root          string               `json:"root"`
	Generation    string               `json:"generation"`
	Complete      bool                 `json:"complete"`
	Sources       []SourceDependencies `json:"sources"`
}
type SourceDependencies struct {
	Path         string                `json:"path"`
	SourceSHA256 string                `json:"source_sha256"`
	Files        []DependencyFile      `json:"files"`
	Directories  []DependencyDirectory `json:"directories"`
	Identity     []DependencyFile      `json:"identity"`
	Discovery    []DependencyFile      `json:"discovery"`
}
type DependencyFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
	State  string `json:"state"`
}
type DependencyDirectory struct {
	State   string   `json:"state"`
	Path    string   `json:"path"`
	Members []string `json:"members"`
}

func contextRequirements(s *Source, rules []Rule) []ContextRequirement {
	needs := map[ContextRequirement]bool{}
	for _, rule := range rules {
		if len(rule.Kinds) > 0 && !slices.Contains(rule.Kinds, s.Kind) {
			continue
		}
		for _, need := range rule.Context {
			needs[need] = true
		}
	}
	return sortedContextRequirements(needs)
}

func sortedContextRequirements(needs map[ContextRequirement]bool) []ContextRequirement {
	values := make([]ContextRequirement, 0, len(needs))
	for need := range needs {
		values = append(values, need)
	}
	slices.Sort(values)
	return values
}
func contextDirectories(s *Source, rules []Rule) []string {
	dirs := map[string]bool{}
	for _, need := range contextRequirements(s, rules) {
		switch need {
		case OwningRole:
			if s.RolePath != "" {
				for _, kind := range []string{"defaults", "tasks", "handlers", "vars", "templates"} {
					dirs[path.Join(s.RolePath, kind)] = true
				}
			}
		case SharedDocker:
			if strings.HasPrefix(s.Path, "resources/tasks/docker/") {
				dirs["resources/tasks/docker"] = true
			}
		}
	}
	return sortedKeys(dirs)
}

func dependencyRecord(p *Project, rules []Rule) *AnalysisRecord {
	result := &AnalysisRecord{SchemaVersion: 1, Root: p.Root, Complete: true, Sources: []SourceDependencies{}}
	generation := sha256.New()
	names := sortedKeys(p.Sources)
	hashes := map[string]string{}
	members := map[string][]string{}
	roles := map[string][]*Source{}
	for _, name := range names {
		source := p.Sources[name]
		hashes[name] = fmt.Sprintf("%x", sha256.Sum256(source.Data))
		if source.RolePath != "" {
			roles[source.RolePath] = append(roles[source.RolePath], source)
			relative := strings.TrimPrefix(name, source.RolePath+"/")
			kind, _, _ := strings.Cut(relative, "/")
			dir := path.Join(source.RolePath, kind)
			members[dir] = append(members[dir], name)
		}
		if strings.HasPrefix(name, "resources/tasks/docker/") {
			members["resources/tasks/docker"] = append(members["resources/tasks/docker"], name)
		}
	}
	for _, name := range sortedKeys(p.Selected) {
		source := p.Sources[name]
		record := SourceDependencies{Path: name, SourceSHA256: hashes[name], Files: []DependencyFile{}, Directories: []DependencyDirectory{}, Identity: []DependencyFile{}, Discovery: p.discovery}
		files := map[string]bool{name: true}
		for _, dir := range contextDirectories(source, rules) {
			directoryMembers := members[dir]
			if directoryMembers == nil {
				directoryMembers = []string{}
			}
			for _, context := range directoryMembers {
				files[context] = true
			}
			record.Directories = append(record.Directories, DependencyDirectory{Path: dir, State: p.directories[dir], Members: directoryMembers})
		}
		// Literal template targets include negative lookups. Directory observations
		// also invalidate newly admitted templates regardless of filename extension.
		for _, other := range roles[source.RolePath] {
			if !slices.Contains(contextRequirements(source, rules), OwningRole) {
				continue
			}
			for _, task := range TasksIn(other) {
				if task.Module != "template" {
					continue
				}
				if src := task.argument("src"); src != nil && src.Kind == "string" && src.Value != "" && !strings.ContainsAny(src.Value, "{}\\") {
					if target := path.Join(other.RolePath, "templates", src.Value); target != "." && target != ".." && !strings.HasPrefix(target, "../") && !strings.HasPrefix(target, "/") {
						files[target] = true
					}
				}
			}
		}
		for _, file := range sortedKeys(files) {
			dep := DependencyFile{Path: file, State: "unavailable"}
			if found := p.Sources[file]; found != nil {
				dep.State = "read"
				dep.SHA256 = hashes[file]
			}
			if dep.State != "read" {
				if _, err := ownedSourcePath(p.Root, filepath.Join(p.Root, filepath.FromSlash(file))); errors.Is(err, fs.ErrNotExist) {
					dep.State = "missing"
				}
			}
			record.Files = append(record.Files, dep)
		}
		// Project identity observes regular marker presence, including negative
		// candidates. projectName does not read their content.
		if slices.Contains(contextRequirements(source, rules), ProjectIdentity) {
			record.Identity = append(record.Identity, p.identity...)
		}
		slices.SortFunc(record.Files, func(a, b DependencyFile) int { return strings.Compare(a.Path, b.Path) })
		result.Sources = append(result.Sources, record)
	}
	// Ordered records include selection, negative targets and primary bytes.
	_ = json.NewEncoder(generation).Encode(result.Sources)
	result.Generation = fmt.Sprintf("%x", generation.Sum(nil))
	return result
}
