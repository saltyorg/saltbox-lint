package lint

import (
	"path"
	"slices"
	"strings"
)

// One suffix contract feeds declaration, adapter and renderer policy. The
// middleware pair is consumed through the shared resolved middleware variable.
var traefikAPISuffixes = []string{
	"traefik_middleware_default_api", "traefik_middleware_custom_api",
	"traefik_api_enabled", "traefik_api_endpoint",
}

func traefikAdapterSuffixes() []string {
	return append([]string{"traefik_sso_middleware", "traefik_middleware_default", "traefik_middleware_custom", "traefik_certresolver", "traefik_enabled"}, traefikAPISuffixes...)
}
func checkTraefikAPIContract(_ *Project, s *Source) []Diagnostic {
	if s.Role == "" {
		return nil
	}
	declarations := declarationsByName(s)
	prefix := s.Role + "_role_"
	var ds []Diagnostic
	if enabled, ok := declarations[prefix+"traefik_enabled"]; ok {
		var missing []string
		for _, suffix := range traefikAPISuffixes {
			if _, ok := declarations[prefix+suffix]; !ok {
				missing = append(missing, prefix+suffix)
			}
		}
		if len(missing) > 0 {
			ds = append(ds, ansibleDiagnostic(s, "traefik-api-contract", enabled.Key.Span, "Traefik declaration is missing API defaults", "Declare "+strings.Join(missing, ", ")+"."))
		} else {
			first, last := declarations[prefix+traefikAPISuffixes[0]], declarations[prefix+traefikAPISuffixes[1]]
			if first.Key.Span.Start > last.Key.Span.Start {
				d := ansibleDiagnostic(s, "traefik-api-contract", last.Key.Span, "custom API middleware precedes its default layer", "Declare "+first.Name+" before "+last.Name+".")
				d.Related = []RelatedLocation{{Path: s.Path, Span: first.Key.Span, Message: "default API middleware declaration"}}
				ds = append(ds, d)
			}
		}
	}
	for _, suffix := range []string{"traefik_api_middleware", "traefik_middleware_api"} {
		if legacy, ok := declarations[prefix+suffix]; ok {
			ds = append(ds, ansibleDiagnostic(s, "traefik-api-contract", legacy.Key.Span, "legacy API middleware declaration is unsupported", "Use "+prefix+traefikAPISuffixes[0]+" and "+prefix+traefikAPISuffixes[1]+"."))
		}
	}
	return append(ds, checkTraefikEndpointDefaults(s)...)
}

func traefikRoleSources(p *Project, s *Source, kinds ...Kind) []*Source {
	var sources []*Source
	if s.RolePath == "" {
		return sources
	}
	for _, name := range sortedKeys(p.Sources) {
		other := p.Sources[name]
		if other != nil && other.RolePath == s.RolePath && slices.Contains(kinds, other.Kind) {
			sources = append(sources, other)
		}
	}
	return sources
}
func invalidTraefikContext(sources []*Source) []RelatedLocation {
	var related []RelatedLocation
	for _, s := range sources {
		if len(s.parseDiagnostics) > 0 {
			related = append(related, RelatedLocation{Path: s.Path, Span: s.parseDiagnostics[0].Span, Message: "required role context has invalid YAML"})
		}
	}
	return related
}
func traefikContextDiagnostic(s *Source, id string, span Span, related []RelatedLocation) Diagnostic {
	d := ansibleDiagnostic(s, id, span, "cannot validate Traefik contract because required role context is invalid", "Repair the related source context, then validate this contract again.")
	d.Related = related
	return d
}

type traefikAdapter struct {
	Name string
	Key  *Node
	Task Task
}

func traefikAdapters(s *Source) []traefikAdapter {
	return traefikAdaptersWithExpressions(s, newDeclarationExpressionQuery(s))
}

