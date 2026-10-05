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
	if result.Coverage.Complete || !slices.Contains(result.Coverage.Reasons, "templates-context-only") {
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
	for _, filename := range []string{filepath.Join(t.TempDir(), "outside.yml"), filepath.Join(root, "roles/alpha/templates/value.j2")} {
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
