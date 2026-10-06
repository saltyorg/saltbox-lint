package lint

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestQueryAgreesWithReferenceIndex(t *testing.T) {
	root, primary := referenceFixture(t)
	data, err := os.ReadFile(primary)
	if err != nil {
		t.Fatal(err)
	}
	references, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	for i, read := range references.References {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			result, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: data, Operation: "definition", Offset: read.Location.Span.Start + 2})
			if err != nil {
				t.Fatal(err)
			}
			if result.State != read.State {
				t.Fatalf("state %s != %s", result.State, read.State)
			}
			var declarations []RoleDeclaration
			for _, candidate := range read.Candidates {
				declarations = append(declarations, candidate.Declaration)
			}
			if len(declarations) > 0 && !reflect.DeepEqual(result.Declarations, declarations) {
				t.Fatalf("candidates differ: %#v != %#v", result.Declarations, declarations)
			}
			if len(result.Declarations) != len(declarations) {
				t.Fatal("fabricated candidate")
			}
			if result.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256(data)) || result.Path != "roles/alpha/tasks/main.yml" || result.Root != root || result.SchemaVersion != 1 {
				t.Fatal("snapshot identity")
			}
			if len(result.Dependencies.Sources) != 1 || result.Dependencies.Sources[0].SourceSHA256 != result.SourceSHA256 {
				t.Fatal("primary dependency owner")
			}
			for _, location := range result.Locations {
				target, err := os.ReadFile(filepath.Join(root, location.Path))
				if err != nil {
					t.Fatal(err)
				}
				if result.TargetHashes[location.Path] != fmt.Sprintf("%x", sha256.Sum256(target)) || string(target[location.Span.Start:location.Span.End]) != location.Text {
					t.Fatal("target hash or span")
				}
			}
		})
	}
}

func TestQueryLiteralCompletionsAndReferences(t *testing.T) {
	root, primary := referenceFixture(t)
	for _, test := range []struct{ source, active, want string }{
		{`- debug: {msg: "{{ lookup('role_var', '_po', role='beta') }}"}`, "_po", "_port"},
		{`- debug: {msg: "{{ lookup('role_var', '_port', role='be') }}"}`, "be", "beta"},
		{`- debug: {msg: "{{ lookup('role_var', '', role='beta') }}"}`, "''", "_port"},
	} {
		offset := strings.Index(test.source, test.active) + 1
		result, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(test.source), Operation: "completion", Offset: offset})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, completion := range result.Completions {
			if completion.Label == test.want {
				found = true
				span := completion.Location.Span
				if test.source[span.Start-1] != '\'' || test.source[span.End] != '\'' {
					t.Fatal("changed quote span")
				}
				edited := test.source[:span.Start] + completion.Text + test.source[span.End:]
				if !strings.Contains(edited, "'"+test.want+"'") {
					t.Fatal(edited)
				}
			}
		}
		if !found {
			t.Fatalf("missing %s in %#v", test.want, result)
		}
	}
	source := []byte(`- debug: {msg: "{{ lookup('role_var', '_port', role='beta') }}"}`)
	result, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: source, Operation: "references", Offset: 25})
	if err != nil {
		t.Fatal(err)
	}
	if result.Coverage.Complete || !slices.Contains(result.Coverage.Reasons, "template-runtime-and-unselected-template-reads-unmodeled") {
		t.Fatal("coverage claims completeness")
	}
	if !slices.ContainsFunc(result.Locations, func(l QueryLocation) bool { return l.Kind == "read" && l.Path == "roles/alpha/tasks/main.yml" }) {
		t.Fatal("missing static read")
	}
	declaration := result.Declarations[0].Key
	data, err := os.ReadFile(filepath.Join(root, declaration.Path))
	if err != nil {
		t.Fatal(err)
	}
	fromDeclaration, err := Query(t.Context(), QueryRequest{Root: root, Filename: filepath.Join(root, declaration.Path), Source: data, Operation: "references", Offset: declaration.Span.Start})
	if err != nil || !slices.ContainsFunc(fromDeclaration.Locations, func(l QueryLocation) bool { return l.Kind == "read" }) {
		t.Fatalf("declaration references: %#v %v", fromDeclaration, err)
	}
}

