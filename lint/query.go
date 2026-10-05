package lint

import (
	"context"
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

// QueryRequest describes one exact editor snapshot. Offset is a half-open UTF-8
// boundary in Source; no query evaluates Ansible or writes any source.
type QueryRequest struct {
	Root      string
	Filename  string
	Source    []byte
	Operation string
	Offset    int
}

type QueryCompletion struct {
	Label    string            `json:"label"`
	Detail   string            `json:"detail"`
	Location ReferenceLocation `json:"location"`
	Text     string            `json:"text"`
}

type QueryLocation struct {
	ReferenceLocation
	Kind string `json:"kind"`
}

type QueryCoverage struct {
	Complete bool     `json:"complete"`
	Reasons  []string `json:"reasons"`
}

type QueryReport struct {
	SchemaVersion int                `json:"schema_version"`
	Root          string             `json:"root"`
	Path          string             `json:"path"`
	SourceSHA256  string             `json:"source_sha256"`
	Operation     string             `json:"operation"`
	Offset        int                `json:"offset"`
	State         string             `json:"state"`
	Reasons       []string           `json:"reasons"`
	Coverage      QueryCoverage      `json:"coverage"`
	Origin        *ReferenceLocation `json:"origin,omitempty"`
	TargetHashes  map[string]string  `json:"target_hashes"`
	Locations     []QueryLocation    `json:"locations"`
	Declarations  []RoleDeclaration  `json:"declarations"`
	Completions   []QueryCompletion  `json:"completions"`
	Dependencies  *AnalysisRecord    `json:"dependencies"`
}

type queryArgument struct {
	kind     string
	location ReferenceLocation
}

// Query reuses the same admitted reads and declaration resolver as References.
// Full discovery supplies cross-role reads and role-name completion; explicit
// primary admission preserves ignored and unsaved-buffer inspection.
func Query(ctx context.Context, request QueryRequest) (QueryReport, error) {
	result := QueryReport{SchemaVersion: 1, Operation: request.Operation, Offset: request.Offset, State: "none", Reasons: []string{}, TargetHashes: map[string]string{}, Locations: []QueryLocation{}, Declarations: []RoleDeclaration{}, Completions: []QueryCompletion{}, Coverage: QueryCoverage{Reasons: []string{"static-reads-only", "runtime-precedence-and-providers-unmodeled", "template-runtime-and-unselected-template-reads-unmodeled", "directory-discovery-excludes-ignored-sources"}}}
	if !slices.Contains([]string{"definition", "completion", "hover", "references"}, request.Operation) {
		return result, fmt.Errorf("unknown query operation %q", request.Operation)
	}
	if !utf8.Valid(request.Source) || request.Offset < 0 || request.Offset > len(request.Source) || (request.Offset < len(request.Source) && !utf8.RuneStart(request.Source[request.Offset])) || (request.Offset > 0 && request.Offset < len(request.Source) && request.Source[request.Offset-1] == '\r' && request.Source[request.Offset] == '\n') {
		return result, fmt.Errorf("query offset must be a valid UTF-8 source boundary outside CRLF")
	}
	identity, err := ResolveSourceIdentity(request.Root, request.Filename)
	if err != nil {
		return result, err
	}
	result.Root, result.Path, result.SourceSHA256 = identity.Root, identity.Path, fmt.Sprintf("%x", sha256.Sum256(request.Source))
	p, err := Load(ctx, Options{Root: identity.Root, Paths: []string{identity.Root}, StdinFilename: filepath.Join(identity.Root, filepath.FromSlash(identity.Path)), Stdin: request.Source, IncludeAnalysis: true, referenceContext: true})
	if err != nil {
		return result, err
	}
	source := p.Sources[identity.Path]
	if source == nil || !p.Selected[identity.Path] {
		return result, fmt.Errorf("query requires a selected source")
	}
	// Collapse full discovery observations to the primary owner. Every read byte
	// remains a dependency, including negative context and discovery decisions.
	dirs := map[string]bool{}
	files := map[string]bool{}
	for _, dependency := range p.Dependencies.Sources {
		for _, directory := range dependency.Directories {
			dirs[directory.Path] = true
		}
		for _, file := range dependency.Files {
			files[file.Path] = true
		}
	}
	for name := range p.Sources {
		files[name] = true
	}
	p.Selected = map[string]bool{identity.Path: true}
	p.referenceDirectories = map[string][]string{identity.Path: sortedKeys(dirs)}
	p.referenceFiles = sortedKeys(files)
	result.Dependencies = dependencyRecord(p, Rules())
	if source.Kind == Template && request.Operation == "completion" {
		result.State = "unavailable"
		result.Reasons = append(result.Reasons, "templates-are-read-only")
		return result, ctx.Err()
	}
	if source.Kind == Template {
		scan := scanTemplate(source)
		result.Coverage.Reasons = append(result.Coverage.Reasons, scan.reasons...)
		if len(scan.diagnostics) > 0 {
			result.State = "unavailable"
			result.Reasons = append(result.Reasons, "invalid-primary-template")
			return result, ctx.Err()
		}
		if scan.configurationUnavailable {
			result.State = "unavailable"
			result.Reasons = append(result.Reasons, "template-configuration-unavailable")
			return result, ctx.Err()
		}
	}
	index := newRoleSymbolIndex(p)
	if len(source.parseDiagnostics) > 0 {
		result.State = "unavailable"
		result.Reasons = append(result.Reasons, "invalid-primary-yaml")
		return result, ctx.Err()
	}
	var reads []RoleReference
	for _, name := range sortedKeys(p.Sources) {
		if len(p.Sources[name].parseDiagnostics) > 0 {
			result.Coverage.Reasons = append(result.Coverage.Reasons, "invalid-yaml-reads-unavailable")
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		for _, read := range sourceRoleReferences(p.Sources[name]) {
			index.resolve(p, p.Sources[name], &read)
			reads = append(reads, read)
		}
	}
	var selected *RoleReference
	for i := range reads {
		read := &reads[i]
		if read.Location.Path == identity.Path && request.Offset >= read.Location.Span.Start && request.Offset < read.Location.Span.End {
			// Nested recognized calls resolve independently. Select the smallest
			// enclosing source span without changing any indexed location.
			if selected == nil || read.Location.Span.End-read.Location.Span.Start < selected.Location.Span.End-selected.Location.Span.Start {
				selected = read
			}
		}
	}
	if selected != nil {
		result.Origin, result.State, result.Reasons = &selected.Location, selected.State, slices.Clone(selected.Reasons)
		for _, candidate := range selected.Candidates {
			result.Declarations = append(result.Declarations, candidate.Declaration)
		}
	}
	if request.Operation == "completion" {
		if selected != nil {
			result.Completions = index.queryCompletions(ctx, p, source, *selected, request.Offset)
		}
	} else if request.Operation == "references" {
		if selected == nil {
			for _, declaration := range index.declarations {
				key := declaration.declaration.Key
				if key.Path == identity.Path && request.Offset >= key.Span.Start && request.Offset < key.Span.End {
					result.Origin = &key
					result.State = "resolved"
					result.Declarations = append(result.Declarations, declaration.declaration)
				}
			}
		}
		for _, read := range reads {
			if read.State == "dynamic" {
				result.Coverage.Reasons = append(result.Coverage.Reasons, "dynamic-reads-unresolved")
				continue
			}
			for _, candidate := range read.Candidates {
				if slices.ContainsFunc(result.Declarations, func(d RoleDeclaration) bool {
					return d.Key.Path == candidate.Declaration.Key.Path && d.Key.Span == candidate.Declaration.Key.Span
				}) {
					result.Locations = append(result.Locations, QueryLocation{ReferenceLocation: read.Location, Kind: "read"})
					break
				}
			}
		}
	}
	for _, declaration := range result.Declarations {
		result.Locations = append(result.Locations, QueryLocation{ReferenceLocation: declaration.Key, Kind: "declaration"})
		for _, location := range append([]ReferenceLocation{declaration.Key, declaration.Value}, declaration.Comments...) {
			result.TargetHashes[location.Path] = fmt.Sprintf("%x", sha256.Sum256(p.Sources[location.Path].Data))
		}
	}
	for _, location := range result.Locations {
		result.TargetHashes[location.Path] = fmt.Sprintf("%x", sha256.Sum256(p.Sources[location.Path].Data))
	}
	slices.SortFunc(result.Locations, func(a, b QueryLocation) int {
		if a.Path != b.Path {
			return strings.Compare(a.Path, b.Path)
		}
		return a.Span.Start - b.Span.Start
	})
	result.Locations = slices.CompactFunc(result.Locations, func(a, b QueryLocation) bool { return a.Path == b.Path && a.Span == b.Span && a.Kind == b.Kind })
	slices.Sort(result.Reasons)
	result.Reasons = slices.Compact(result.Reasons)
	slices.Sort(result.Coverage.Reasons)
	result.Coverage.Reasons = slices.Compact(result.Coverage.Reasons)
	return result, ctx.Err()
}

// Completion edits require a directly represented quoted token. YAML/Jinja
// escapes or folding decline an edit rather than guessing its source mapping.
func queryArguments(source *Source, call Call, plugin string) []queryArgument {
	var result []queryArgument
	positional := 0
	for _, argument := range call.Arguments {
		kind := ""
		if argument.Name == "role" {
			kind = "role"
		}
		if argument.Name == "" {
			if positional == 1 && plugin == "role_var" {
				kind = "suffix"
			}
			positional++
		}
		if kind == "" {
			continue
		}
		literal, ok := jinjaStringLiteral(argument.Tokens)
		if !ok {
			continue
		}
		token := argument.Tokens[0]
		representation := referenceLocation(source, token.Span)
		if representation.Text != token.Text {
			continue
		}
		span := Span{Start: token.Span.Start + 1, End: token.Span.End - 1}
		location := referenceLocation(source, span)
		if location.Text != literal {
			continue
		}
		result = append(result, queryArgument{kind, location})
	}
	return result
}

func (index roleSymbolIndex) queryCompletions(ctx context.Context, p *Project, source *Source, read RoleReference, offset int) []QueryCompletion {
	result := []QueryCompletion{}
	if read.State == "dynamic" || slices.Contains(read.Reasons, "external-plugin-contract") {
		return result
	}
	for _, argument := range read.arguments {
		if offset < argument.location.Span.Start || offset > argument.location.Span.End {
			continue
		}
		values := map[string]string{}
		if argument.kind == "role" {
			for _, s := range p.Sources {
				if literalRoleName.MatchString(s.Role) {
					values[s.Role] = "Local role declaration context"
				}
			}
		} else {
			prefixes := []string{read.Target + "_role"}
			if read.TargetKind == "explicit" {
				prefixes = append(prefixes, read.Target)
			}
			for _, alias := range read.AliasDeclarations {
				for _, declaration := range index.declarations {
					if declaration.declaration.Key.Path == alias.Key.Path && declaration.declaration.Key.Span == alias.Key.Span && declaration.value.Kind == "string" && !strings.ContainsAny(declaration.value.Value, "{}") {
						prefixes = append(prefixes, declaration.value.Value)
					}
				}
			}
			// The _name fallback uses <role>_name rather than <role>_role_name.
			// Let the shared resolver decide whether that special suffix exists.
			suffixes := map[string]bool{"_name": true}
			for _, declaration := range index.declarations {
				name := declaration.declaration.Name
				for _, prefix := range prefixes {
					for _, spelling := range []string{prefix, strings.ReplaceAll(prefix, "-", "_")} {
						if suffix, found := strings.CutPrefix(name, spelling); found && strings.HasPrefix(suffix, "_") {
							suffixes[suffix] = true
						}
					}
				}
			}
			for _, suffix := range sortedKeys(suffixes) {
				if ctx.Err() != nil {
					return result
				}
				candidateRead := RoleReference{Location: read.Location, OwningRole: read.OwningRole, OwningRolePath: read.OwningRolePath, LookupKind: read.LookupKind, Target: read.Target, TargetKind: read.TargetKind, Suffixes: []string{suffix}, State: "unavailable"}
				index.resolve(p, source, &candidateRead)
				if len(candidateRead.Candidates) > 0 {
					values[suffix] = fmt.Sprintf("%d source declaration candidates", len(candidateRead.Candidates))
				}
			}
		}
		for _, value := range sortedKeys(values) {
			// Role and suffix identifiers cannot contain quotes, escapes or templates.
			if !literalRoleName.MatchString(value) || strings.ContainsAny(value, "'\"\\{}") {
				continue
			}
			result = append(result, QueryCompletion{Label: value, Detail: values[value], Location: argument.location, Text: value})
		}
	}
	return result
}
