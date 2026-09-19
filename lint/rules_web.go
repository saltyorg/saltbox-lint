package lint

import (
	"fmt"
	"regexp"
	"strings"
)

func jinjaStringLiteral(tokens []Token) (string, bool) {
	if len(tokens) != 1 || tokens[0].Kind != "string" || len(tokens[0].Text) < 2 {
		return "", false
	}
	text := tokens[0].Text
	if text[0] != text[len(text)-1] || (text[0] != '\'' && text[0] != '"') || strings.ContainsRune(text[1:len(text)-1], '\\') {
		return "", false
	}
	return text[1 : len(text)-1], true
}

func lookupPlugin(call Call) (string, bool) {
	if len(call.Arguments) == 0 || call.Arguments[0].Name != "" {
		return "", false
	}
	return jinjaStringLiteral(call.Arguments[0].Tokens)
}

func lookupPositionalLiteral(call Call, index int) (string, bool) {
	position := 0
	for _, argument := range call.Arguments {
		if argument.Name != "" {
			continue
		}
		if position == index {
			return jinjaStringLiteral(argument.Tokens)
		}
		position++
	}
	return "", false
}

func lookupNamedLiteral(call Call, name string) (string, bool) {
	for _, argument := range call.Arguments {
		if argument.Name == name {
			return jinjaStringLiteral(argument.Tokens)
		}
	}
	return "", false
}

func hasNamedArgument(call Call, name string) bool {
	for _, argument := range call.Arguments {
		if argument.Name == name {
			return true
		}
	}
	return false
}

func hasExplicitRoleVarLookup(expressions []Expression, suffix, role string) bool {
	for _, expression := range expressions {
		for _, call := range Calls(expression, "lookup") {
			plugin, pluginOK := lookupPlugin(call)
			candidateSuffix, suffixOK := lookupPositionalLiteral(call, 1)
			candidateRole, roleOK := lookupNamedLiteral(call, "role")
			if pluginOK && suffixOK && roleOK && plugin == "role_var" && candidateSuffix == suffix && candidateRole == role {
				return true
			}
		}
	}
	return false
}

func checkRoleLookupTarget(_ *Project, source *Source) []Diagnostic {
	var diagnostics []Diagnostic
	for _, expression := range Expressions(source) {
		for _, call := range Calls(expression, "lookup") {
			plugin, ok := lookupPlugin(call)
			if !ok || (plugin != "role_var" && plugin != "role_web") || hasNamedArgument(call, "role") {
				continue
			}
			diagnostics = append(diagnostics, Diagnostic{
				Path:     source.Path,
				RuleID:   "role-lookup-target",
				Severity: "error",
				Span:     call.Span,
				Message:  fmt.Sprintf("%s lookup has no explicit target role", plugin),
				Expected: fmt.Sprintf("Add role='%s' or the intended cross-role target to this lookup().", source.Role),
			})
		}
	}
	return diagnostics
}

type endpointComponents struct {
	Subdomain, Domain bool
}

var endpointComponentName = regexp.MustCompile(`^([a-z][a-z0-9_]*)_(subdomain|domain)$`)