func TestQueryNameSuffixCompletion(t *testing.T) {
	root, primary := referenceFixture(t)
	for _, callee := range []string{"lookup", "query", "q"} {
		for _, quote := range []string{"'", `"`} {
			for _, scope := range []struct {
				name, role string
				want       bool
			}{
				{"implicit", "", true},
				{"explicit", ", role=" + quote + "alpha" + quote, true},
				{"absent", ", role=" + quote + "beta" + quote, false},
			} {
				t.Run(callee+"/"+quote+"/"+scope.name, func(t *testing.T) {
					source := "# 😀é\r\n- debug:\r\n    msg: |\r\n      {{ " + callee + "(" + quote + "role_var" + quote + ", " + quote + "_na" + quote + scope.role + ") }}\r\n"
					start := strings.Index(source, "_na")
					result, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(source), Operation: "completion", Offset: start + 2})
					if err != nil {
						t.Fatal(err)
					}
					if result.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(source))) {
						t.Fatal("completion source identity changed")
					}
					found := false
					for _, completion := range result.Completions {
						if scope.name == "implicit" && completion.Label == "_edge_port" {
							t.Fatal("guessed an implicit runtime alias")
						}
						if completion.Label != "_name" {
							continue
						}
						found = true
						if completion.Location.Span != (DecisionSpan{Start: start, End: start + 3}) || completion.Location.Text != "_na" || completion.Text != "_name" {
							t.Fatalf("literal edit changed: %#v", completion)
						}
						edited := source[:start] + completion.Text + source[start+3:]
						if edited != strings.Replace(source, quote+"_na"+quote, quote+"_name"+quote, 1) {
							t.Fatal("completion changed surrounding bytes or quotes")
						}
						definition, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(edited), Operation: "definition", Offset: start + 2})
						if err != nil || len(definition.Declarations) != 1 || definition.Declarations[0].Name != "alpha_name" {
							t.Fatalf("completion does not resolve its declaration: %#v %v", definition, err)
						}
						key := definition.Declarations[0].Key
						data, err := os.ReadFile(filepath.Join(root, key.Path))
						if err != nil || string(data[key.Span.Start:key.Span.End]) != key.Text || definition.TargetHashes[key.Path] != fmt.Sprintf("%x", sha256.Sum256(data)) {
							t.Fatal("original declaration span or hash changed")
						}
					}
					if found != scope.want {
						t.Fatalf("_name completion present %t, want %t: %#v", found, scope.want, result.Completions)
					}
				})
			}
		}
	}
}

func TestQueryDeclinesDynamicUnsafeAndUnmappedCompletion(t *testing.T) {
	root, primary := referenceFixture(t)
	for _, source := range []string{
		`- debug: {msg: "{{ lookup('role_var', requested, role='beta') }}"}`,
		`- debug: {msg: "{{ lookup('vendor.role_var', '_port', role='beta') }}"}`,
		`- debug: {msg: "{% set lookup = custom %}{{ lookup('role_var', '_port', role='beta') }}"}`,
		`- debug: {msg: !unsafe "{{ lookup('role_var', '_port', role='beta') }}"}`,
	} {
		offset := strings.Index(source, "beta") + 2

		result, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(source), Operation: "completion", Offset: offset})
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Completions) > 0 {
			t.Fatalf("unsafe completion: %#v", result)
		}
	}
	escaped := `- debug: {msg: "{{ lookup(\"role_var\", \"_port\", role=\"beta\") }}"}`
	result, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(escaped), Operation: "completion", Offset: strings.Index(escaped, "beta") + 2})
	if err != nil || len(result.Completions) > 0 {
		t.Fatalf("escaped token edit: %#v %v", result, err)
	}
}

func TestQueryOffsetsCRLFUnicodeAndAdmission(t *testing.T) {
	root, primary := referenceFixture(t)
	text := "# 😀é\r\n- debug: {msg: \"{{ lookup('role_var', '_port', role='beta') }}\"}\r\n"
	for _, offset := range []int{-1, len(text) + 1, 3, 5, 9} {
		_, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(text), Operation: "definition", Offset: offset})
		if err == nil {
			t.Fatalf("accepted invalid boundary %d", offset)
		}
	}
	result, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(text), Operation: "hover", Offset: strings.Index(text, "_port")})
	if err != nil || len(result.Declarations) != 1 || result.Origin.Line != 2 {
		t.Fatalf("CRLF Unicode snapshot: %#v %v", result, err)
	}
	for _, filename := range []string{filepath.Join(t.TempDir(), "outside.yml")} {
		_, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Source: []byte(text), Operation: "definition", Offset: 15})
		if err == nil {
			t.Fatalf("admitted %s", filename)
		}
	}
	_, err = Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(text), Operation: "rename", Offset: 15})
	if err == nil {
		t.Fatal("rename admitted")
	}
}

