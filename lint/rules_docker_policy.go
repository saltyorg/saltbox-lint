package lint

import (
	"slices"
	"strings"
)

// dockerPolicy is shared resource knowledge, not a resolved runtime value.
// Only literal boolean true authorizes a sparse omit policy.
type dockerPolicy struct {
	Suffix, Kind, Path string
	Span               Span
	Sparse             bool
}

func dockerResource(s *Source) bool {
	return s != nil && s.Kind == Tasks && strings.HasPrefix(s.Path, "resources/tasks/docker/")
}
func checkDockerVarsPolicy(p *Project, s *Source) []Diagnostic {
	if !dockerResource(s) {
		return nil
	}
	facts := analyzeDockerPolicies(p)
	policies, invalid := facts.policies, facts.invalid
	var ds []Diagnostic
	for _, suffix := range sortedKeys(policies) {
		declarations := policies[suffix]
		if len(policyKinds(declarations)) < 2 {
			continue
		}
		for _, policy := range declarations {
			if policy.Path != s.Path {
				continue
			}
			d := ansibleDiagnostic(s, "docker-vars-policy", policy.Span, "suffix "+suffix+" has conflicting policies: "+strings.Join(policyKinds(declarations), ", "), "Declare one consistent default, omit: true or required: true policy across shared Docker resources.")
			d.Related = policyLocations(declarations, policy)
			ds = append(ds, d)
		}
	}
	for _, e := range analysisRuntimeExpressions(p, s) {
		for _, access := range memberAccesses(e, "_docker_vars") {
			if !strings.HasPrefix(access.Name, "_docker_") || !sparseAccess(e, access) {
				continue
			}
			if len(invalid) > 0 {
				d := ansibleDiagnostic(s, "docker-vars-policy", access.Span, "cannot validate sparse fallback because Docker policy context is invalid", "Repair the related YAML context, then verify that this suffix has only omit: true declarations.")
				d.Related = slices.Clone(invalid)
				ds = append(ds, d)
				continue
			}
			declarations := policies[access.Name]
			allowed := len(declarations) > 0
			for _, policy := range declarations {
				allowed = allowed && policy.Sparse
			}
			if allowed {
				continue
			}
			found := strings.Join(policyKinds(declarations), ", ")
			if found == "" {
				found = "undeclared"
			}
			d := ansibleDiagnostic(s, "docker-vars-policy", access.Span, "sparse fallback for "+access.Name+" has "+found+" policy", "Use sparse fallback only for suffixes consistently declared with omit: true; read default/required values directly.")
			d.Related = policyLocations(declarations, dockerPolicy{})
			ds = append(ds, d)
		}
	}
	return ds
}
func policyKinds(policies []dockerPolicy) []string {
	var kinds []string
	for _, policy := range policies {
		if !slices.Contains(kinds, policy.Kind) {
			kinds = append(kinds, policy.Kind)
		}
	}
	slices.Sort(kinds)
	return kinds
}
func policyLocations(policies []dockerPolicy, primary dockerPolicy) []RelatedLocation {
	var related []RelatedLocation
	for _, policy := range policies {
		if policy.Path == primary.Path && policy.Span == primary.Span {
			continue
		}
		location := RelatedLocation{Path: policy.Path, Span: policy.Span, Message: policy.Suffix + " declares " + policy.Kind}
		if !slices.Contains(related, location) {
			related = append(related, location)
		}
	}
	return related
}
func sparseAccess(e Expression, a variableAccess) bool {
	if a.Method {
		return true
	}
	ts := e.Tokens
	i := a.End
	if i+2 < len(ts) && ts[i].Text == "|" && ts[i+1].Text == "default" && ts[i+2].Text == "(" {
		return true
	}
	if i < len(ts) && ts[i].Text == "is" {
		i++
		if i < len(ts) && ts[i].Text == "not" {
			i++
		}
		return i < len(ts) && ts[i].Text == "defined"
	}
	return false
}
func dockerPolicies(s *Source, expressions []Expression) []dockerPolicy {
	var policies []dockerPolicy
	tasks := TasksIn(s)
	for _, e := range expressions {
		owner := -1
		// A nested task owns its expressions, rather than the enclosing block.
		for i, task := range tasks {
			if e.Span.Start >= task.Node.Span.Start && e.Span.End <= task.Node.Span.End {
				owner = i
			}
		}
		if owner < 0 {
			continue
		}
		for _, call := range Calls(e, "lookup") {
			plugin, ok := lookupPlugin(call)
			if !ok || plugin != "docker_vars" {
				continue
			}
			for _, arg := range call.Arguments {
				if arg.Name != "specs" {
					continue
				}
				if len(arg.Tokens) == 1 && arg.Tokens[0].Kind == "name" {
					specs := tasks[owner].Vars.Get(arg.Tokens[0].Text)
					policies = append(policies, yamlDockerPolicies(s, specs)...)
				} else {
					policies = append(policies, literalDockerPolicies(s, arg.Tokens)...)
				}
			}
		}
	}
	// The same specs can feed multiple lookups without becoming duplicate evidence.
	var unique []dockerPolicy
	for _, policy := range policies {
		if !slices.Contains(unique, policy) {
			unique = append(unique, policy)
		}
	}
	return unique
}
func yamlDockerPolicies(s *Source, specs *Node) []dockerPolicy {
	if specs == nil || specs.Kind != "mapping" {
		return nil
	}
	var result []dockerPolicy
	for _, entry := range specs.Entries {
		suffix := entry.Key.Value
		if !strings.HasPrefix(suffix, "_docker_") || entry.Value.Kind != "mapping" {
			continue
		}
		for _, policy := range entry.Value.Entries {
			kind := policy.Key.Value
			if !slices.Contains([]string{"default", "omit", "required"}, kind) {
				continue
			}
			scalarKind, scalarValue := EffectiveScalar(policy.Value)
			truth := scalarKind == "bool" && scalarValue == "true"
			result = append(result, newDockerPolicy(s, suffix, kind, entry.Key.Span, truth))
		}
	}
	return result
}
func newDockerPolicy(s *Source, suffix, kind string, span Span, truth bool) dockerPolicy {
	sparse := kind == "omit" && truth
	if kind != "default" && !truth {
		kind += " (not literal true)"
	}
	return dockerPolicy{Suffix: suffix, Kind: kind, Path: s.Path, Span: span, Sparse: sparse}
}

