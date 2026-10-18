package lint

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

const configurationPath = ".saltbox-lint"

type projectConfiguration struct {
	namespaceSharing map[string][]string
	excludePaths     []string
	observation      DependencyFile
}

func (c projectConfiguration) excludes(name string) bool {
	for _, excluded := range c.excludePaths {
		if name == excluded || strings.HasPrefix(name, excluded+"/") {
			return true
		}
	}
	return false
}

func (c projectConfiguration) allowsNamespace(role, owner string) bool {
	return slices.Contains(c.namespaceSharing[role], owner)
}

func (l *sourceLoader) loadConfiguration() (projectConfiguration, error) {
	config := projectConfiguration{observation: DependencyFile{Path: configurationPath, State: "missing"}}
	info, err := l.files.Lstat(configurationPath)
	if errors.Is(err, fs.ErrNotExist) {
		return config, nil
	}
	if err != nil {
		return config, fmt.Errorf("inspect %s: %w", configurationPath, err)
	}
	if !info.Mode().IsRegular() {
		return config, fmt.Errorf("%s must be a regular file", configurationPath)
	}
	if info.Size() > 1<<20 {
		return config, fmt.Errorf("%s exceeds the 1 MiB configuration limit", configurationPath)
	}
	data, err := l.readFile(filepath.Join(l.project.Root, configurationPath))
	if err != nil {
		return config, fmt.Errorf("read %s: %w", configurationPath, err)
	}
	if len(data) > 1<<20 {
		return config, fmt.Errorf("%s exceeds the 1 MiB configuration limit", configurationPath)
	}
	config.observation.State = "read"
	config.observation.SHA256 = fmt.Sprintf("%x", sha256.Sum256(data))
	source, diagnostics := Parse(configurationPath, data)
	if len(diagnostics) > 0 {
		d := diagnostics[0]
		position := source.Position(d.Span.Start)
		return config, fmt.Errorf("%s:%d:%d: %s", configurationPath, position.Line, position.Column, d.Message)
	}
	if len(source.Documents) == 0 {
		return config, nil
	}
	if len(source.Documents) != 1 || !configurationNode(source.Documents[0], "mapping") {
		return config, fmt.Errorf("%s must contain one YAML mapping", configurationPath)
	}
	seen := map[string]bool{}
	for _, field := range source.Documents[0].Entries {
		if !configurationNode(field.Key, "string") || seen[field.Key.Value] {
			return config, fmt.Errorf("%s: expected unique configuration keys", configurationPath)
		}
		seen[field.Key.Value] = true
		switch field.Key.Value {
		case "exclude_paths":
			if !configurationNode(field.Value, "sequence") {
				return config, fmt.Errorf("%s: exclude_paths must be a list of source-root-relative files or folders", configurationPath)
			}
			for _, item := range field.Value.Items {
				if !configurationNode(item, "string") {
					return config, fmt.Errorf("%s: exclude_paths entries must be strings", configurationPath)
				}
				name := strings.TrimSuffix(strings.TrimPrefix(item.Value, "./"), "/")
				if strings.TrimSpace(name) == "" || name == "." || path.IsAbs(name) || path.Clean(name) != name || strings.ContainsAny(name, "\\:*?[]\x00\r\n") || slices.Contains(strings.Split(name, "/"), "..") {
					return config, fmt.Errorf("%s: invalid exclude_paths entry %q; use a relative file or folder with forward slashes, without globs or parent traversal", configurationPath, item.Value)
				}
				if slices.Contains(config.excludePaths, name) {
					return config, fmt.Errorf("%s: repeated exclude_paths entry %q", configurationPath, item.Value)
				}
				config.excludePaths = append(config.excludePaths, name)
			}
			continue
		case "namespace_sharing":
		default:
			return config, fmt.Errorf("%s: unknown configuration key %q; expected namespace_sharing or exclude_paths", configurationPath, field.Key.Value)
		}
		if !configurationNode(field.Value, "mapping") {
			return config, fmt.Errorf("%s: namespace_sharing must map role names to lists of allowed namespaces", configurationPath)
		}
		config.namespaceSharing = map[string][]string{}
		for _, role := range field.Value.Entries {
			if !configurationRole(role.Key) || !configurationNode(role.Value, "sequence") {
				return config, fmt.Errorf("%s: each namespace_sharing role must have a list of snake_case role names", configurationPath)
			}
			name := role.Key.Value
			if _, exists := config.namespaceSharing[name]; exists {
				return config, fmt.Errorf("%s: repeated namespace_sharing role %q", configurationPath, name)
			}
			config.namespaceSharing[name] = []string{}
			for _, owner := range role.Value.Items {
				if !configurationRole(owner) {
					return config, fmt.Errorf("%s: allowed namespaces must be snake_case role names", configurationPath)
				}
				if slices.Contains(config.namespaceSharing[name], owner.Value) {
					return config, fmt.Errorf("%s: role %q repeats namespace %q", configurationPath, name, owner.Value)
				}
				config.namespaceSharing[name] = append(config.namespaceSharing[name], owner.Value)
			}
		}
	}
	return config, nil
}

func configurationNode(node *Node, kind string) bool {
	return node != nil && node.Kind == kind && node.Tag == "" && node.Anchor == ""
}

func configurationRole(node *Node) bool {
	return configurationNode(node, "string") && ansibleRoleName.MatchString(node.Value)
}