func traefikAdaptersWithExpressions(s *Source, expressions *declarationExpressionQuery) []traefikAdapter {
	var adapters []traefikAdapter
	for _, task := range TasksIn(s) {
		if task.Module != "include_role" {
			continue
		}
		name := task.argument("name")
		if name == nil || !defaultVariableName.MatchString(name.Value) || task.Vars == nil {
			continue
		}
		for _, entry := range task.Vars.Entries {
			if entry.Key.Value == name.Value+"_role_web_subdomain" && traefikForwardedValue(s, entry.Value, "_"+name.Value+"_web_subdomain", expressions) {
				adapters = append(adapters, traefikAdapter{Name: name.Value, Key: entry.Key, Task: task})
			}
		}
	}
	return adapters
}

// Forwarding requires the lookup result itself as the assigned scalar value.
// A call buried in a condition or payload does not pass the suffix to the role.
func traefikForwardedValue(s *Source, value *Node, suffix string, expressions *declarationExpressionQuery) bool {
	if value == nil || value.Kind != "string" {
		return false
	}
	matches := expressions.expressions(defaultDeclaration{Value: value})
	if len(matches) != 1 || strings.TrimSpace(value.Value) != strings.TrimSpace(matches[0].text) {
		return false
	}
	expression := matches[0]
	expression.Tokens = stripGrouping(expression.Tokens)
	call, ok := directLookup(expression, "role_var")
	if !ok {
		return false
	}
	target, targetOK := lookupNamedLiteral(call, "role")
	found, foundOK := lookupPositionalLiteral(call, 1)
	return targetOK && foundOK && target == s.Role && found == suffix
}

// The namespace owner wins; an absent namespace belongs to main defaults.
// Only a role with no defaults source falls back to its including task.
func traefikAdapterDefaults(defaults []*Source, anchor string) *Source {
	for _, s := range defaults {
		if _, ok := declarationsByName(s)[anchor]; ok {
			return s
		}
	}
	for _, s := range defaults {
		if s.Path == s.RolePath+"/defaults/main.yml" || s.Path == s.RolePath+"/defaults/main.yaml" {
			return s
		}
	}
	if len(defaults) > 0 {
		return defaults[0]
	}
	return nil
}

func checkTraefikAdapterContract(p *Project, s *Source) []Diagnostic {
	if s.Role == "" {
		return nil
	}
	defaults := traefikRoleSources(p, s, Defaults)
	tasks := traefikRoleSources(p, s, Tasks, Handlers)
	var ds []Diagnostic
	// Missing declarations belong to defaults; missing forwarding belongs to the
	// exact include. Each invocation returns only defects owned by its source.
	if s.Kind == Defaults {
		declarations := declarationsByName(s)
		if invalid := invalidTraefikContext(tasks); len(invalid) > 0 {
			for _, decl := range topLevelDeclarations(s) {
				if strings.HasPrefix(decl.Name, s.Role+"_role_") && strings.HasSuffix(decl.Name, "_web_subdomain") && decl.Name != s.Role+"_role_web_subdomain" {
					return []Diagnostic{traefikContextDiagnostic(s, "traefik-adapter-contract", decl.Key.Span, invalid)}
				}
			}
		}
		for _, taskSource := range tasks {
			expressions := newDeclarationExpressionQuery(taskSource)
			for _, adapter := range traefikAdaptersWithExpressions(taskSource, expressions) {
				prefix := s.Role + "_role_" + adapter.Name + "_"
				// Only the defaults source owning this adapter's namespace owns its defect.
				if traefikAdapterDefaults(defaults, prefix+"web_subdomain") != s {
					continue
				}
				anchor, ok := declarations[prefix+"web_subdomain"]
				span := Span{}
				if ok {
					span = anchor.Key.Span
				} else if declarations := topLevelDeclarations(s); len(declarations) > 0 {
					span = declarations[0].Key.Span
				}
				var missing []string
				if !ok {
					missing = append(missing, prefix+"web_subdomain")
				}
				for _, suffix := range traefikAdapterSuffixes() {
					if _, ok := declarations[prefix+suffix]; !ok {
						missing = append(missing, prefix+suffix)
					}
				}
				if len(missing) > 0 {
					d := ansibleDiagnostic(s, "traefik-adapter-contract", span, "namespaced web adapter "+adapter.Name+" is missing defaults", "Declare "+strings.Join(missing, ", ")+".")
					d.Related = []RelatedLocation{{Path: taskSource.Path, Span: adapter.Key.Span, Message: "include forwards this namespaced adapter"}}
					ds = append(ds, d)
				}
			}
		}
		return ds
	}
	expressions := newDeclarationExpressionQuery(s)
	for _, adapter := range traefikAdaptersWithExpressions(s, expressions) {
		if invalid := invalidTraefikContext(defaults); len(invalid) > 0 {
			ds = append(ds, traefikContextDiagnostic(s, "traefik-adapter-contract", adapter.Key.Span, invalid))
			continue
		}
		var related []RelatedLocation
		for _, def := range defaults {
			if anchor, ok := declarationsByName(def)[s.Role+"_role_"+adapter.Name+"_web_subdomain"]; ok {
				related = append(related, RelatedLocation{Path: def.Path, Span: anchor.Key.Span, Message: "namespaced adapter defaults"})
			}
		}
		if len(defaults) == 0 {
			d := ansibleDiagnostic(s, "traefik-adapter-contract", adapter.Key.Span, "namespaced web adapter has no defaults declaration", "Declare "+s.Role+"_role_"+adapter.Name+"_web_subdomain and the namespaced Traefik contract in role defaults.")
			ds = append(ds, d)
		}
		var missing []string
		for _, suffix := range traefikAdapterSuffixes() {
			target := adapter.Name + "_role_" + suffix
			value := adapter.Task.Vars.Get(target)
			if !traefikForwardedValue(s, value, "_"+adapter.Name+"_"+suffix, expressions) {
				missing = append(missing, target)
			}
		}
		if len(missing) > 0 {
			d := ansibleDiagnostic(s, "traefik-adapter-contract", adapter.Key.Span, "namespaced web adapter "+adapter.Name+" is missing forwarding in this include", "Forward "+strings.Join(missing, ", ")+" with matching lookup('role_var', '_"+adapter.Name+"_<suffix>', role='"+s.Role+"') values in this include's vars.")
			d.Related = related
			ds = append(ds, d)
		}
	}
	return ds
}