func checkRoleWebContract(_ *Project, source *Source) []Diagnostic {
	declarations := declarationsByName(source)
	expressions := newDeclarationExpressionQuery(source)
	components := make(map[string]endpointComponents)
	rolePrefix := source.Role + "_role_"
	for name := range declarations {
		if !strings.HasPrefix(name, rolePrefix) {
			continue
		}
		match := endpointComponentName.FindStringSubmatch(strings.TrimPrefix(name, rolePrefix))
		if match == nil {
			continue
		}
		endpoint := match[1]
		found := components[endpoint]
		found.Subdomain = found.Subdomain || match[2] == "subdomain"
		found.Domain = found.Domain || match[2] == "domain"
		components[endpoint] = found
	}

	recognized := make(map[string]bool)
	reported := make(map[string]bool)
	var diagnostics []Diagnostic
	for endpoint, found := range components {
		if !found.Subdomain || !found.Domain {
			continue
		}
		prefix := source.Role + "_role_" + endpoint
		for _, contract := range []struct {
			name, scheme string
		}{
			{prefix + "_host", ""},
			{prefix + "_url", "https"},
			{prefix + "_insecure_url", "http"},
		} {
			declaration, exists := declarations[contract.name]
			if !exists {
				continue
			}
			recognized[contract.name] = true
			if canonicalRoleWebDefault(source, declaration, endpoint, contract.scheme, expressions) || (contract.scheme == "https" && hasCanonicalHostFallback(source, declaration, endpoint, declarations, expressions)) {
				continue
			}
			diagnostics = append(diagnostics, roleWebDiagnostic(source, declaration, source.Role, endpoint, contract.scheme, "endpoint default does not use its canonical role_web contract"))
			reported[contract.name] = true
		}
	}

	for _, declaration := range topLevelDeclarations(source) {
		declarationExpressions := expressions.expressions(declaration)
		if !recognized[declaration.Name] && (strings.HasSuffix(declaration.Name, "_host") || strings.HasSuffix(declaration.Name, "_url")) && hasDirectLookupDefault(declaration, "role_web", expressions) {
			diagnostics = append(diagnostics, Diagnostic{
				Path:     source.Path,
				RuleID:   "role-web-contract",
				Severity: "error",
				Span:     declaration.Key.Span,
				Message:  fmt.Sprintf("web default %q has no complete endpoint component family", declaration.Name),
				Expected: "Use a canonical host or URL name with matching subdomain and domain declarations.",
			})
			reported[declaration.Name] = true
		}

		targetRole, endpoint, composed := directlyComposedEndpoint(declaration.Value, declarationExpressions)
		if !composed || reported[declaration.Name] {
			continue
		}
		scheme := ""
		if strings.HasSuffix(declaration.Name, "_insecure_url") {
			scheme = "http"
		} else if strings.HasSuffix(declaration.Name, "_url") {
			scheme = "https"
		}
		diagnostics = append(diagnostics, roleWebDiagnostic(source, declaration, targetRole, endpoint, scheme, "default repeats endpoint subdomain and domain lookups"))
		reported[declaration.Name] = true
	}
	return diagnostics
}

func hasDirectLookupDefault(declaration defaultDeclaration, plugin string, expressions *declarationExpressionQuery) bool {
	if declaration.Value == nil || declaration.Value.Kind != "string" {
		return false
	}
	for _, expression := range expressions.expressions(declaration) {
		if strings.TrimSpace(declaration.Value.Value) != strings.TrimSpace(expression.text) {
			continue
		}
		if _, ok := directLookup(expression, plugin); ok {
			return true
		}
	}
	return false
}

func directLookup(expression Expression, plugin string) (Call, bool) {
	if !expression.Complete || len(expression.Tokens) == 0 {
		return Call{}, false
	}
	for _, call := range Calls(expression, "lookup") {
		found, ok := lookupPlugin(call)
		if ok && found == plugin && call.Span.Start == expression.Tokens[0].Span.Start && call.Span.End == expression.Tokens[len(expression.Tokens)-1].Span.End {
			return call, true
		}
	}
	return Call{}, false
}

func canonicalRoleWebDefault(source *Source, declaration defaultDeclaration, endpoint, scheme string, query *declarationExpressionQuery) bool {
	if declaration.Value == nil || declaration.Value.Kind != "string" {
		return false
	}
	expressions := query.expressions(declaration)
	if len(expressions) != 1 || strings.TrimSpace(declaration.Value.Value) != strings.TrimSpace(expressions[0].text) {
		return false
	}
	call, ok := directLookup(expressions[0], "role_web")
	if !ok {
		return false
	}
	expectedArguments := 2
	if endpoint != "web" {
		expectedArguments++
	}
	if scheme != "" {
		expectedArguments++
	}
	if len(call.Arguments) != expectedArguments {
		return false
	}
	role, roleOK := lookupNamedLiteral(call, "role")
	if !roleOK || role != source.Role {
		return false
	}
	if endpoint == "web" {
		if hasNamedArgument(call, "endpoint") {
			return false
		}
	} else if found, ok := lookupNamedLiteral(call, "endpoint"); !ok || found != endpoint {
		return false
	}
	if scheme == "" {
		return !hasNamedArgument(call, "scheme")
	}
	found, ok := lookupNamedLiteral(call, "scheme")
	return ok && found == scheme
}

