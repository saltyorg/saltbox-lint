package lint

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func referenceFixture(t *testing.T) (string, string) {
	t.Helper()
	root, err := filepath.Abs("testdata/references")
	if err != nil {
		t.Fatal(err)
	}
	return root, filepath.Join(root, "roles/alpha/tasks/main.yml")
}

func TestReferencesDeclarationCandidatesAndSelection(t *testing.T) {
	root, primary := referenceFixture(t)
	selected, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if selected.SchemaVersion != 1 || len(selected.Sources) != 1 || len(selected.References) != 14 {
		t.Fatalf("query: %#v", selected)
	}
	full, err := References(t.Context(), Options{Root: root, Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	var reads []RoleReference
	for _, r := range full.References {
		if r.Location.Path == "roles/alpha/tasks/main.yml" {
			reads = append(reads, r)
		}
	}
	if !reflect.DeepEqual(reads, selected.References) {
		t.Fatalf("selected/full differ:\n%#v\n%#v", reads, selected.References)
	}
	same := selected.References[0]
	if same.State != "ambiguous" || len(same.Candidates) != 4 {
		t.Fatalf("all layers: %#v", same)
	}
	var names []string
	for _, c := range same.Candidates {
		names = append(names, c.Declaration.Provenance+":"+c.Declaration.Name)
	}
	for _, name := range []string{"defaults:alpha_role_port", "vars:alpha_role_port", "vars:alpha_edge_port", "inventory:alpha_port"} {
		if !slices.Contains(names, name) {
			t.Errorf("missing candidate %s in %v", name, names)
		}
	}
	cross := selected.References[1]
	if cross.State != "resolved" || len(cross.Candidates) != 1 || cross.Candidates[0].Declaration.Key.Text != "beta_role_port" || cross.Candidates[0].Declaration.Value.Text != "1234" {
		t.Fatalf("cross role: %#v", cross)
	}
	if cross.Candidates[0].Declaration.Key.Line != 2 || len(cross.Candidates[0].Declaration.Comments) != 1 {
		t.Fatal("declaration coordinates/comments")
	}
	web := selected.References[2]
	if web.State != "resolved" || len(web.Candidates) != 2 || !reflect.DeepEqual(web.Suffixes, []string{"_web_subdomain", "_web_domain"}) {
		t.Fatalf("web: %#v", web)
	}
	for _, i := range []int{3, 6, 7, 8, 12, 13} {
		if selected.References[i].State != "unavailable" {
			t.Errorf("read %d: %#v", i, selected.References[i])
		}
	}
	for _, i := range []int{4, 5, 10} {
		if selected.References[i].State != "dynamic" {
			t.Errorf("read %d: %#v", i, selected.References[i])
		}
	}
	if selected.References[9].Candidates[0].Declaration.Provenance != "set-fact" || selected.References[11].Candidates[0].Declaration.Provenance != "task-vars" {
		t.Fatal("task layers")
	}
	if len(selected.References[13].SpellingCandidates) == 0 {
		t.Fatal("missing separate spelling hint")
	}
	for _, read := range selected.References {
		source, err := os.ReadFile(filepath.Join(root, read.Location.Path))
		if err != nil {
			t.Fatal(err)
		}
		if string(source[read.Location.Span.Start:read.Location.Span.End]) != read.Location.Text || !strings.Contains(read.Location.Text, "(") {
			t.Fatal("read lost original span")
		}
		if read.State == "proven-missing" {
			t.Fatal("open contract cannot prove missing")
		}
	}
	before, _ := json.Marshal(selected)
	again, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(again)
	if !bytes.Equal(before, after) {
		t.Fatal("nondeterministic query")
	}
}

func TestReferencesNegativeAndFreshDependencies(t *testing.T) {
	root := t.TempDir()
	primary := filepath.Join(root, "roles/a/tasks/main.yml")
	writeTestSource(t, primary, "- debug:\n    msg: \"{{ lookup('role_var', '_port', role='b') }}\"\n")
	before, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Dependencies.Sources) != 1 || !before.Dependencies.Complete {
		t.Fatal("clean query dependencies")
	}
	missing := false
	for _, d := range before.Dependencies.Sources[0].Directories {
		if d.Path == "roles/b/defaults" && d.State == "missing" && len(d.Members) == 0 {
			missing = true
		}
	}
	if !missing {
		t.Fatal("missing target observation")
	}
	declaration := filepath.Join(root, "roles/b/defaults/main.yml")
	writeTestSource(t, declaration, "b_role_port: 42\n")
	after, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if after.References[0].State != "resolved" || after.Dependencies.Generation == before.Dependencies.Generation {
		t.Fatal("target creation did not invalidate")
	}
	writeTestSource(t, declaration, "b_role_port: [\n")
	invalid, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if invalid.References[0].State != "unavailable" || !slices.Contains(invalid.References[0].Reasons, "invalid-target-context") {
		t.Fatal("invalid context guessed")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := References(ctx, Options{Root: root, Paths: []string{primary}}); err == nil {
		t.Fatal("cancel ignored")
	}
}

func writeTestSource(t *testing.T, filename, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestReferencesDecodedActionsAndOpaqueSources(t *testing.T) {
	root := t.TempDir()
	primary := filepath.Join(root, "roles/a/tasks/main.yml")
	input := `- action: debug msg="{{ lookup('role_var', '_port', role='a') }}"
- debug: "msg={{ lookup('role_var', '_port', role='a') }}"
- shell: "echo {{ lookup('role_var', '_port', role='a') }} chdir=/tmp"
- debug:
    msg: !unsafe "{{ lookup('role_var', '_port', role='a') }}"
`
	writeTestSource(t, primary, input)
	writeTestSource(t, filepath.Join(root, "roles/a/defaults/main.yml"), "a_role_port: 42\n")
	writeTestSource(t, filepath.Join(root, "roles/a/templates/data.yml"), "{{ lookup('role_var', '_port', role='a') }}\n")
	report, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.References) != 3 {
		t.Fatalf("decoded/freeform reads: %#v", report.References)
	}
	for _, r := range report.References {
		if r.State != "resolved" {
			t.Fatalf("action resolution: %#v", r)
		}
	}
	data, _ := os.ReadFile(primary)
	if string(data) != input {
		t.Fatal("query changed bytes")
	}
	if _, err := References(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, "roles/a/templates/data.yml")}}); err == nil {
		t.Fatal("template selected")
	}
}