// A renderer is an actual output path: copy content, container labels, or a
// statically named template referenced by a template task. Unreferenced files,
// debug messages and unrelated task vars cannot prove that a contract renders.
type traefikRenderer struct {
	Source          *Source
	OutputSource    *Source
	Value           *Node
	Kind            string
	Span            Span
	Expressions     []Expression
	Conditions      []Expression
	Related         []RelatedLocation
	MissingTemplate string
}

func traefikRenderConditions(s *Source, task Task) []Expression {
	when := task.Node.Get("when")
	if when == nil {
		return nil
	}
	var expressions []Expression
	for _, e := range RuntimeExpressions(s) {
		if e.Span.Start >= when.Span.Start && e.Span.End <= when.Span.End {
			expressions = append(expressions, e)
		}
	}
	return expressions
}

func traefikRenderers(p *Project, tasks []*Source) []traefikRenderer {
	var renderers []traefikRenderer
	for _, s := range tasks {
		expressions := newDeclarationExpressionQuery(s)
		for _, task := range TasksIn(s) {
			conditions := traefikRenderConditions(s, task)
			var value *Node
			switch task.Module {
			case "copy":
				value = task.argument("content")
			case "community.docker.docker_container", "docker_container":
				value = task.argument("labels")
			case "template":
				src := task.argument("src")
				if src == nil {
					continue
				}
				target := path.Join(s.RolePath, "templates", src.Value)
				if template := p.Sources[target]; template != nil && template.Kind == Template {
					renderers = append(renderers, traefikRenderer{Source: s, OutputSource: template, Kind: task.Module, Span: src.Span, Conditions: conditions, Expressions: traefikOutputExpressions(template, scanExpressions(string(template.Data))), Related: []RelatedLocation{{Path: target, Span: Span{0, len(template.Data)}, Message: "template rendered by this task"}}})
				} else {
					renderers = append(renderers, traefikRenderer{Source: s, Span: src.Span, Conditions: conditions, MissingTemplate: src.Value})
				}
				continue
			}
			if value != nil {
				renderers = append(renderers, traefikRenderer{Source: s, OutputSource: s, Value: value, Kind: task.Module, Span: value.Span, Conditions: conditions, Expressions: traefikOutputExpressions(s, expressions.expressions(defaultDeclaration{Value: value}))})
			}
		}
	}
	return renderers
}