func TestQueryNestedLiteralLookup(t *testing.T) {
	root, primary := referenceFixture(t)
	for _, outer := range []string{"lookup", "query", "q"} {
		for _, inner := range []string{"lookup", "query", "q"} {
			for _, operation := range []string{"definition", "hover", "references", "completion"} {
				t.Run(outer+"/"+inner+"/"+operation, func(t *testing.T) {
					source := "# 😀é\r\n- debug:\r\n    msg: |\r\n      {{ " + outer + "('role_var', '_outer', role=" + inner + "('role_var', '_name', role='alpha')) }}\r\n"
					start := strings.Index(source, "_name")
					indexed, err := References(t.Context(), Options{Root: root, Paths: []string{primary}, StdinFilename: primary, Stdin: []byte(source)})
					if err != nil {
						t.Fatal(err)
					}
					var expected *RoleReference
					for i := range indexed.References {
						read := &indexed.References[i]
						if read.State == "resolved" && slices.Contains(read.Suffixes, "_name") {
							expected = read
						}
					}
					if expected == nil {
						t.Fatal("reference index lost resolved inner lookup")
					}
					result, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(source), Operation: operation, Offset: start + 2})
					if err != nil {
						t.Fatal(err)
					}
					if result.State != "resolved" || len(result.Declarations) != 1 || result.Declarations[0].Name != "alpha_name" || result.Origin == nil || *result.Origin != expected.Location {
						t.Fatalf("nested lookup disagrees with reference index: %#v", result)
					}
					if result.SourceSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(source))) {
						t.Fatal("nested snapshot hash changed")
					}
					key := result.Declarations[0].Key
					data, err := os.ReadFile(filepath.Join(root, key.Path))
					if err != nil || string(data[key.Span.Start:key.Span.End]) != key.Text || result.TargetHashes[key.Path] != fmt.Sprintf("%x", sha256.Sum256(data)) {
						t.Fatal("nested target span or hash changed")
					}
					if operation == "completion" {
						found := false
						for _, item := range result.Completions {
							if item.Label != "_name" {
								continue
							}
							found = true
							if item.Location.Span != (DecisionSpan{Start: start, End: start + 5}) || item.Location.Text != "_name" || item.Text != "_name" || source[item.Location.Span.Start-1] != '\'' || source[item.Location.Span.End] != '\'' {
								t.Fatalf("nested completion edits outside literal: %#v", item)
							}
						}
						if !found {
							t.Fatal("missing inner suffix completion")
						}
					}
					if operation == "references" && !slices.ContainsFunc(result.Locations, func(location QueryLocation) bool {
						return location.Kind == "read" && location.Span == expected.Location.Span
					}) {
						t.Fatal("references lost inner read span")
					}
					outerResult, err := Query(t.Context(), QueryRequest{Root: root, Filename: primary, Source: []byte(source), Operation: operation, Offset: strings.Index(source, "_outer") + 2})
					if err != nil || outerResult.State != "dynamic" || len(outerResult.Declarations) != 0 || len(outerResult.Completions) != 0 || len(outerResult.Locations) != 0 {
						t.Fatalf("outer dynamic call changed: %#v %v", outerResult, err)
					}
				})
			}
		}
	}
}

