package lint

import (
	"fmt"
	"path"
	"path/filepath"
	"slices"
)

var variableContextDirectories = []string{"roles", "resources/roles", "group_vars", "host_vars", "inventory", "inventories"}

func variableContextDirectory(name string) bool {
	return slices.Contains(variableContextDirectories, name)
}

func variableDeclarationSource(source *Source) bool {
	if source == nil || len(source.parseDiagnostics) > 0 || (source.Kind != Defaults && source.Kind != Vars && source.Kind != Inventory) {
		return false
	}
	// Both the legacy root override and inventory host overrides belong to users.
	return source.Path != "localhost.yml" && (source.Kind != Inventory || path.Base(source.Path) != "localhost.yml")
}

func variableDeclarationPath(name string) bool {
	if !supportedSource(name) {
		return false
	}
	kind, _, _ := classify(name)
	return variableDeclarationSource(&Source{Path: name, Kind: kind})
}

func contextFiles(source *Source, rules []Rule) []string {
	if variableDeclarationSource(source) && slices.Contains(contextRequirements(source, rules), VariableDeclarations) {
		return []string{"inventory.yml", "inventory.yaml", "vars.yml", "vars.yaml"}
	}
	return nil
}

func (l *sourceLoader) variableDirectory(dir string) error {
	var paths []string
	var discoveryErr error
	if l.gitFiles != nil {
		relative, err := relativeSource(l.project.Root, dir)
		if err != nil {
			return err
		}
		for name := range gitDirectoryCandidates(l.gitFiles, filepath.FromSlash(relative)) {
			if variableDeclarationPath(filepath.ToSlash(name)) {
				paths = append(paths, filepath.Join(l.project.Root, name))
			}
		}
	} else {
		candidates, err := l.walkDirectory(dir, false)
		discoveryErr = err
		for _, absolute := range candidates {
			relative, err := relativeSource(l.project.Root, absolute)
			if err != nil {
				return err
			}
			if variableDeclarationPath(relative) {
				paths = append(paths, absolute)
			}
		}
	}
	if err := l.directorySources(paths, false); err != nil {
		return err
	}
	return discoveryErr
}

func sourceVariableDeclarations(source *Source) []defaultDeclaration {
	if !variableDeclarationSource(source) || len(source.parseDiagnostics) > 0 {
		return nil
	}
	declarations := topLevelDeclarations(source)
	if source.Path == "inventory.yml" || source.Path == "inventory.yaml" {
		declarations = nil
		for _, document := range source.Documents {
			inventoryDeclarations(document, func(entries []Entry) {
				for _, entry := range entries {
					if entry.Key != nil && entry.Key.Kind == "string" {
						declarations = append(declarations, defaultDeclaration{Name: entry.Key.Value, Key: entry.Key, Value: entry.Value})
					}
				}
			})
		}
	}
	return slices.DeleteFunc(declarations, func(declaration defaultDeclaration) bool { return declaration.Name == "<<" })
}

func variableDeclarations(project *Project) map[string][]RelatedLocation {
	if project.analysis != nil && project.analysis.variableDeclarations != nil {
		return project.analysis.variableDeclarations
	}
	declarations := make(map[string][]RelatedLocation)
	for _, name := range sortedKeys(project.Sources) {
		source := project.Sources[name]
		for _, declaration := range sourceVariableDeclarations(source) {
			declarations[declaration.Name] = append(declarations[declaration.Name], RelatedLocation{
				Path: source.Path, Span: declaration.Key.Span,
				Message: fmt.Sprintf("variable %q is also declared here", declaration.Name),
			})
		}
	}
	if project.analysis != nil {
		project.analysis.variableDeclarations = declarations
	}
	return declarations
}

func checkVariableDuplicates(project *Project, source *Source) []Diagnostic {
	if project == nil {
		return nil
	}
	declarations := variableDeclarations(project)
	var diagnostics []Diagnostic
	for _, declaration := range sourceVariableDeclarations(source) {
		var related []RelatedLocation
		for _, other := range declarations[declaration.Name] {
			if other.Path != source.Path || other.Span != declaration.Key.Span {
				related = append(related, other)
			}
		}
		if len(related) > 0 {
			diagnostics = append(diagnostics, Diagnostic{
				Path: source.Path, RuleID: "variable-duplicate", Severity: "error", Span: declaration.Key.Span,
				Message:  fmt.Sprintf("variable %q is declared more than once", declaration.Name),
				Expected: "Declare each variable once across defaults, vars and inventory files; put user overrides in localhost.yml.", Related: related,
			})
		}
	}
	return diagnostics
}