func TestReferencesAliasesInventoryAndCallUncertainty(t *testing.T) {
	root := t.TempDir()
	primary := filepath.Join(root, "roles/my-role/tasks/main.yml")
	writeTestSource(t, filepath.Join(root, "roles/my-role/defaults/main.yml"), "my_role_name: alternate\nmy_role_role_port: 12\nmy_role_role_fact: *external\n")
	// Preserve the alias as source syntax instead of expanding its value.
	writeTestSource(t, filepath.Join(root, "roles/my-role/defaults/main.yml"), "my_role_name: alternate\nmy_role_role_port: 12\nmy_role_role_fact: &literal 5\nmy_role_role_alias: *literal\n")
	writeTestSource(t, filepath.Join(root, "vars.yml"), "my-role_name: '{{ caller_alias }}'\n")
	writeTestSource(t, filepath.Join(root, "inventory.yml"), "all:\n  vars:\n    my-role_name: overridden\n  hosts:\n    example:\n      overridden_port: 13\n")
	writeTestSource(t, primary, `- debug:
    msg: "{{ lookup('role_var', '_port', role='my-role') }}"
- debug:
    msg: "{{ lookup('role_var', '_alias', role='my-role') }}"
- debug:
    msg: "{{ lookup('role_var', '_port', role='my-role', **kwargs) }}"
- debug:
    msg: "{{ lookup('role_var', '_port', role='my-role', role='other') }}"
- debug:
    msg: "{{ lookup('role_var', '_port') }}"
`)
	report, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if report.References[0].State != "ambiguous" || len(report.References[0].Candidates) != 2 || len(report.References[0].AliasDeclarations) != 2 || !slices.Contains(report.References[0].Reasons, "dynamic-alias-declaration") {
		t.Fatalf("alias/inventory layers: %#v", report.References[0])
	}
	if report.References[1].Candidates[0].Declaration.Value.Text != "*literal" {
		t.Fatal("alias value expanded")
	}
	if report.References[2].State != "dynamic" || report.References[3].State != "dynamic" {
		t.Fatal("unpacking or duplicates resolved")
	}
	if report.References[4].TargetKind != "implicit" || !slices.Contains(report.References[4].Reasons, "runtime-role-name") {
		t.Fatal("implicit role guessed runtime target")
	}
}