func TestQueryReferencesRetainsExtensionlessTemplateAliasOwner(t *testing.T) {
	root := t.TempDir()
	gitTest(t, root, "init", "-q")
	putFile(t, root, ".saltbox-lint", "")
	text := "# 😀é\r\n- debug: {msg: \"😀 {{ lookup('role_var', '_port', role='navtarget') }}\"}\r\n"
	filename := putFile(t, root, "roles/navsource/tasks/main.yml", text)
	putFile(t, root, "roles/navtarget/defaults/main.yml", "navtarget_role_port: 1234\n")
	putFile(t, root, "roles/readonly/tasks/main.yml", "[]\n")
	owner := "roles/readonly/tasks/config"
	alias := "roles/readonly/templates/config"
	template := " \t😀\r\n{% raw -%}{{ {% unmatched{%- endraw %}\r\n{{ lookup('role_var', '_port', role='navtarget') }}  "
	ownerFilename := putFile(t, root, owner, template)
	for _, basename := range []string{"config", "config.yaml", "config.j2"} {
		putFile(t, root, "roles/readonly/tasks/"+basename, template)
		putFile(t, root, "roles/readonly/templates/"+basename, template)
	}
	gitTest(t, root, "add", ".")
	aliasDirectory := filepath.Dir(filepath.Join(root, alias))
	if err := os.RemoveAll(aliasDirectory); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(ownerFilename), aliasDirectory); err != nil {
		t.Fatal(err)
	}
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{root}, StdinFilename: filename, Stdin: []byte(text), IncludeAnalysis: true, referenceContext: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, basename := range []string{"config", "config.yaml", "config.j2"} {
		source := project.Sources["roles/readonly/templates/"+basename]
		if source == nil || source.Kind != Template || string(source.Data) != template || scanTemplate(source).configurationUnavailable {
			t.Fatalf("indexed alias fixture did not admit static template %s", basename)
		}
	}
	if source := project.Sources["roles/readonly/tasks/config.yaml"]; source == nil || len(source.parseDiagnostics) > 0 {
		t.Fatal("alias fixture requires valid owning task YAML")
	}
	result, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Source: []byte(text), Operation: "references", Offset: strings.Index(text, "_port") + 2})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(result.Locations, func(location QueryLocation) bool { return location.Kind == "read" && location.Path == alias }) {
		t.Fatal("missing admitted lexical template reference")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(template)))
	for _, name := range []string{owner, alias} {
		if !slices.ContainsFunc(result.Dependencies.Sources[0].Files, func(file DependencyFile) bool {
			return file.Path == name && file.State == "read" && file.SHA256 == digest
		}) {
			t.Fatalf("missing exact template owner observation: %s", name)
		}
	}
	if project.Sources[owner] != nil {
		t.Fatal("physical observation fabricated an unclassified parser source")
	}
	for _, directory := range result.Dependencies.Sources[0].Directories {
		if strings.HasPrefix(owner, directory.Path+"/") && !slices.Contains(directory.Members, owner) {
			t.Fatal("physical read missing from observed directory members")
		}
	}
	if _, found := result.TargetHashes[owner]; found {
		t.Fatal("physical observation fabricated an unparsed reference target")
	}
	if got, err := os.ReadFile(ownerFilename); err != nil || string(got) != template {
		t.Fatal("query changed template bytes")
	}
	// Invalid owning task YAML must continue to refuse template reads, even
	// though the indexed alias and its captured physical dependency are present.
	putFile(t, root, "roles/readonly/tasks/config.yaml", "{{ value }}")
	invalid, err := Load(t.Context(), Options{Root: root, Paths: []string{root}, referenceContext: true})
	if err != nil {
		t.Fatal(err)
	}
	if source := invalid.Sources["roles/readonly/tasks/config.yaml"]; source == nil || len(source.parseDiagnostics) == 0 {
		t.Fatal("refusal control requires invalid owning task YAML")
	}
	if source := invalid.Sources[alias]; source == nil || !slices.Contains(scanTemplate(source).reasonMessages(), "template configuration is unavailable: invalid owning task context") {
		t.Fatal("refusal control requires the admitted alias with unavailable configuration")
	}
	refused, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Source: []byte(text), Operation: "references", Offset: strings.Index(text, "_port") + 2})
	if err != nil {
		t.Fatal(err)
	}
	if slices.ContainsFunc(refused.Locations, func(location QueryLocation) bool { return location.Path == alias }) {
		t.Fatal("invalid owning task context authorized template reference")
	}
	if !slices.ContainsFunc(refused.Locations, func(location QueryLocation) bool {
		return location.Path == "roles/navsource/tasks/main.yml" && location.Kind == "read"
	}) {
		t.Fatal("invalid template context revoked the valid primary YAML read")
	}
	if !slices.ContainsFunc(refused.Dependencies.Sources[0].Files, func(file DependencyFile) bool {
		return file.Path == owner && file.State == "read" && file.SHA256 == digest
	}) {
		t.Fatal("invalid owning task context lost captured physical dependency")
	}
}