// Native template tags reuse the shared Jinja lexer. Hash comment lines in
// generated configuration are not output contract evidence. Retained tags keep
// their exact source spans; no template or lookup is executed.
func traefikOutputExpressions(s *Source, expressions []Expression) []Expression {
	var result []Expression
	for _, e := range expressions {
		start := strings.LastIndexByte(string(s.Data[:e.Span.Start]), '\n') + 1
		if strings.HasPrefix(strings.TrimSpace(string(s.Data[start:e.Span.Start])), "#") {
			continue
		}
		result = append(result, e)
	}
	return result
}

// Docker output evidence is deliberately bounded: either the label argument
// itself receives the shared mapping, or a labels mapping emits its sorted
// key/value pairs in the supported Compose loop. A read alone proves neither.
func traefikDockerLabelsOutput(renderer traefikRenderer) bool {
	expressions := traefikUncapturedExpressions(renderer.Expressions)
	if renderer.Kind == "community.docker.docker_container" || renderer.Kind == "docker_container" {
		if renderer.Value == nil || renderer.Value.Kind != "string" || len(expressions) != 1 || strings.TrimSpace(renderer.Value.Value) != strings.TrimSpace(expressions[0].text) {
			return false
		}
		return traefikOutputName(expressions[0], "docker_labels_common")
	}
	if renderer.OutputSource == nil {
		return false
	}
	for i, e := range expressions {
		ts := e.Tokens
		if e.Kind != "statement" || !e.Complete || len(ts) == 0 {
			continue
		}
		if len(ts) != 8 || ts[0].Text != "for" || ts[1].Kind != "name" || ts[2].Text != "," || ts[3].Kind != "name" || ts[1].Text == ts[3].Text || ts[4].Text != "in" || ts[5].Text != "docker_labels_common" || ts[6].Text != "|" || ts[7].Text != "dictsort" || i+3 >= len(expressions) {
			continue
		}
		key, value, end := expressions[i+1], expressions[i+2], expressions[i+3]
		if !traefikOutputName(key, ts[1].Text) || !traefikLabelValue(value, ts[3].Text) || !end.Complete || end.Kind != "statement" || len(end.Tokens) != 1 || end.Tokens[0].Text != "endfor" {
			continue
		}
		if traefikLabelsLoopLayout(renderer.OutputSource.Data, e, key, value, end) {
			return true
		}
	}
	return false
}
func traefikOutputName(expression Expression, name string) bool {
	tokens := stripGrouping(expression.Tokens)
	return expression.Complete && expression.Kind == "output" && len(tokens) == 1 && tokens[0].Kind == "name" && tokens[0].Text == name
}
func traefikLabelValue(expression Expression, name string) bool {
	tokens := expression.Tokens
	if !expression.Complete || expression.Kind != "output" || len(tokens) == 0 || tokens[0].Kind != "name" || tokens[0].Text != name {
		return false
	}
	for i := 1; i < len(tokens); i += 2 {
		if i+1 >= len(tokens) || tokens[i].Text != "|" || !slices.Contains([]string{"string", "to_json"}, tokens[i+1].Text) {
			return false
		}
	}
	return true
}
func traefikLabelsLoopLayout(data []byte, loop, key, value, end Expression) bool {
	before := string(data[:loop.Span.Start])
	lineStart := strings.LastIndexByte(before, '\n') + 1
	if strings.TrimSpace(before[lineStart:]) != "" {
		return false
	}
	prefix := strings.TrimRight(before[:lineStart], " \t\r\n")
	labelLine := prefix[strings.LastIndexByte(prefix, '\n')+1:]
	if strings.TrimSpace(labelLine) != "labels:" {
		return false
	}
	if strings.TrimSpace(string(data[loop.Span.End:key.Span.Start])) != "" || strings.TrimSpace(string(data[key.Span.End:value.Span.Start])) != ":" || strings.TrimSpace(string(data[value.Span.End:end.Span.Start])) != "" {
		return false
	}
	keyLineStart := strings.LastIndexByte(string(data[:key.Span.Start]), '\n') + 1
	keyIndent := string(data[keyLineStart:key.Span.Start])
	labelIndent := len(labelLine) - len(strings.TrimLeft(labelLine, " \t"))
	return strings.TrimSpace(keyIndent) == "" && len(keyIndent) > labelIndent
}

