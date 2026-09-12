package lint

import (
	"fmt"
	"regexp"
	"strings"
)

type defaultDeclaration struct {
	Name       string
	Key, Value *Node
}

var defaultVariableName = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

func topLevelDeclarations(source *Source) []defaultDeclaration {
	var declarations []defaultDeclaration
	if source == nil {
		return declarations
	}
	for _, document := range source.Documents {
		if document == nil || document.Kind != "mapping" {
			continue
		}
		for _, entry := range document.Entries {
			if entry.Key == nil || entry.Key.Kind != "string" {
				continue
			}
			declarations = append(declarations, defaultDeclaration{Name: entry.Key.Value, Key: entry.Key, Value: entry.Value})
		}
	}
	return declarations
}

func declarationsByName(source *Source) map[string]defaultDeclaration {
	declarations := make(map[string]defaultDeclaration)
	for _, declaration := range topLevelDeclarations(source) {
		declarations[declaration.Name] = declaration
	}
	return declarations
}

func expressionsForDeclaration(source *Source, declaration defaultDeclaration) []Expression {
	if declaration.Value == nil {
		return nil
	}
	nodes := make(map[*Node]bool)
	var visit func(*Node)
	visit = func(node *Node) {
		if node == nil {
			return
		}
		nodes[node] = true
		for _, entry := range node.Entries {
			visit(entry.Key)
			visit(entry.Value)
		}
		for _, item := range node.Items {
			visit(item)
		}
	}
	visit(declaration.Value)
	return expressionsMatching(source, func(node *Node) bool { return nodes[node] })
}

func checkRoleVariablePrefix(_ *Project, source *Source) []Diagnostic {
	var diagnostics []Diagnostic
	for _, declaration := range topLevelDeclarations(source) {
		if !strings.Contains(declaration.Name, "_role_") || !defaultVariableName.MatchString(declaration.Name) {
			continue
		}
		expectedPrefix := source.Role + "_"
		if strings.HasPrefix(declaration.Name, expectedPrefix) {
			continue
		}
		expectedName := expectedPrefix + declaration.Name
		diagnostics = append(diagnostics, Diagnostic{
			Path:     source.Path,
			RuleID:   "role-variable-prefix",
			Severity: "error",
			Span:     declaration.Key.Span,
			Message:  fmt.Sprintf("role default %q uses a prefix owned by another role", declaration.Name),
			Expected: fmt.Sprintf("Use an owning-role name such as %q, beginning with %q.", expectedName, expectedPrefix),
		})
	}
	return diagnostics
}

var defaultsSectionOrder = []string{"Basics", "Settings", "Postgres", "Paths", "Web", "DNS", "Traefik", "Docker", "Dependencies"}

type sourceLine struct {
	Text string
	Span Span
}

func sourceLines(data []byte) []sourceLine {
	lines := make([]sourceLine, 0, 1+strings.Count(string(data), "\n"))
	for start := 0; start <= len(data); {
		end := start
		for end < len(data) && data[end] != '\n' {
			end++
		}
		contentEnd := end
		if contentEnd > start && data[contentEnd-1] == '\r' {
			contentEnd--
		}
		lines = append(lines, sourceLine{Text: string(data[start:contentEnd]), Span: Span{start, contentEnd}})
		if end == len(data) {
			break
		}
		start = end + 1
	}
	return lines
}

func checkDefaultsSections(_ *Project, source *Source) []Diagnostic {
	positions := make(map[string]int, len(defaultsSectionOrder))
	for index, section := range defaultsSectionOrder {
		positions[section] = index
	}
	lines := sourceLines(source.Data)
	seen := make(map[string]sourceLine)
	previousName := ""
	previousPosition := -1
	var diagnostics []Diagnostic
	for _, banner := range sectionBanners(source, lines) {
		line := banner.Title
		section := banner.Name
		position, canonical := positions[section]
		if !canonical || line.Text != "# "+section {
			continue
		}
		if first, duplicate := seen[section]; duplicate {
			diagnostics = append(diagnostics, Diagnostic{
				Path:     source.Path,
				RuleID:   "defaults-sections",
				Severity: "error",
				Span:     line.Span,
				Message:  fmt.Sprintf("defaults section %q is declared more than once", section),
				Expected: fmt.Sprintf("Declare the %q section once.", section),
				Related:  []RelatedLocation{{Path: source.Path, Span: first.Span, Message: "first section declaration"}},
			})
			continue
		}
		seen[section] = line
		if position < previousPosition {
			diagnostics = append(diagnostics, Diagnostic{
				Path:     source.Path,
				RuleID:   "defaults-sections",
				Severity: "error",
				Span:     line.Span,
				Message:  fmt.Sprintf("defaults section %q appears after %q", section, previousName),
				Expected: fmt.Sprintf("Place %q before %q; canonical order is %s.", section, previousName, strings.Join(defaultsSectionOrder, ", ")),
			})
			continue
		}
		previousName = section
		previousPosition = position
	}
	return diagnostics
}

