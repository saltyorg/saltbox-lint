package lint

// analysis owns derived facts for one sequential Analyze evaluation. Sources and
// nodes remain caller-owned and mutable between invocations; nothing is attached
// to them. Direct Rule.Check calls have no analysis and derive current facts.
type analysis struct {
	roles     map[string][]*Source
	runtime   map[*Source][]Expression
	renderers map[traefikRoleIdentity]*traefikRoleFacts
	docker    *dockerPolicyFacts
}

type traefikRoleIdentity struct{ path, name string }

type traefikRoleFacts struct {
	anchor                        *Source
	declaration                   defaultDeclaration
	invalidDefaults, invalidTasks []RelatedLocation
	renderers                     []traefikRenderer
	complete                      bool
}

type dockerPolicyFacts struct {
	policies map[string][]dockerPolicy
	invalid  []RelatedLocation
}

func newAnalysis(p *Project, names []string) *analysis {
	a := &analysis{
		roles:     make(map[string][]*Source),
		runtime:   make(map[*Source][]Expression),
		renderers: make(map[traefikRoleIdentity]*traefikRoleFacts),
	}
	for _, name := range names {
		s := p.Sources[name]
		if s != nil && s.RolePath != "" {
			a.roles[s.RolePath] = append(a.roles[s.RolePath], s)
		}
	}
	return a
}

func analysisRuntimeExpressions(p *Project, s *Source) []Expression {
	if p.analysis == nil {
		return RuntimeExpressions(s)
	}
	if expressions, ok := p.analysis.runtime[s]; ok {
		return expressions
	}
	expressions := RuntimeExpressions(s)
	p.analysis.runtime[s] = expressions
	return expressions
}

func analyzeTraefikRole(p *Project, s *Source) *traefikRoleFacts {
	key := traefikRoleIdentity{s.RolePath, s.Role}
	if p.analysis != nil {
		if facts, ok := p.analysis.renderers[key]; ok {
			return facts
		}
	}
	facts := deriveTraefikRole(p, s)
	if p.analysis != nil {
		p.analysis.renderers[key] = facts
	}
	return facts
}

func deriveTraefikRole(p *Project, s *Source) *traefikRoleFacts {
	defaults := traefikRoleSources(p, s, Defaults)
	facts := &traefikRoleFacts{invalidDefaults: invalidTraefikContext(defaults)}
	for _, def := range defaults {
		if enabled, ok := declarationsByName(def)[s.Role+"_role_traefik_enabled"]; ok {
			facts.anchor = def
			facts.declaration = enabled
			break
		}
	}
	if facts.anchor == nil && len(facts.invalidDefaults) == 0 {
		return facts
	}
	tasks := traefikRoleSources(p, s, Tasks, Handlers)
	facts.renderers = traefikRenderers(p, tasks)
	facts.invalidTasks = invalidTraefikContext(tasks)
	if facts.anchor == nil {
		return facts
	}
	facts.complete = hasTraefikDockerHelper(tasks) || retiredTraefikRole(p, tasks)
	if !facts.complete {
		for _, r := range facts.renderers {
			if len(invalidTraefikRenderer(r)) == 0 && (traefikDockerLabelsOutput(r) || len(missingTraefikConsumption(r, s.Role)) == 0) {
				facts.complete = true
				break
			}
		}
	}
	return facts
}

func analyzeDockerPolicies(p *Project) *dockerPolicyFacts {
	if p.analysis != nil && p.analysis.docker != nil {
		return p.analysis.docker
	}
	facts := &dockerPolicyFacts{policies: make(map[string][]dockerPolicy)}
	for _, name := range sortedKeys(p.Sources) {
		source := p.Sources[name]
		if !dockerResource(source) {
			continue
		}
		if len(source.parseDiagnostics) > 0 {
			facts.invalid = append(facts.invalid, RelatedLocation{Path: name, Span: source.parseDiagnostics[0].Span, Message: "Docker policy context has invalid YAML"})
			continue
		}
		for _, policy := range dockerPolicies(source, analysisRuntimeExpressions(p, source)) {
			facts.policies[policy.Suffix] = append(facts.policies[policy.Suffix], policy)
		}
	}
	if p.analysis != nil {
		p.analysis.docker = facts
	}
	return facts
}