func TestReferencesRejectEscapedTargetAndPreserveCleanSources(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	primary := filepath.Join(root, "roles/a/tasks/main.yml")
	writeTestSource(t, primary, "- debug:\n    msg: \"{{ lookup('role_var', '_port', role='b') }}\"\n")
	writeTestSource(t, filepath.Join(outside, "defaults/main.yml"), "b_role_port: 42\n")
	if err := os.Symlink(outside, filepath.Join(root, "roles/b")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := References(t.Context(), Options{Root: root, Paths: []string{primary}}); err == nil {
		t.Fatal("escaped target admitted")
	}
	clean := filepath.Join(root, "roles/a/defaults/main.yml")
	writeTestSource(t, clean, "a_role_port: 1\n")
	report, err := References(t.Context(), Options{Root: root, Paths: []string{clean}})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.References) != 0 || len(report.Dependencies.Sources) != 1 || len(report.Dependencies.Sources[0].Directories) == 0 {
		t.Fatal("clean query lost dependencies")
	}
}

func TestReferencesImportBindingAndNullSourceRepresentation(t *testing.T) {
	root := t.TempDir()
	primary := filepath.Join(root, "roles/a/tasks/main.yml")
	writeTestSource(t, primary, `- debug:
    msg: "{% import 'helpers.j2' as lookup %}{{ lookup('role_var', '_port', role='a') }}"
- debug:
    msg: "{{ lookup('role_var', '_port', role='a') }}"
`)
	writeTestSource(t, filepath.Join(root, "roles/a/defaults/main.yml"), "a_role_port: null\n")
	report, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if report.References[0].State != "dynamic" || !slices.Contains(report.References[0].Reasons, "local-callee-binding") {
		t.Fatal("import binding treated as builtin")
	}
	if report.References[1].Candidates[0].Declaration.Value.Text != "null" || !slices.Contains(report.References[1].Reasons, "literal-null-declaration-skipped-at-runtime") {
		t.Fatal("null runtime skip not explained")
	}
}

func TestReferencesWithCalleeBindings(t *testing.T) {
	for _, callee := range []string{"lookup", "query", "q"} {
		call := callee + "('role_var', '_port', role='a')"
		for _, tc := range []struct {
			name    string
			binding string
			bound   bool
		}{
			{"single", callee + " = caller_function", true},
			{"multiple", "other = fn([1, 2], flag=value), " + callee + " = caller_function", true},
			{"tuple", "(other, " + callee + ") = caller_pair", true},
			{"unparenthesized-tuple", "other, " + callee + " = caller_pair", true},
			{"nested-tuple", "(other, (" + callee + ", third)) = caller_pair", true},
			{"value-only", "other = fn([" + callee + ", value], flag=third), last = fourth", false},
			{"rhs-call", "other = " + call, false},
			{"rhs-call-before-binding", "other = " + call + ", " + callee + " = caller_function", true},
			{"string-value", "other = '" + callee + " = caller_function, q = query'", false},
		} {
			t.Run(callee+"/"+tc.name, func(t *testing.T) {
				root := t.TempDir()
				primary := filepath.Join(root, "roles/a/tasks/main.yml")
				// Before, inside nested blocks, and after the binding all share the
				// conservative scalar policy. A separate scalar stays independent.
				input := fmt.Sprintf("- debug:\n    msg: |\n      {# {%% with %s = caller_function %%} #} {{ '{%% with %s = caller_function %%}' }}\n      {{ %s }}\n      {%% with %s %%}{%% with other = caller_value %%}{{ %s }}{%% endwith %%}{%% endwith %%}\n      {{ %s }}\n- debug:\n    msg: \"{{ %s }}\"\n", callee, callee, call, tc.binding, call, call, call)
				writeTestSource(t, primary, input)
				writeTestSource(t, filepath.Join(root, "roles/a/defaults/main.yml"), "a_role_port: 42\n")
				selected, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
				if err != nil {
					t.Fatal(err)
				}
				full, err := References(t.Context(), Options{Root: root, Paths: []string{root}})
				if err != nil {
					t.Fatal(err)
				}
				if len(selected.References) != strings.Count(input, call) || !reflect.DeepEqual(selected.References, full.References) {
					t.Fatalf("selected/full references: %#v / %#v", selected.References, full.References)
				}
				for i, read := range selected.References {
					wantBound := tc.bound && i < len(selected.References)-1
					if wantBound {
						if read.State != "dynamic" || !slices.Contains(read.Reasons, "local-callee-binding") || len(read.Candidates) != 0 {
							t.Errorf("locally bound callee resolved: %#v", read)
						}
					} else if read.State != "resolved" || len(read.Candidates) != 1 || slices.Contains(read.Reasons, "local-callee-binding") {
						t.Errorf("unbound callee lost its declaration: %#v", read)
					}
					if !slices.Contains(read.Reasons, "runtime-precedence-and-providers-unmodeled") {
						t.Error("runtime uncertainty lost")
					}
					if read.Location.Path != "roles/a/tasks/main.yml" || read.Location.Text != call || input[read.Location.Span.Start:read.Location.Span.End] != call {
						t.Errorf("original call location lost: %#v", read.Location)
					}
				}
				if !selected.Dependencies.Complete || len(selected.Dependencies.Sources) != 1 || len(selected.Dependencies.Sources[0].Directories) == 0 {
					t.Fatal("source-owned query lost dependencies")
				}
				data, err := os.ReadFile(primary)
				if err != nil || string(data) != input {
					t.Fatal("query changed source bytes")
				}
			})
		}
	}
}