func hasCanonicalHostFallback(source *Source, declaration defaultDeclaration, endpoint string, declarations map[string]defaultDeclaration, query *declarationExpressionQuery) bool {
	hostName := source.Role + "_role_" + endpoint + "_host"
	if _, exists := declarations[hostName]; !exists || declaration.Value == nil || declaration.Value.Kind != "string" {
		return false
	}
	expressions := query.expressions(declaration)
	if len(expressions) != 1 || declaration.Value.Value != "https://"+expressions[0].text {
		return false
	}
	call, ok := directLookup(expressions[0], "role_var")
	if !ok || len(call.Arguments) != 3 {
		return false
	}
	suffix, suffixOK := lookupPositionalLiteral(call, 1)
	role, roleOK := lookupNamedLiteral(call, "role")
	return suffixOK && roleOK && suffix == "_"+endpoint+"_host" && role == source.Role
}

// Only one string scalar can form a web default. Its output expressions may
// join across a literal dot; separate YAML entries never share a composition.
func directlyComposedEndpoint(value *Node, expressions []Expression) (string, string, bool) {
	if value == nil || value.Kind != "string" {
		return "", "", false
	}
	var chain []roleVarLookup
	end := 0
	first := true
	for _, expression := range expressions {
		if expression.node != value || expression.Kind != "output" || !expression.Complete {
			continue
		}
		start := strings.Index(value.Value[end:], expression.text)
		if start < 0 {
			return "", "", false
		}
		start += end
		parts := composedRoleVarLookups(expression.Tokens)
		if first || strings.TrimSpace(value.Value[end:start]) != "." || len(parts) == 0 {
			if role, endpoint, ok := pairedEndpoint(chain); ok {
				return role, endpoint, true
			}
			chain = nil
		}
		chain = append(chain, parts...)
		end = start + len(expression.text)
		first = false
	}
	return pairedEndpoint(chain)
}

// Decompose only grouping and top-level string concatenation. Nested call
// arguments, collections, and conditional alternatives are opaque operands.
func composedRoleVarLookups(tokens []Token) []roleVarLookup {
	tokens = stripGrouping(tokens)
	if syntax := inspectRegion(tokens, 0, len(tokens)); syntax.If >= 0 {
		return nil
	}
	if found, ok := directRoleVarLookup(tokens); ok {
		return []roleVarLookup{found}
	}
	var parts []roleVarLookup
	start := 0
	joined := false
	for i := 0; i < len(tokens); i++ {
		switch tokens[i].Text {
		case "(", "[", "{":
			end := balancedEnd(tokens, i, len(tokens))
			if end < 0 {
				return nil
			}
			i = end
		case "~", "+":
			joined = true
			parts = append(parts, composedRoleVarLookups(tokens[start:i])...)
			start = i + 1
		}
	}
	if joined {
		return append(parts, composedRoleVarLookups(tokens[start:])...)
	}
	return nil
}

func pairedEndpoint(lookups []roleVarLookup) (string, string, bool) {
	components := make(map[roleVarLookup]endpointComponents)
	var order []roleVarLookup
	for _, lookup := range lookups {
		component := ""
		switch {
		case strings.HasSuffix(lookup.Suffix, "_subdomain"):
			component = "subdomain"
		case strings.HasSuffix(lookup.Suffix, "_domain"):
			component = "domain"
		default:
			continue
		}
		endpoint := strings.TrimPrefix(strings.TrimSuffix(lookup.Suffix, "_"+component), "_")
		if endpoint == "" || lookup.Suffix != "_"+endpoint+"_"+component {
			continue
		}
		key := roleVarLookup{Role: lookup.Role, Suffix: endpoint}
		if _, exists := components[key]; !exists {
			order = append(order, key)
		}
		found := components[key]
		found.Subdomain = found.Subdomain || component == "subdomain"
		found.Domain = found.Domain || component == "domain"
		components[key] = found
	}
	for _, key := range order {
		if found := components[key]; found.Subdomain && found.Domain {
			return key.Role, key.Suffix, true
		}
	}
	return "", "", false
}

