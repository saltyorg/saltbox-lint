package lint

import (
	"cmp"
	"context"
	"fmt"
	"path"
	"regexp"
	"slices"
	"strings"
)

// ReferenceReport is declaration inspection, not an evaluated Ansible value.
// Its schema is independent of check's diagnostics protocol.
type ReferenceReport struct {
	SchemaVersion int              `json:"schema_version"`
	Contract      string           `json:"contract"`
	Root          string           `json:"root"`
	Sources       []ObservedSource `json:"sources"`
	LoadedContext []ObservedSource `json:"loaded_context"`
	References    []RoleReference  `json:"references"`
	Dependencies  *AnalysisRecord  `json:"dependencies"`
}

// ReferenceLocation uses original half-open UTF-8 byte offsets and one-based
// Unicode code point coordinates. Text is the exact source representation.
type ReferenceLocation struct {
	Path   string       `json:"path"`
	Span   DecisionSpan `json:"span"`
	Line   int          `json:"line"`
	Column int          `json:"column"`
	Text   string       `json:"text"`
}

type RoleDeclaration struct {
	Name       string              `json:"name"`
	Role       string              `json:"role"`
	RolePath   string              `json:"role_path"`
	Provenance string              `json:"provenance"`
	Key        ReferenceLocation   `json:"key"`
	Value      ReferenceLocation   `json:"value"`
	Comments   []ReferenceLocation `json:"comments"`
}

type ReferenceCandidate struct {
	Suffix      string          `json:"suffix"`
	LookupName  string          `json:"lookup_name"`
	LookupLayer string          `json:"lookup_layer"`
	Declaration RoleDeclaration `json:"declaration"`
}

type RoleReference struct {
	arguments          []queryArgument
	Location           ReferenceLocation    `json:"location"`
	OwningRole         string               `json:"owning_role"`
	OwningRolePath     string               `json:"owning_role_path"`
	LookupKind         string               `json:"lookup_kind"`
	Target             string               `json:"target"`
	TargetKind         string               `json:"target_kind"`
	Suffixes           []string             `json:"suffixes"`
	State              string               `json:"state"`
	Reasons            []string             `json:"reasons"`
	Candidates         []ReferenceCandidate `json:"candidates"`
	AliasDeclarations  []RoleDeclaration    `json:"alias_declarations"`
	SpellingCandidates []RoleDeclaration    `json:"spelling_candidates"`
	DefaultSupplied    bool                 `json:"default_supplied"`
}

type indexedRoleDeclaration struct {
	declaration RoleDeclaration
	value       *Node
	scope       Span
}

type roleSymbolIndex struct {
	declarations []indexedRoleDeclaration
}

// References owns its index and observations for one invocation. Only selected
// primary YAML sources emit reads. Context templates stay raw and unselected.
func References(ctx context.Context, opts Options) (ReferenceReport, error) {
	result := ReferenceReport{SchemaVersion: 1, Contract: "saltbox-role-lookups-v1", Sources: []ObservedSource{}, LoadedContext: []ObservedSource{}, References: []RoleReference{}}
	if opts.ChangedSince != "" {
		return result, fmt.Errorf("references does not support changed-since selection")
	}
	opts.IncludeAnalysis, opts.referenceContext = true, true
	p, err := Load(ctx, opts)
	if err != nil {
		return result, err
	}
	result.Root, result.Dependencies = p.Root, p.Dependencies
	index := newRoleSymbolIndex(p)
	for _, name := range sortedKeys(p.Sources) {
		if !p.Selected[name] {
			result.LoadedContext = append(result.LoadedContext, observedSource(p.Sources[name]))
		}
	}
	for _, name := range sortedKeys(p.Selected) {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		source := p.Sources[name]
		result.Sources = append(result.Sources, observedSource(source))
		for _, read := range sourceRoleReferences(source) {
			index.resolve(p, source, &read)
			slices.Sort(read.Reasons)
			read.Reasons = slices.Compact(read.Reasons)
			slices.SortFunc(read.SpellingCandidates, func(a, b RoleDeclaration) int {
				return cmp.Or(strings.Compare(a.Key.Path, b.Key.Path), cmp.Compare(a.Key.Span.Start, b.Key.Span.Start))
			})
			read.SpellingCandidates = slices.CompactFunc(read.SpellingCandidates, func(a, b RoleDeclaration) bool {
				return a.Key.Path == b.Key.Path && a.Key.Span == b.Key.Span
			})
			result.References = append(result.References, read)
		}
	}
	return result, ctx.Err()
}