func TestReferencesInvalidInventoryKeepsCandidatesUnavailable(t *testing.T) {
	root := t.TempDir()
	primary := filepath.Join(root, "roles/a/tasks/main.yml")
	writeTestSource(t, primary, "- debug:\n    msg: \"{{ lookup('role_var', '_port', role='a') }}\"\n")
	writeTestSource(t, filepath.Join(root, "roles/a/defaults/main.yml"), "a_role_port: 42\n")
	writeTestSource(t, filepath.Join(root, "group_vars/all.yml"), "a_port: [\n")
	report, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.References[0].Candidates) != 1 || report.References[0].State != "unavailable" || !slices.Contains(report.References[0].Reasons, "invalid-target-context") {
		t.Fatal("invalid provider context was called complete")
	}
}

func TestReferencesOwningProviderAndDuplicateRoleRoots(t *testing.T) {
	root := t.TempDir()
	primary := filepath.Join(root, "roles/a/tasks/main.yml")
	writeTestSource(t, primary, `- set_fact:
    b_role_port: 9
- debug:
    msg: "{{ lookup('role_var', '_port', role='b') }}"
`)
	writeTestSource(t, filepath.Join(root, "roles/b/defaults/main.yml"), "b_role_port: 10\n")
	writeTestSource(t, filepath.Join(root, "resources/roles/b/vars/main.yml"), "b_role_port: 11\n")
	report, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if report.References[0].State != "ambiguous" || len(report.References[0].Candidates) != 3 {
		t.Fatalf("owning/target roots lost candidates: %#v", report.References[0])
	}
	if report.References[0].Candidates[1].Declaration.Provenance != "set-fact" {
		t.Fatal("owning set_fact provider omitted")
	}
}

func TestReferencesUnindexedSelectionDoesNotChangePrimary(t *testing.T) {
	root := t.TempDir()
	primary := filepath.Join(root, "roles/a/tasks/main.yml")
	writeTestSource(t, primary, "- debug:\n    msg: \"{{ lookup('role_var', '_port', role='a') }}\"\n")
	writeTestSource(t, filepath.Join(root, "roles/a/defaults/main.yml"), "a_role_port: 42\n")
	meta := filepath.Join(root, "roles/a/meta/main.yml")
	writeTestSource(t, meta, "unindexed: [\n")
	selected, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	extra, err := References(t.Context(), Options{Root: root, Paths: []string{primary, meta}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(selected.References, extra.References) || extra.References[0].State != "resolved" {
		t.Fatal("unindexed source changed a primary record")
	}
}

func TestReferencesPrimaryCallerSetFactIsRetained(t *testing.T) {
	root := t.TempDir()
	primary := filepath.Join(root, "tasks/main.yml")
	writeTestSource(t, primary, `- set_fact:
    b_role_port: 42
- debug:
    msg: "{{ lookup('role_var', '_port', role='b') }}"
`)
	report, err := References(t.Context(), Options{Root: root, Paths: []string{primary}})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.References[0].Candidates) != 1 || report.References[0].Candidates[0].Declaration.Provenance != "set-fact" || report.References[0].State != "unavailable" {
		t.Fatal("primary runtime provider lost or external role claimed complete")
	}
}
