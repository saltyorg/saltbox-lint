package catalog

import (
	"bytes"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/goccy/go-yaml"
)

// This is the assignment form accepted by ALS LazyModuleDocumentation.docsRegex.
// Find the matching closing delimiter explicitly because RE2 has no backrefs.
var assignmentStart = regexp.MustCompile(`[ \t]*([A-Z0-9_]+)\s*=\s*r?('''|""")`)

func parseAssignments(source []byte) (map[string]any, error) {
	assignments := map[string]any{}
	for {
		match := assignmentStart.FindSubmatchIndex(source)
		if match == nil {
			break
		}
		name := string(source[match[2]:match[3]])
		quote := source[match[4]:match[5]]
		content := source[match[1]:]
		end := bytes.Index(content, quote)
		if end < 0 {
			return nil, fmt.Errorf("parse %s assignment: unterminated triple-quoted string", name)
		}
		// Examples and return schemas have no effect on semantic option knowledge.
		if name != "EXAMPLES" && name != "RETURN" {
			var value any
			if err := yaml.Unmarshal(content[:end], &value); err != nil && name == "DOCUMENTATION" {
				return nil, fmt.Errorf("parse %s assignment: %w", name, err)
			}
			assignments[name] = value
		}
		source = content[end+len(quote):]
	}
	return assignments, nil
}

func semanticOptions(raw map[string]any, fragments map[string]map[string]any) (map[string]Option, bool, []string) {
	doc, ok := raw["DOCUMENTATION"].(map[string]any)
	if !ok {
		return nil, false, nil
	}
	merged := map[string]any{}
	var missing []string
	var references []string
	switch value := doc["extends_documentation_fragment"].(type) {
	case string:
		references = []string{value}
	case []any:
		for _, entry := range value {
			if name, ok := entry.(string); ok {
				references = append(references, name)
			}
		}
	}
	for _, reference := range references {
		parts := strings.Split(reference, ".")
		section := "DOCUMENTATION"
		if len(parts) == 2 || len(parts) == 4 {
			section = strings.ToUpper(parts[len(parts)-1])
			parts = parts[:len(parts)-1]
		}
		name := strings.Join(parts, ".")
		fragment, ok := fragments[name]
		if !ok {
			fragment, ok = fragments["ansible.builtin."+name]
		}
		content, found := fragment[section].(map[string]any)
		if !ok || !found {
			missing = append(missing, reference)
			continue
		}
		merged = mergeMapping(merged, content)
	}
	merged = mergeMapping(merged, doc)
	if _, ok := merged["module"].(string); !ok {
		return nil, false, missing
	}
	return parseOptions(merged["options"]), true, missing
}

// lodash.mergeWith recursively merges maps and array indices; only unrelated
// prose keys use its custom concatenation callback. Inputs stay unmodified.
func mergeValue(base, override any) any {
	if right, ok := override.(map[string]any); ok {
		left, _ := base.(map[string]any)
		return mergeMapping(left, right)
	}
	if right, ok := override.([]any); ok {
		left, _ := base.([]any)
		merged := slices.Clone(left)
		for i, value := range right {
			if i >= len(merged) {
				merged = append(merged, mergeValue(nil, value))
			} else {
				merged[i] = mergeValue(merged[i], value)
			}
		}
		return merged
	}
	return override
}

func mergeMapping(base, override map[string]any) map[string]any {
	merged := maps.Clone(base)
	if merged == nil {
		merged = map[string]any{}
	}
	for name, value := range override {
		merged[name] = mergeValue(merged[name], value)
	}
	return merged
}

func parseOptions(value any) map[string]Option {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	options := map[string]Option{}
	for name, value := range raw {
		fields, ok := value.(map[string]any)
		if !ok {
			continue
		}
		option := Option{Suboptions: parseOptions(fields["suboptions"])}
		option.Type, _ = fields["type"].(string)
		if aliases, ok := fields["aliases"].([]any); ok {
			for _, alias := range aliases {
				if name, ok := alias.(string); ok {
					option.Aliases = append(option.Aliases, name)
				}
			}
		}
		options[name] = option
	}
	return options
}

func (c *Catalog) loadStaticOptions() error {
	fragments := map[string]map[string]any{}
	for _, root := range c.Provenance.ModulePaths {
		paths, err := filepath.Glob(filepath.Join(filepath.Dir(root), "plugins", "doc_fragments", "*.py"))
		if err != nil {
			return err
		}
		for _, path := range paths {
			if err := c.addFragment(fragments, path, "ansible.builtin"); err != nil {
				return err
			}
		}
	}
	for _, root := range c.Provenance.CollectionPaths {
		paths, err := filepath.Glob(filepath.Join(root, "ansible_collections", "*", "*", "plugins", "doc_fragments", "*.py"))
		if err != nil {
			return err
		}
		for _, path := range paths {
			collectionRoot := filepath.Dir(filepath.Dir(filepath.Dir(path)))
			collection := filepath.Base(filepath.Dir(collectionRoot)) + "." + filepath.Base(collectionRoot)
			if err := c.addFragment(fragments, path, collection); err != nil {
				return err
			}
		}
	}
	for name, module := range c.Modules {
		source, err := os.ReadFile(module.Source.Path)
		if err != nil {
			return fmt.Errorf("read module documentation %s: %w", name, err)
		}
		raw, err := parseAssignments(source)
		if err != nil {
			c.Problems = append(c.Problems, Problem{Kind: "documentation_parse_error", Module: name, Message: err.Error()})
			continue
		}
		options, available, missing := semanticOptions(raw, fragments)
		module.Options, module.DocumentationAvailable = options, available
		c.Modules[name] = module
		if !available {
			c.Problems = append(c.Problems, Problem{Kind: "documentation_unavailable", Module: name, Message: "no static DOCUMENTATION assignment with a string module field"})
		}
		for _, reference := range missing {
			c.Problems = append(c.Problems, Problem{Kind: "fragment_unavailable", Module: name, Message: reference})
		}
	}
	return nil
}

func (c *Catalog) addFragment(fragments map[string]map[string]any, path, collection string) error {
	if strings.HasPrefix(filepath.Base(path), "_") {
		return nil
	}
	source, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read fragment %s: %w", path, err)
	}
	raw, err := parseAssignments(source)
	if err != nil {
		c.Problems = append(c.Problems, Problem{Kind: "fragment_parse_error", Message: path + ": " + err.Error()})
		return nil
	}
	fragments[collection+"."+strings.TrimSuffix(filepath.Base(path), ".py")] = raw
	return nil
}