func referenceLocation(source *Source, span Span) ReferenceLocation {
	position := source.Position(span.Start)
	text := ""
	if span.Start >= 0 && span.End >= span.Start && span.End <= len(source.Data) {
		text = string(source.Data[span.Start:span.End])
	}
	return ReferenceLocation{Path: source.Path, Span: DecisionSpan(span), Line: position.Line, Column: position.Column, Text: text}
}

var literalRoleName = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]*$`)
var literalEndpoint = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

func referenceRolePaths(source *Source, target string) []string {
	if !literalRoleName.MatchString(target) {
		return nil
	}
	dirs := []string{path.Join("roles", target), path.Join("resources/roles", target)}
	if source.RolePath != "" {
		dirs = append(dirs, path.Join(path.Dir(source.RolePath), target))
	}
	slices.Sort(dirs)
	return slices.Compact(dirs)
}

func referenceContextDirectories(p *Project) map[string][]string {
	result := map[string][]string{}
	for name := range p.Selected {
		source := p.Sources[name]
		dirs := map[string]bool{"group_vars": true, "host_vars": true, "inventory": true, "inventories": true}
		roles := map[string]bool{}
		if source.RolePath != "" {
			roles[source.RolePath] = true
		}
		for _, read := range sourceRoleReferences(source) {
			for _, role := range referenceRolePaths(source, read.Target) {
				roles[role] = true
			}
		}
		for role := range roles {
			for _, kind := range []string{"defaults", "vars", "tasks", "handlers", "templates"} {
				dirs[path.Join(role, kind)] = true
			}
		}
		result[name] = sortedKeys(dirs)
	}
	return result
}

// Calls in a scalar that binds lookup/query/q remain uncertain. This deliberately
// declines scope/branch evaluation, including calls before a later binding.
func sourceRoleReferences(source *Source) []RoleReference {
	expressions := RuntimeExpressions(source)
	query := newDeclarationExpressionQuery(source)
	// Reuse Ansible argument decoding for action scalars, instead of treating
	// escaped quotes in those payloads as literal Jinja escapes.
	for _, task := range TasksIn(source) {
		if task.projectedArguments == nil {
			continue
		}
		origin := map[*Node]bool{}
		for _, node := range task.projectedArguments {
			if node.scalarOrigin != nil {
				origin[node.scalarOrigin] = true
			}
		}
		expressions = slices.DeleteFunc(expressions, func(e Expression) bool {
			if !origin[e.node] {
				return false
			}
			for _, node := range task.projectedArguments {
				if node.scalarOrigin == e.node && e.Span.Start >= node.Span.Start && e.Span.End <= node.Span.End {
					return true
				}
			}
			return false
		})
		for _, key := range sortedKeys(task.projectedArguments) {
			// The shared query admits only source-owned safe scalars, including
			// projected origins and every unsafe ancestor.
			expressions = append(expressions, query.expressions(defaultDeclaration{Value: task.projectedArguments[key]})...)
		}
	}
	// All reads pass the same source-owned scalar admission before bindings or
	// calls are considered. RuntimeExpressions also supplies implicit conditions,
	// whose leaf can be safe while a task, block or document ancestor is unsafe.
	// Projected arguments inherit membership from their original YAML scalar.
	expressions = slices.DeleteFunc(expressions, func(e Expression) bool {
		if e.node == nil || e.node.Tag == "!unsafe" {
			return true
		}
		origin := e.node
		if origin.scalarOrigin != nil {
			origin = origin.scalarOrigin
		}
		return len(query.index.scalarOrders[origin]) == 0
	})
	bound := map[*Node]map[string]bool{}
	for _, e := range expressions {
		for i := range referenceBindings(e) {
			if i >= len(e.Tokens) {
				continue
			}
			name := e.Tokens[i].Text
			if name == "lookup" || name == "query" || name == "q" {
				if bound[e.node] == nil {
					bound[e.node] = map[string]bool{}
				}
				bound[e.node][name] = true
			}
		}
	}
	var result []RoleReference
	for _, e := range expressions {
		for _, callee := range []string{"lookup", "query", "q"} {
			for _, call := range Calls(e, callee) {
				plugin, ok := lookupPlugin(call)
				if !ok || (plugin != "role_var" && plugin != "role_web" && !strings.HasSuffix(plugin, ".role_var") && !strings.HasSuffix(plugin, ".role_web")) {
					continue
				}
				read := RoleReference{Location: referenceLocation(source, call.Span), OwningRole: source.Role, OwningRolePath: source.RolePath, LookupKind: plugin, TargetKind: "explicit", Suffixes: []string{}, State: "unavailable", Reasons: []string{}, Candidates: []ReferenceCandidate{}, AliasDeclarations: []RoleDeclaration{}, SpellingCandidates: []RoleDeclaration{}, DefaultSupplied: hasNamedArgument(call, "default")}
				read.arguments = queryArguments(source, call, plugin)
				if bound[e.node][callee] {
					read.State = "dynamic"
					read.Reasons = append(read.Reasons, "local-callee-binding")
				}
				if !closedLookupArguments(call, plugin) {
					read.State = "dynamic"
					read.Reasons = append(read.Reasons, "unsupported-call-arguments")
				}
				if plugin != "role_var" && plugin != "role_web" {
					read.Reasons = append(read.Reasons, "external-plugin-contract")
				}
				role, roleOK := lookupNamedLiteral(call, "role")
				if !hasNamedArgument(call, "role") {
					read.TargetKind = "implicit"
					if plugin == "role_var" {
						role, roleOK = source.Role, source.Role != ""
						read.Reasons = append(read.Reasons, "runtime-role-name")
					} else {
						read.Reasons = append(read.Reasons, "required-target-unavailable")
					}
				}
				if roleOK && !strings.ContainsAny(role, "{}") {
					read.Target = role
				} else {
					read.State = "dynamic"
					read.Reasons = append(read.Reasons, "dynamic-target")
				}
				switch plugin {
				case "role_var":
					suffix, ok := lookupPositionalLiteral(call, 1)
					if ok && !strings.ContainsAny(suffix, "{}") {
						read.Suffixes = append(read.Suffixes, suffix)
					} else {
						read.State = "dynamic"
						read.Reasons = append(read.Reasons, "dynamic-suffix")
					}
				case "role_web":
					endpoint, ok := "web", true
					if hasNamedArgument(call, "endpoint") {
						endpoint, ok = lookupNamedLiteral(call, "endpoint")
					}
					if ok && literalEndpoint.MatchString(endpoint) {
						read.Suffixes = append(read.Suffixes, "_"+endpoint+"_subdomain", "_"+endpoint+"_domain")
					} else {
						read.State = "dynamic"
						read.Reasons = append(read.Reasons, "dynamic-or-invalid-endpoint")
					}
				}
				result = append(result, read)
			}
		}
	}
	slices.SortFunc(result, func(a, b RoleReference) int {
		return cmp.Or(cmp.Compare(a.Location.Span.Start, b.Location.Span.Start), cmp.Compare(a.Location.Span.End, b.Location.Span.End), strings.Compare(a.LookupKind, b.LookupKind))
	})
	return slices.CompactFunc(result, func(a, b RoleReference) bool {
		return a.Location.Span == b.Location.Span && a.LookupKind == b.LookupKind
	})
}

func newRoleSymbolIndex(p *Project) roleSymbolIndex {
	index := roleSymbolIndex{}
	for _, name := range sortedKeys(p.Sources) {
		source := p.Sources[name]
		if len(source.parseDiagnostics) > 0 || source.Kind == Template {
			continue
		}
		add := func(entries []Entry, provenance string, scope Span) {
			for _, entry := range entries {
				if entry.Key == nil || entry.Value == nil || entry.Key.Kind != "string" || entry.Key.Tag == "!unsafe" {
					continue
				}
				declaration := RoleDeclaration{Name: entry.Key.Value, Role: source.Role, RolePath: source.RolePath, Provenance: provenance, Key: referenceLocation(source, entry.Key.Span), Value: referenceLocation(source, entry.Value.Span), Comments: []ReferenceLocation{}}
				// Contiguous preceding comments and inline comments document this key.
				keyLine := source.Position(entry.Key.Span.Start).Line
				preceding := keyLine - 1
				for i := len(source.yamlComments) - 1; i >= 0; i-- {
					comment := source.yamlComments[i]
					line := source.Position(comment.Start).Line
					if line == keyLine && comment.Start >= entry.Key.Span.End {
						declaration.Comments = append(declaration.Comments, referenceLocation(source, comment))
						continue
					}
					if line == preceding {
						declaration.Comments = append(declaration.Comments, referenceLocation(source, comment))
						preceding--
					}
				}
				slices.SortFunc(declaration.Comments, func(a, b ReferenceLocation) int { return cmp.Compare(a.Span.Start, b.Span.Start) })
				index.declarations = append(index.declarations, indexedRoleDeclaration{declaration: declaration, value: entry.Value, scope: scope})
			}
		}
		if source.Kind == Defaults || source.Kind == Vars || source.Kind == Inventory {
			for _, doc := range source.Documents {
				if doc.Kind == "mapping" {
					if source.Path == "inventory.yml" || source.Path == "inventory.yaml" {
						inventoryDeclarations(doc, func(entries []Entry) { add(entries, "inventory", Span{}) })
					} else {
						add(doc.Entries, string(source.Kind), Span{})
					}
				}
			}
		}
		for _, task := range TasksIn(source) {
			if task.Vars != nil && task.Vars.Kind == "mapping" {
				add(task.Vars.Entries, "task-vars", task.Node.Span)
			}
			if task.Module == "set_fact" {
				var entries []Entry
				for _, entry := range task.mappingArgumentEntries() {
					if entry.Key.Value != "cacheable" {
						entries = append(entries, entry)
					}
				}
				add(entries, "set-fact", Span{})
			}
		}
	}
	return index
}

func (index roleSymbolIndex) resolve(p *Project, source *Source, read *RoleReference) {
	read.Reasons = append(read.Reasons, "runtime-precedence-and-providers-unmodeled")
	if read.State == "dynamic" || slices.Contains(read.Reasons, "external-plugin-contract") {
		return
	}
	paths := referenceRolePaths(source, read.Target)
	if len(paths) == 0 {
		read.Reasons = append(read.Reasons, "external-or-unavailable-target")
		return
	}
	eligible := func(d indexedRoleDeclaration) bool {
		if d.scope != (Span{}) {
			return d.declaration.Key.Path == source.Path && read.Location.Span.Start >= d.scope.Start && read.Location.Span.End <= d.scope.End
		}
		return d.declaration.Key.Path == source.Path || slices.Contains(paths, d.declaration.RolePath) || (source.RolePath != "" && d.declaration.RolePath == source.RolePath) || d.declaration.Provenance == "inventory" || (d.declaration.RolePath == "" && d.declaration.Provenance == "vars")
	}
	aliases := []string{}
	if read.TargetKind == "explicit" {
		aliases = append(aliases, read.Target)
	}
	aliasName := read.Target + "_name"
	if read.TargetKind == "implicit" {
		aliasName = "traefik_role_var"
	}
	for _, d := range index.declarations {
		if eligible(d) && d.declaration.Name == aliasName {
			read.AliasDeclarations = append(read.AliasDeclarations, d.declaration)
			if d.value.Kind == "string" && !strings.ContainsAny(d.value.Value, "{}") && d.value.Value != "" {
				aliases = append(aliases, d.value.Value)
			} else {
				read.Reasons = append(read.Reasons, "dynamic-alias-declaration")
			}
		}
	}
	slices.Sort(aliases)
	aliases = slices.Compact(aliases)
	read.Reasons = append(read.Reasons, "runtime-alias-unmodeled")
	incomplete, foundLocal := false, false
	for _, d := range p.Sources {
		if (d.Kind == Inventory || (d.Kind == Vars && d.RolePath == "") || (source.RolePath != "" && d.RolePath == source.RolePath && roleDeclarationContext(d))) && len(d.parseDiagnostics) > 0 {
			incomplete = true
		}
	}
	for _, role := range paths {
		for _, d := range p.Sources {
			if d.RolePath == role && (roleDeclarationContext(d) || d.Kind == Template) {
				foundLocal = true
			}
			if d.RolePath == role && roleDeclarationContext(d) && len(d.parseDiagnostics) > 0 {
				incomplete = true
			}
		}
	}
	counts := map[string]int{}
	for _, suffix := range read.Suffixes {
		names := map[string]string{}
		fallback := read.Target + "_role" + suffix
		if suffix == "_name" {
			fallback = read.Target + suffix
		}
		names[fallback] = "fallback"
		for _, alias := range aliases {
			if _, exists := names[alias+suffix]; !exists {
				names[alias+suffix] = "possible-primary"
			}
		}
		for _, name := range sortedKeys(names) {
			layer := names[name]
			if strings.Contains(name, "-") {
				normalized := strings.ReplaceAll(name, "-", "_")
				if _, exists := names[normalized]; !exists {
					names[normalized] = layer + "-underscore"
				}
			}
		}
		for _, d := range index.declarations {
			if !eligible(d) {
				continue
			}
			if layer, ok := names[d.declaration.Name]; ok {
				read.Candidates = append(read.Candidates, ReferenceCandidate{Suffix: suffix, LookupName: d.declaration.Name, LookupLayer: layer, Declaration: d.declaration})
				counts[suffix]++
				if d.value.Kind == "null" {
					read.Reasons = append(read.Reasons, "literal-null-declaration-skipped-at-runtime")
				}
				if d.declaration.Provenance == "set-fact" {
					read.Reasons = append(read.Reasons, "set-fact-execution-unmodeled")
				}
				if d.declaration.Provenance == "inventory" {
					read.Reasons = append(read.Reasons, "inventory-scope-unmodeled")
				}
			} else if nearReferenceName(d.declaration.Name, fallback) {
				read.SpellingCandidates = append(read.SpellingCandidates, d.declaration)
			}
		}
	}
	if incomplete {
		read.Reasons = append(read.Reasons, "invalid-target-context")
		return
	}
	if !foundLocal {
		read.Reasons = append(read.Reasons, "local-target-context-unavailable-external-runtime-sources-possible")
		return
	}
	if len(read.Suffixes) == 0 {
		return
	}
	read.State = "resolved"
	for _, suffix := range read.Suffixes {
		if counts[suffix] == 0 {
			read.State = "unavailable"
			read.Reasons = append(read.Reasons, "no-indexed-declaration-runtime-sources-possible")
			break
		}
		if counts[suffix] > 1 {
			read.State = "ambiguous"
		}
	}
	if read.State == "unavailable" {
		read.Reasons = append(read.Reasons, "local-declaration-search-does-not-prove-runtime-absence")
	}
}

// Spelling suggestions carry no resolution evidence. Bound the comparison to
// nearby keys and never promote a suggestion to a candidate or diagnostic.
func nearReferenceName(name, expected string) bool {
	if name == expected || len(name) > 256 || len(expected) > 256 || len(name) > len(expected)+2 || len(expected) > len(name)+2 {
		return false
	}
	previous := make([]int, len(expected)+1)
	for i := range previous {
		previous[i] = i
	}
	for i := 0; i < len(name); i++ {
		row := make([]int, len(expected)+1)
		row[0] = i + 1
		for j := 0; j < len(expected); j++ {
			cost := 0
			if name[i] != expected[j] {
				cost = 1
			}
			row[j+1] = min(row[j]+1, previous[j+1]+1, previous[j]+cost)
		}
		previous = row
	}
	return previous[len(expected)] <= 2
}

// Unpacking, duplicate keywords and unsupported positional shapes cannot
// establish which target/suffix the actual call will receive.
func closedLookupArguments(call Call, plugin string) bool {
	named := map[string]bool{}
	positional := 0
	for _, argument := range call.Arguments {
		if argument.Name != "" {
			if named[argument.Name] {
				return false
			}
			named[argument.Name] = true
		} else {
			positional++
			if len(argument.Tokens) > 0 && (argument.Tokens[0].Text == "*" || argument.Tokens[0].Text == "**") {
				return false
			}
		}
	}
	if plugin == "role_var" {
		return positional == 2
	}
	if plugin == "role_web" {
		return positional == 1
	}
	return true
}

// Root YAML inventory follows explicit group vars, children and host mappings.
// Group names and host names are identities, not variable declarations.
func inventoryDeclarations(node *Node, add func([]Entry)) {
	if node == nil || node.Kind != "mapping" {
		return
	}
	for _, entry := range node.Entries {
		group := entry.Value
		if group == nil || group.Kind != "mapping" {
			continue
		}
		if vars := group.Get("vars"); vars != nil && vars.Kind == "mapping" {
			add(vars.Entries)
		}
		inventoryDeclarations(group.Get("children"), add)
		if hosts := group.Get("hosts"); hosts != nil && hosts.Kind == "mapping" {
			for _, host := range hosts.Entries {
				if host.Value != nil && host.Value.Kind == "mapping" {
					add(host.Value.Entries)
				}
			}
		}
	}
}

func referenceBindings(expression Expression) map[int]bool {
	bindings := statementBindings(expression)
	tokens := expression.Tokens
	if expression.Kind != "statement" || len(tokens) == 0 {
		return bindings
	}
	if tokens[0].Text == "with" {
		// With targets may be tuples. Each top-level equals sign begins a
		// value, and the next top-level comma begins another assignment.
		// Nested value calls/collections never introduce local bindings.
		markAssignmentBindings(tokens, 1, len(tokens), bindings)
	}
	if tokens[0].Text == "from" {
		// Read exclusion marks both source names and aliases. Only the alias
		// is locally bound when renamed; an unrenamed import binds its name.
		for i := 1; i < len(tokens); i++ {
			if tokens[i].Kind != "name" || tokens[i].Text != "import" {
				continue
			}
			for j := i + 1; j < len(tokens); j++ {
				delete(bindings, j)
			}
			for j := i + 1; j < len(tokens); j++ {
				if tokens[j].Text == "with" || tokens[j].Text == "without" {
					break
				}
				if tokens[j].Kind != "name" {
					continue
				}
				if j+2 < len(tokens) && tokens[j+1].Text == "as" {
					j += 2
				}
				bindings[j] = true
			}
			break
		}
	}
	if tokens[0].Text == "import" {
		for i := 1; i+1 < len(tokens); i++ {
			if tokens[i].Text == "as" {
				bindings[i+1] = true
			}
		}
	}
	// Read exclusions also include namespace assignment targets and filter
	// names. Neither introduces a local identifier binding. Keep the shared
	// target parsing, then admit only names that can bind the global callee.
	for i := range bindings {
		if i >= len(tokens) || tokens[i].Kind != "name" ||
			(i > 0 && tokens[i-1].Text == ".") ||
			(i+1 < len(tokens) && tokens[i+1].Text == ".") ||
			(tokens[0].Text == "filter" && i == 1) {
			delete(bindings, i)
		}
	}
	return bindings
}

func roleDeclarationContext(source *Source) bool {
	return slices.Contains([]Kind{Defaults, Vars, Tasks, Handlers}, source.Kind)
}