func traefikReads(expressions []Expression, name string) bool {
	for _, e := range expressions {
		for _, read := range VariableReads(e) {
			if read.Text == name {
				return true
			}
		}
	}
	return false
}

// Capture bodies cannot prove emitted output without resolving their later use.
// Share this boundary with Docker-label evidence and retain the original tokens.
func traefikUncapturedExpressions(expressions []Expression) []Expression {
	var result []Expression
	depth := 0
	for _, e := range expressions {
		if e.Kind == "statement" && e.Complete && len(e.Tokens) > 0 {
			switch e.Tokens[0].Text {
			case "macro", "call", "filter":
				depth++
			case "set":
				// A block set can have filter arguments containing equals signs.
				separator := slices.IndexFunc(e.Tokens, func(t Token) bool { return t.Text == "=" || t.Text == "|" })
				if separator < 0 || e.Tokens[separator].Text == "|" {
					depth++
				}
			case "endmacro", "endcall", "endfilter", "endset":
				if depth > 0 {
					depth--
				}
			}
		}
		if depth == 0 {
			result = append(result, e)
		}
	}
	return result
}

// Recognize the consumer's direct split/emit loop, with no intervening
// statements that could capture or rebind its item. Other data flow stays unknown.
func traefikMiddlewareLoopOutput(expressions []Expression) bool {
	for i, e := range expressions {
		ts := e.Tokens
		if !e.Complete || e.Kind != "statement" || len(ts) != 9 || ts[0].Text != "for" || ts[1].Kind != "name" || ts[2].Text != "in" || ts[3].Text != "traefik_middleware_api" || ts[4].Text != "." || ts[5].Text != "split" || ts[6].Text != "(" || ts[8].Text != ")" || i+2 >= len(expressions) {
			continue
		}
		separator, ok := jinjaStringLiteral(ts[7:8])
		if !ok || separator != "," {
			continue
		}
		output, end := expressions[i+1], expressions[i+2]
		if !end.Complete || end.Kind != "statement" || len(end.Tokens) != 1 || end.Tokens[0].Text != "endfor" {
			continue
		}
		// strip() followed by string/to_json preserves the emitted item.
		value := output.Tokens
		if len(value) >= 5 && value[1].Text == "." && value[2].Text == "strip" && value[3].Text == "(" && value[4].Text == ")" {
			output.Tokens = append(slices.Clone(value[:1]), value[5:]...)
		}
		if traefikLabelValue(output, ts[1].Text) {
			return true
		}
	}
	return false
}

