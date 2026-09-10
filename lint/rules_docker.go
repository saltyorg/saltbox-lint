package lint

import (
	"fmt"
	"slices"
	"strings"
)

func dockerDiagnostic(source *Source, id string, span Span, message, expected string) Diagnostic {
	return Diagnostic{Path: source.Path, RuleID: id, Severity: "error", Span: span, Message: message, Expected: expected}
}

func checkDockerAggregateContract(_ *Project, source *Source) []Diagnostic {
	declarations := declarationsByName(source)
	var diagnostics []Diagnostic
	prefix := source.Role + "_role_docker_"
	for _, declaration := range topLevelDeclarations(source) {
		// Environment access is constrained even outside the owning aggregate. Prefer
		// its actionable contract hint over a duplicate generic layer finding.
		if issues := dockerEnvironmentIssues(source, declaration); len(issues) > 0 {
			diagnostics = append(diagnostics, issues...)
			continue
		}
		if !strings.HasPrefix(declaration.Name, prefix) || strings.HasSuffix(declaration.Name, "_default") || strings.HasSuffix(declaration.Name, "_custom") {
			continue
		}
		def, hasDefault := declarations[declaration.Name+"_default"]
		_, hasCustom := declarations[declaration.Name+"_custom"]
		specialized := declaration.Name == prefix+"networks" || declaration.Name == prefix+"hosts"
		if !hasDefault || !hasCustom {
			if specialized {
				var missing []string
				if !hasDefault {
					missing = append(missing, declaration.Name+"_default")
				}
				if !hasCustom {
					missing = append(missing, declaration.Name+"_custom")
				}
				diagnostics = append(diagnostics, dockerDiagnostic(source, "docker-aggregate-contract", declaration.Key.Span, "Docker aggregate is missing companion declarations", "Define companion default(s) "+strings.Join(missing, ", ")+"."))
			}
			continue
		}
		var hint string
		switch declaration.Name {
		case prefix + "networks":
			hint = dockerNetworkHint(source, declaration, def)
		case prefix + "hosts":
			if !slices.Equal(dockerFormula(source, declaration), []string{"@default", "|", "combine", "(", "@custom", ")"}) {
				hint = fmt.Sprintf("Only combine role-local host mappings: {{ lookup('role_var', '_docker_hosts_default', role='%s') | combine(lookup('role_var', '_docker_hosts_custom', role='%s')) }}.", source.Role, source.Role)
			}
		default:
			hint = dockerLayerHint(source, declaration)
		}
		if hint != "" {
			diagnostics = append(diagnostics, dockerDiagnostic(source, "docker-aggregate-contract", declaration.Key.Span, "Docker aggregate does not follow its layer contract", hint))
		}
	}
	return diagnostics
}

func canonicalDockerLayer(call Call, suffix, role string) bool {
	plugin, ok := lookupPlugin(call)
	value, valueOK := lookupPositionalLiteral(call, 1)
	target, targetOK := lookupNamedLiteral(call, "role")
	return ok && valueOK && targetOK && plugin == "role_var" && value == suffix && target == role && len(call.Arguments) == 3
}

func dockerLayerHint(source *Source, declaration defaultDeclaration) string {
	suffix := strings.TrimPrefix(declaration.Name, source.Role+"_role")
	def, custom := -1, -1
	for _, expression := range expressionsForDeclaration(source, declaration) {
		for _, call := range Calls(expression, "lookup") {
			if def < 0 && canonicalDockerLayer(call, suffix+"_default", source.Role) {
				def = call.Span.Start
			}
			if custom < 0 && canonicalDockerLayer(call, suffix+"_custom", source.Role) {
				custom = call.Span.Start
			}
		}
	}
	if def < 0 || custom < 0 {
		return fmt.Sprintf("Read both %s_default and %s_custom with explicit lookup('role_var', ..., role='%s') calls and no extra arguments, default before custom.", suffix, suffix, source.Role)
	}
	if def > custom {
		return "Read the _default layer before the _custom layer."
	}
	return ""
}