// literalMapEntries projects an explicit Jinja dictionary into existing tokens.
// Nested values remain opaque token ranges; no expression is evaluated.
type literalMapEntry struct {
	Key   Token
	Value []Token
}

func literalMapEntries(tokens []Token) []literalMapEntry {
	ts := stripGrouping(tokens)
	if len(ts) < 2 || ts[0].Text != "{" || balancedEnd(ts, 0, len(ts)) != len(ts)-1 {
		return nil
	}
	var entries []literalMapEntry
	for i := 1; i < len(ts)-1; {
		if i+2 >= len(ts) || ts[i].Kind != "string" || ts[i+1].Text != ":" {
			return nil
		}
		key := ts[i]
		start := i + 2
		i = start
		for i < len(ts)-1 && ts[i].Text != "," {
			if ts[i].Text == "(" || ts[i].Text == "[" || ts[i].Text == "{" {
				end := balancedEnd(ts, i, len(ts))
				if end < 0 {
					return nil
				}
				i = end
			}
			i++
		}
		if start == i {
			return nil
		}
		entries = append(entries, literalMapEntry{Key: key, Value: ts[start:i]})
		if i < len(ts)-1 {
			i++
		}
	}
	return entries
}
func literalDockerPolicies(s *Source, tokens []Token) []dockerPolicy {
	var result []dockerPolicy
	for _, entry := range literalMapEntries(tokens) {
		suffix, ok := jinjaStringLiteral([]Token{entry.Key})
		if !ok || !strings.HasPrefix(suffix, "_docker_") {
			continue
		}
		for _, policy := range literalMapEntries(entry.Value) {
			kind, ok := jinjaStringLiteral([]Token{policy.Key})
			if !ok || !slices.Contains([]string{"default", "omit", "required"}, kind) {
				continue
			}
			truth := len(policy.Value) == 1 && policy.Value[0].Kind == "name" && (policy.Value[0].Text == "true" || policy.Value[0].Text == "True")
			result = append(result, newDockerPolicy(s, suffix, kind, entry.Key.Span, truth))
		}
	}
	return result
}