func missingTraefikConsumption(renderer traefikRenderer, role string) []string {
	expressions := traefikUncapturedExpressions(renderer.Expressions)
	var outputs, guards, activeGuards []Expression
	for _, e := range expressions {
		if e.Kind == "output" {
			outputs = append(outputs, e)
			guards = append(guards, activeGuards...)
		} else if e.Kind == "statement" && len(e.Tokens) > 0 {
			switch e.Tokens[0].Text {
			case "if":
				activeGuards = append(activeGuards, e)
			case "elif":
				if len(activeGuards) > 0 {
					activeGuards[len(activeGuards)-1] = e
				}
			case "endif":
				if len(activeGuards) > 0 {
					activeGuards = activeGuards[:len(activeGuards)-1]
				}
			}
		}
	}
	var missing []string
	if !traefikReads(outputs, "traefik_middleware_api") && !traefikMiddlewareLoopOutput(expressions) {
		missing = append(missing, "traefik_middleware_api")
	}
	for _, suffix := range traefikAPISuffixes[2:] {
		expressions := outputs
		if suffix == traefikAPISuffixes[2] {
			expressions = append(slices.Clone(outputs), guards...)
			expressions = append(expressions, renderer.Conditions...)
		}
		if !traefikReads(expressions, role+"_role_"+suffix) && !hasExplicitRoleVarLookup(expressions, "_"+suffix, role) {
			missing = append(missing, "_"+suffix)
		}
	}
	return missing
}
func hasTraefikDockerHelper(tasks []*Source) bool {
	for _, s := range tasks {
		for _, task := range TasksIn(s) {
			file := task.includeFile()
			if strings.HasSuffix(file, "/docker/create_docker_container.yml") || file == "create_docker_container.yml" {
				return true
			}
		}
	}
	return false
}
func retiredTraefikRole(tasks []*Source) bool {
	for _, s := range tasks {
		if s.Path != s.RolePath+"/tasks/main.yml" && s.Path != s.RolePath+"/tasks/main.yaml" {
			continue
		}
		list := TasksIn(s)
		// The retained retirement path is a role entrypoint consisting of a fail
		// warning, optionally preceded by a guarded migration include.
		if len(list) == 0 || len(list) > 2 {
			continue
		}
		fail := list[len(list)-1]
		if fail.Module != "fail" || !traefikSimpleRetirementTask(fail) {
			continue
		}
		msg := fail.argument("msg")
		if msg == nil || !strings.Contains(msg.Value, " is deprecated in favor of ") {
			continue
		}
		role := strings.ReplaceAll(s.Role, "_", "-")
		if !strings.Contains(msg.Value, "'"+s.Role+"' role") && !strings.Contains(msg.Value, "'"+role+"' role") {
			continue
		}
		when := fail.Node.Get("when")
		if when == nil {
			if len(list) == 1 {
				return true
			}
			continue
		}
		var condition []Token
		for _, e := range RuntimeExpressions(s) {
			if e.node == when {
				condition = stripGrouping(e.Tokens)
			}
		}
		if len(condition) == 2 && condition[0].Text == "not" && condition[1].Text == "continuous_integration" && len(list) == 1 {
			return true
		}
		if len(list) == 2 && retirementMigration(list[0], condition, s) {
			return true
		}
	}
	return false
}

// Retirement is a narrow source contract, not an execution evaluator. Only
// the action, its message arguments, descriptive name and supported when guard
// belong to it. Loops, failure overrides, tags and other execution modifiers
// cannot establish this exemption even when a particular value looks harmless.
func traefikSimpleRetirementTask(task Task) bool {
	for _, entry := range task.Node.Entries {
		switch entry.Key.Value {
		case "name", "when", "fail", "ansible.builtin.fail", "action", "local_action", "args":
		default:
			return false
		}
	}
	return true
}

func retirementMigration(task Task, condition []Token, s *Source) bool {
	if task.Module != "include_tasks" || path.Base(task.includeFile()) != "migration.yml" {
		return false
	}
	// Recognize the existing CI-and-migration-tag split structurally. Removing
	// arbitrary parentheses would change which expression the negation owns.
	tag, ok := traefikMigrationGuard(condition, true)
	if !ok {
		return false
	}
	for _, e := range RuntimeExpressions(s) {
		if e.node == task.Node.Get("when") {
			other, ok := traefikMigrationGuard(e.Tokens, false)
			return ok && other == tag
		}
	}
	return false
}
func traefikMigrationGuard(tokens []Token, excluded bool) (string, bool) {
	tokens = stripGrouping(tokens)
	for i := 0; i < len(tokens); i++ {
		if tokens[i].Text == "(" || tokens[i].Text == "[" || tokens[i].Text == "{" {
			end := balancedEnd(tokens, i, len(tokens))
			if end < 0 {
				return "", false
			}
			i = end
			continue
		}
		if tokens[i].Text != "and" {
			continue
		}
		left, right := stripGrouping(tokens[:i]), stripGrouping(tokens[i+1:])
		if len(left) != 2 || left[0].Text != "not" || left[1].Text != "continuous_integration" {
			return "", false
		}
		if excluded {
			if len(right) != 4 || right[1].Text != "not" {
				return "", false
			}
			right = append([]Token{right[0]}, right[2:]...)
		}
		if len(right) != 3 || right[1].Text != "in" || right[2].Text != "ansible_run_tags" {
			return "", false
		}
		return jinjaStringLiteral(right[:1])
	}
	return "", false
}