func precedingPhysicalLine(source *Source, offset int) string {
	if source == nil || offset <= 0 {
		return ""
	}
	currentStart := strings.LastIndexByte(string(source.Data[:offset]), '\n') + 1
	if currentStart == 0 {
		return ""
	}
	previousEnd := currentStart - 1
	if previousEnd > 0 && source.Data[previousEnd-1] == '\r' {
		previousEnd--
	}
	previousStart := strings.LastIndexByte(string(source.Data[:previousEnd]), '\n') + 1
	return string(source.Data[previousStart:previousEnd])
}

func checkComputedDefaultDocumentation(_ *Project, source *Source) []Diagnostic {
	prefix := source.Role + "_role_"
	var diagnostics []Diagnostic
	for _, declaration := range topLevelDeclarations(source) {
		if !strings.HasPrefix(declaration.Name, prefix) || !strings.HasSuffix(declaration.Name, "_lookup") || !defaultVariableName.MatchString(declaration.Name) {
			continue
		}
		line := precedingPhysicalLine(source, declaration.Key.Span.Start)
		if line == "# Skip docs" || line == "# Do not edit or override using the inventory" {
			continue
		}
		diagnostics = append(diagnostics, Diagnostic{
			Path:     source.Path,
			RuleID:   "computed-default-documentation",
			Severity: "error",
			Span:     declaration.Key.Span,
			Message:  fmt.Sprintf("computed default %q is exposed to generated inventory documentation", declaration.Name),
			Expected: "Put # Skip docs or # Do not edit or override using the inventory immediately above the declaration.",
		})
	}
	return diagnostics
}

func checkRoleDockerState(_ *Project, source *Source) []Diagnostic {
	var diagnostics []Diagnostic
	for _, declaration := range topLevelDeclarations(source) {
		if !strings.HasSuffix(declaration.Name, "_role_docker_state") {
			continue
		}
		diagnostics = append(diagnostics, Diagnostic{
			Path:     source.Path,
			RuleID:   "role-docker-state",
			Severity: "error",
			Span:     declaration.Key.Span,
			Message:  fmt.Sprintf("role default %q overrides container state ownership", declaration.Name),
			Expected: "Remove this state declaration; the shared Docker helper owns container state.",
		})
	}
	return diagnostics
}

func checkDockerImageContract(_ *Project, source *Source) []Diagnostic {
	declarations := declarationsByName(source)
	imageName := source.Role + "_role_docker_image"
	image, found := declarations[imageName]
	if !found {
		return nil
	}
	repoName := imageName + "_repo"
	tagName := imageName + "_tag"
	var missingDefaults []string
	for _, name := range []string{repoName, tagName} {
		if _, exists := declarations[name]; !exists {
			missingDefaults = append(missingDefaults, name)
		}
	}
	if len(missingDefaults) > 0 {
		return []Diagnostic{{
			Path:     source.Path,
			RuleID:   "docker-image-contract",
			Severity: "error",
			Span:     image.Key.Span,
			Message:  fmt.Sprintf("Docker image default %q is missing companion declarations", imageName),
			Expected: fmt.Sprintf("Define companion default(s) %s.", strings.Join(missingDefaults, ", ")),
		}}
	}
	expressions := expressionsForDeclaration(source, image)
	var missingReads []string
	for _, suffix := range []string{"_docker_image_repo", "_docker_image_tag"} {
		if !hasExplicitRoleVarLookup(expressions, suffix, source.Role) {
			missingReads = append(missingReads, suffix)
		}
	}
	if len(missingReads) == 0 {
		return nil
	}
	return []Diagnostic{{
		Path:     source.Path,
		RuleID:   "docker-image-contract",
		Severity: "error",
		Span:     image.Key.Span,
		Message:  fmt.Sprintf("Docker image default %q does not read all of its companion defaults", imageName),
		Expected: fmt.Sprintf("Read %s with explicit lookup('role_var', ..., role='%s') calls.", strings.Join(missingReads, " and "), source.Role),
	}}
}
