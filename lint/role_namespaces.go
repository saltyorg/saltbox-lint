package lint

import (
	"fmt"
	"path"
	"strings"
)

// Candidate spellings authorize context reads, not ownership. Only admitted
// conventional role sources can establish a namespace below.
func declarationRolePrefixes(name string) []string {
	var prefixes []string
	for i := range len(name) {
		if name[i] == '_' && i > 0 {
			prefixes = append(prefixes, name[:i])
		}
	}
	return prefixes
}

func roleNamespaceDirectories(source *Source) []string {
	dirs := map[string]bool{}
	for _, declaration := range topLevelDeclarations(source) {
		if !defaultVariableName.MatchString(declaration.Name) {
			continue
		}
		for _, prefix := range declarationRolePrefixes(declaration.Name) {
			if prefix == source.Role {
				continue
			}
			for _, role := range referenceRolePaths(source, prefix) {
				for _, kind := range []string{"defaults", "tasks", "handlers", "vars"} {
					dirs[path.Join(role, kind)] = true
				}
			}
		}
	}
	return sortedKeys(dirs)
}

func roleNamespaceOwners(project *Project) map[string][]RelatedLocation {
	if project == nil {
		return nil
	}
	if project.analysis != nil && project.analysis.namespaces != nil {
		return project.analysis.namespaces
	}
	type anchor struct {
		role     string
		location RelatedLocation
		rank     int
	}
	anchors := map[string]anchor{}
	for _, name := range sortedKeys(project.Sources) {
		source := project.Sources[name]
		if source == nil || source.Role == "" || source.RolePath == "" || len(source.parseDiagnostics) > 0 {
			continue
		}
		if source.Kind != Defaults && source.Kind != Tasks && source.Kind != Handlers && source.Kind != Vars {
			continue
		}
		span, rank := Span{}, 0
		if len(source.Documents) > 0 && source.Documents[0] != nil {
			span = source.Documents[0].Span
		}
		if source.Kind == Defaults {
			rank = 1
			declarations := topLevelDeclarations(source)
			if len(declarations) > 0 {
				span = declarations[0].Key.Span
			}
			for _, declaration := range declarations {
				if declaration.Name == source.Role+"_name" {
					span, rank = declaration.Key.Span, 2
					break
				}
			}
		}
		if prior, ok := anchors[source.RolePath]; ok && prior.rank >= rank {
			continue
		}
		anchors[source.RolePath] = anchor{role: source.Role, rank: rank, location: RelatedLocation{
			Path: source.Path, Span: span,
			Message: fmt.Sprintf("role %q owns the %q variable namespace", source.Role, source.Role+"_"),
		}}
	}
	owners := map[string][]RelatedLocation{}
	for _, rolePath := range sortedKeys(anchors) {
		owner := anchors[rolePath]
		owners[owner.role] = append(owners[owner.role], owner.location)
	}
	if project.analysis != nil {
		project.analysis.namespaces = owners
	}
	return owners
}

func namespaceSourceReads(project *Project, source *Source) []RoleReference {
	if project.analysis != nil {
		if reads, ok := project.analysis.namespaceReads[source]; ok {
			return reads
		}
	}
	reads := sourceRoleReferences(source)
	if project.analysis != nil {
		if project.analysis.namespaceReads == nil {
			project.analysis.namespaceReads = map[*Source][]RoleReference{}
		}
		project.analysis.namespaceReads[source] = reads
	}
	return reads
}

// These locations explain literal reads, not evaluated resolution or cycles.
// Unrelated callers cannot widen a selected-file diagnostic beyond its
// declared namespace context.
func relatedNamespaceReads(project *Project, source *Source, key string, ownerPrefixes []string) []RelatedLocation {
	if project == nil {
		return nil
	}
	targets, roles := map[string]bool{}, map[string]bool{}
	for _, prefix := range ownerPrefixes {
		target := strings.TrimSuffix(prefix, "_")
		targets[target] = true
		for _, role := range referenceRolePaths(source, target) {
			roles[role] = true
		}
	}
	var related []RelatedLocation
	for _, name := range sortedKeys(project.Sources) {
		context := project.Sources[name]
		if context == nil || context.Kind == Template || len(context.parseDiagnostics) > 0 || (context != source && !roles[context.RolePath]) {
			continue
		}
		for _, read := range namespaceSourceReads(project, context) {
			if read.LookupKind != "role_var" || read.TargetKind != "explicit" || read.State == "dynamic" || !targets[read.Target] {
				continue
			}
			for _, suffix := range read.Suffixes {
				if key != read.Target+suffix && (suffix == "_name" || key != read.Target+"_role"+suffix) {
					continue
				}
				related = append(related, RelatedLocation{Path: context.Path, Span: Span(read.Location.Span),
					Message: fmt.Sprintf("explicit role_var read of %q in role %q; runtime instance resolution is not evaluated", suffix, read.Target)})
			}
		}
	}
	return related
}