func invalidTraefikRenderer(renderer traefikRenderer) []RelatedLocation {
	for _, expression := range renderer.Expressions {
		if !expression.Complete {
			sourcePath := renderer.Source.Path
			if len(renderer.Related) > 0 {
				sourcePath = renderer.Related[0].Path
			}
			return []RelatedLocation{{Path: sourcePath, Span: expression.Span, Message: "renderer contains an incomplete Jinja expression"}}
		}
	}
	return nil
}

func checkTraefikRendererContract(p *Project, s *Source) []Diagnostic {
	if s.Role == "" {
		return nil
	}
	defaults := traefikRoleSources(p, s, Defaults)
	var anchor *Source
	var declaration defaultDeclaration
	for _, def := range defaults {
		if enabled, ok := declarationsByName(def)[s.Role+"_role_traefik_enabled"]; ok {
			anchor = def
			declaration = enabled
			break
		}
	}
	invalidDefaults := invalidTraefikContext(defaults)
	if anchor == nil && len(invalidDefaults) == 0 {
		return nil
	}
	tasks := traefikRoleSources(p, s, Tasks, Handlers)
	renderers := traefikRenderers(p, tasks)
	if len(invalidDefaults) > 0 && s.Kind != Defaults {
		for _, r := range renderers {
			if r.Source == s {
				return []Diagnostic{traefikContextDiagnostic(s, "traefik-renderer-contract", r.Span, invalidDefaults)}
			}
		}
	}
	if anchor == nil {
		return nil
	}
	if hasTraefikDockerHelper(tasks) || retiredTraefikRole(tasks) {
		return nil
	}
	for _, r := range renderers {
		if len(invalidTraefikRenderer(r)) == 0 && (traefikDockerLabelsOutput(r) || len(missingTraefikConsumption(r, s.Role)) == 0) {
			return nil
		}
	}
	if invalid := invalidTraefikContext(tasks); len(invalid) > 0 {
		if s == anchor {
			return []Diagnostic{traefikContextDiagnostic(s, "traefik-renderer-contract", declaration.Key.Span, invalid)}
		}
		for _, r := range renderers {
			if r.Source == s {
				return []Diagnostic{traefikContextDiagnostic(s, "traefik-renderer-contract", r.Span, invalid)}
			}
		}
		return nil
	}
	if len(renderers) == 0 {
		if s != anchor {
			return nil
		}
		return []Diagnostic{ansibleDiagnostic(s, "traefik-renderer-contract", declaration.Key.Span, "Traefik role has no supported renderer consuming the API contract", "Render traefik_middleware_api, _traefik_api_enabled and _traefik_api_endpoint in copy content or a referenced template, or use the shared Docker renderer.")}
	}
	// With no complete renderer, the first output is the actionable ownership
	// point. Separate outputs never become concatenated contract evidence.
	renderer := renderers[0]
	if renderer.Source != s {
		return nil
	}
	if invalid := invalidTraefikRenderer(renderer); len(invalid) > 0 {
		return []Diagnostic{traefikContextDiagnostic(s, "traefik-renderer-contract", renderer.Span, invalid)}
	}
	d := ansibleDiagnostic(s, "traefik-renderer-contract", renderer.Span, "Traefik renderer is missing API contract consumption", "Render "+strings.Join(missingTraefikConsumption(renderer, s.Role), ", ")+" using live owner-targeted reads in the output; API enablement may guard this rendering task with when.")
	if renderer.MissingTemplate != "" {
		d.Message = "cannot validate Traefik renderer because its template context is unavailable"
		d.Expected = "Provide the statically named role template " + renderer.MissingTemplate + " and render the API contract there."
	}
	d.Related = append(slices.Clone(renderer.Related), RelatedLocation{Path: anchor.Path, Span: declaration.Key.Span, Message: "role declares Traefik support"})
	return []Diagnostic{d}
}