// dockerFormula projects shared tokens into the small, exact formula vocabulary.
// Calls are recognized by shared analysis, never by reparsing YAML/Jinja text.
func dockerFormula(source *Source, declaration defaultDeclaration) []string {
	expressions := expressionsForDeclaration(source, declaration)
	if len(expressions) != 1 || declaration.Value == nil || declaration.Value.Kind != "string" {
		return nil
	}
	expression := expressions[0]
	if !expression.Complete || expression.Kind != "output" || strings.TrimSpace(declaration.Value.Value) != strings.TrimSpace(expression.text) {
		return nil
	}
	suffix := strings.TrimPrefix(declaration.Name, source.Role+"_role")
	layers := make(map[int]Call)
	names := make(map[int]string)
	for _, call := range Calls(expression, "lookup") {
		for _, layer := range []string{"default", "custom"} {
			if canonicalDockerLayer(call, suffix+"_"+layer, source.Role) {
				layers[call.Span.Start] = call
				names[call.Span.Start] = "@" + layer
			}
		}
	}
	var formula []string
	for index := 0; index < len(expression.Tokens); index++ {
		token := expression.Tokens[index]
		if call, ok := layers[token.Span.Start]; ok {
			formula = append(formula, names[token.Span.Start])
			for index+1 < len(expression.Tokens) && expression.Tokens[index+1].Span.Start < call.Span.End {
				index++
			}
			continue
		}
		text := token.Text
		if literal, ok := jinjaStringLiteral([]Token{token}); ok {
			text = "'" + literal + "'"
		}
		formula = append(formula, text)
	}
	return formula
}

func dockerNetworkHint(source *Source, declaration, defaults defaultDeclaration) string {
	formula := dockerFormula(source, declaration)
	standard := []string{"docker_networks_common", "+", "@default", "+", "@custom"}
	if slices.Equal(formula, standard) {
		return ""
	}
	pinned := []string{"(", "docker_networks_common", "|", "map", "(", "'combine'", ",", "{", "'driver_opts'", ":", "{", "'com.docker.network.endpoint.ifname'", ":", "@interface", "}", "}", ")", "|", "list", ")", "+", "@default", "+", "@custom"}
	if len(formula) == len(pinned) && len(formula[13]) > 2 && formula[13][0] == '\'' && formula[13][len(formula[13])-1] == '\'' {
		common := formula[13][1 : len(formula[13])-1]
		pinned[13] = formula[13]
		if slices.Equal(formula, pinned) {
			pins := dockerNetworkPins(defaults.Value)
			if len(pins) == 0 {
				return "Pin an application network with driver_opts.com.docker.network.endpoint.ifname when common networks are interface-pinned."
			}
			if slices.Contains(pins, common) {
				return "Use distinct interface names for common and application networks."
			}
			return ""
		}
	}
	return fmt.Sprintf("Use docker_networks_common + lookup('role_var', '_docker_networks_default', role='%s') + lookup('role_var', '_docker_networks_custom', role='%s'), or map common networks with combine(driver_opts interface pin) | list before those same layers; do not add other branches.", source.Role, source.Role)
}

func dockerNetworkPins(node *Node) []string {
	if node == nil || node.Kind != "sequence" {
		return nil
	}
	var pins []string
	for _, item := range node.Items {
		pin := item.Get("driver_opts").Get("com.docker.network.endpoint.ifname")
		if pin != nil && pin.Kind == "string" && strings.TrimSpace(pin.Value) != "" {
			pins = append(pins, pin.Value)
		}
	}
	return pins
}