func roleWebDiagnostic(source *Source, declaration defaultDeclaration, role, endpoint, scheme, message string) Diagnostic {
	arguments := []string{fmt.Sprintf("role='%s'", role)}
	if endpoint != "web" {
		arguments = append(arguments, fmt.Sprintf("endpoint='%s'", endpoint))
	}
	if scheme != "" {
		arguments = append(arguments, fmt.Sprintf("scheme='%s'", scheme))
	}
	return Diagnostic{
		Path:     source.Path,
		RuleID:   "role-web-contract",
		Severity: "error",
		Span:     declaration.Key.Span,
		Message:  fmt.Sprintf("%s: %q", message, declaration.Name),
		Expected: fmt.Sprintf("Use lookup('role_web', %s).", strings.Join(arguments, ", ")),
	}
}

type roleVarLookup struct {
	Suffix, Role string
}

func directRoleVarLookup(tokens []Token) (roleVarLookup, bool) {
	if len(tokens) < 4 {
		return roleVarLookup{}, false
	}
	expression := Expression{Complete: true, Tokens: tokens}
	call, ok := directLookup(expression, "role_var")
	if !ok || len(call.Arguments) != 3 {
		return roleVarLookup{}, false
	}
	suffix, suffixOK := lookupPositionalLiteral(call, 1)
	role, roleOK := lookupNamedLiteral(call, "role")
	return roleVarLookup{Suffix: suffix, Role: role}, suffixOK && roleOK
}

func stripGrouping(tokens []Token) []Token {
	for len(tokens) >= 2 && tokens[0].Text == "(" && balancedEnd(tokens, 0, len(tokens)) == len(tokens)-1 {
		tokens = tokens[1 : len(tokens)-1]
	}
	return tokens
}

func repeatedRoleVarFallback(tokens []Token) (Token, string, bool) {
	syntax := inspectRegion(tokens, 0, len(tokens))
	if syntax.If < 0 || syntax.Else < 0 {
		return Token{}, "", false
	}
	value, valueOK := directRoleVarLookup(tokens[:syntax.If])
	condition := stripGrouping(tokens[syntax.If+1 : syntax.Else])
	if !valueOK || len(condition) < 5 {
		return Token{}, "", false
	}
	closing := balancedEnd(condition, 1, len(condition))
	if len(condition) < 4 || condition[0].Text != "lookup" || condition[1].Text != "(" || closing < 0 {
		return Token{}, "", false
	}
	predicate, predicateOK := directRoleVarLookup(condition[:closing+1])
	tail := condition[closing+1:]
	if !predicateOK || predicate != value || len(tail) != 4 || tail[0].Text != "|" || tail[1].Text != "length" || tail[2].Text != ">" || tail[3].Text != "0" {
		return Token{}, "", false
	}
	fallback := stripGrouping(tokens[syntax.Else+1:])
	if len(fallback) == 1 && fallback[0].Kind == "name" && fallback[0].Text == "omit" {
		return tokens[syntax.If], "omit", true
	}
	if _, ok := directRoleVarLookup(fallback); ok {
		return tokens[syntax.If], "lookup(...)", true
	}
	return Token{}, "", false
}

func checkRoleVarEmptyDefault(_ *Project, source *Source) []Diagnostic {
	var diagnostics []Diagnostic
	for _, expression := range Expressions(source) {
		if expression.Kind != "output" || !expression.Complete {
			continue
		}
		operator, fallback, repeated := repeatedRoleVarFallback(expression.Tokens)
		if !repeated {
			continue
		}
		diagnostics = append(diagnostics, Diagnostic{
			Path:     source.Path,
			RuleID:   "role-var-empty-default",
			Severity: "error",
			Span:     operator.Span,
			Message:  "repeated role_var lookup manually tests for an empty value",
			Expected: fmt.Sprintf("Use one role_var lookup with default=%s and default_if_empty=true.", fallback),
		})
	}
	return diagnostics
}