func dockerEnvironmentIssues(source *Source, declaration defaultDeclaration) []Diagnostic {
	var diagnostics []Diagnostic
	for _, expression := range expressionsForDeclaration(source, declaration) {
		if !expression.Complete {
			continue
		}
		for _, token := range VariableReads(expression) {
			if !strings.HasSuffix(token.Text, "_role_docker_envs_custom") || !defaultVariableName.MatchString(token.Text) {
				continue
			}
			diagnostics = append(diagnostics, dockerDiagnostic(source, "docker-aggregate-contract", token.Span, "Docker custom environments are read directly", "Read custom environments through explicit role_var lookup in their final Docker environment aggregate."))
		}
		for _, call := range Calls(expression, "lookup") {
			plugin, _ := lookupPlugin(call)
			suffix, _ := lookupPositionalLiteral(call, 1)
			if plugin != "role_var" || suffix != "_docker_envs_custom" {
				continue
			}
			role, literal := lookupNamedLiteral(call, "role")
			hint := ""
			switch {
			case !literal || !defaultVariableName.MatchString(role):
				hint = "Use a literal role target for _docker_envs_custom."
			case declaration.Name != role+"_role_docker_envs":
				hint = "Read _docker_envs_custom only in " + role + "_role_docker_envs."
			case !finalEnvironmentLayer(declaration, expression, call):
				hint = "Make _docker_envs_custom the final combine(lookup('role_var', '_docker_envs_custom', role='" + role + "')) layer of its Docker environment aggregate."
			}
			if hint != "" {
				diagnostics = append(diagnostics, dockerDiagnostic(source, "docker-aggregate-contract", call.Span, "Docker custom environment access violates final override ownership", hint))
			}
		}
	}
	// One aggregate finding explains the specialized failure instead of repeating
	// it alongside generic missing/order errors. Other defaults retain read spans.
	if declaration.Name == source.Role+"_role_docker_envs" && len(diagnostics) > 0 {
		diagnostics[0].Span = declaration.Key.Span
		return diagnostics[:1]
	}
	return diagnostics
}

func finalEnvironmentLayer(declaration defaultDeclaration, expression Expression, call Call) bool {
	if declaration.Value == nil || declaration.Value.Kind != "string" || expression.Kind != "output" || strings.TrimSpace(declaration.Value.Value) != strings.TrimSpace(expression.text) {
		return false
	}
	tokens := expression.Tokens
	for index, token := range tokens {
		if token.Span.Start != call.Span.Start || index < 3 {
			continue
		}
		if tokens[index-3].Text != "|" || tokens[index-2].Text != "combine" || tokens[index-1].Text != "(" {
			return false
		}
		end := index
		for end < len(tokens) && tokens[end].Span.Start < call.Span.End {
			end++
		}
		return end == len(tokens)-1 && tokens[end].Text == ")"
	}
	return false
}

func checkDockerEmptyLayers(_ *Project, source *Source) []Diagnostic {
	declarations := declarationsByName(source)
	var diagnostics []Diagnostic
	for _, def := range topLevelDeclarations(source) {
		if !strings.HasPrefix(def.Name, source.Role+"_role_docker_") || !strings.HasSuffix(def.Name, "_default") {
			continue
		}
		name := strings.TrimSuffix(def.Name, "_default")
		if name == source.Role+"_role_docker_networks" {
			continue
		}
		custom, found := declarations[name+"_custom"]
		if !found || !emptyDockerCollection(def.Value) || !emptyDockerCollection(custom.Value) || def.Value.Kind != custom.Value.Kind {
			continue
		}
		span := def.Key.Span
		if aggregate, exists := declarations[name]; exists {
			formula := dockerFormula(source, aggregate)
			expected := []string{"@default", "+", "@custom"}
			if def.Value.Kind == "mapping" {
				expected = []string{"@default", "|", "combine", "(", "@custom", ")"}
			}
			if !slices.Equal(formula, expected) {
				continue
			}
			span = aggregate.Key.Span
		}
		diagnostics = append(diagnostics, dockerDiagnostic(source, "docker-empty-layers", span, "Docker default and custom layers contain no meaningful input", "Remove the redundant declarations and omit the unused Docker section; retain layers when another meaningful source contributes."))
	}
	return diagnostics
}

func emptyDockerCollection(node *Node) bool {
	return node != nil && ((node.Kind == "mapping" && len(node.Entries) == 0) || (node.Kind == "sequence" && len(node.Items) == 0))
}
