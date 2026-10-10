package lint

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const prefixOwnerDefaults = "roles/komodo/defaults/main.yml"

func prefixFixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "prefix-ownership", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func prefixProject(t *testing.T, files map[string]string) *Project {
	t.Helper()
	project := &Project{Root: "/project", Sources: map[string]*Source{}, Selected: map[string]bool{}}
	for name, input := range files {
		source, diagnostics := Parse(name, []byte(input))
		if len(diagnostics) != 0 {
			t.Fatalf("parse %s: %+v", name, diagnostics)
		}
		project.Sources[name] = source
		project.Selected[name] = true
	}
	return project
}

func prefixRules() []Rule {
	return slices.DeleteFunc(Rules(), func(rule Rule) bool { return rule.ID != "role-variable-prefix" })
}

func assertPrefixViolation(t *testing.T, project *Project, diagnostic Diagnostic, path, key, ownerPath string) {
	t.Helper()
	if diagnostic.RuleID != "role-variable-prefix" || diagnostic.Path != path || diagnostic.Severity != "error" {
		t.Fatalf("unexpected prefix diagnostic: %+v", diagnostic)
	}
	source := project.Sources[path]
	if diagnostic.Span.Start < 0 || diagnostic.Span.End > len(source.Data) || diagnostic.Span.End <= diagnostic.Span.Start {
		t.Fatalf("invalid declaration span: %+v", diagnostic)
	}
	if got := string(source.Data[diagnostic.Span.Start:diagnostic.Span.End]); got != key {
		t.Errorf("primary span = %q, want foreign key %q", got, key)
	}
	if diagnostic.Fix != nil {
		t.Errorf("ownership violation offers an automatic semantic fix: %+v", diagnostic.Fix)
	}
	for _, part := range []string{source.Role + "_", "komodo"} {
		if !strings.Contains(diagnostic.Message+" "+diagnostic.Expected, part) {
			t.Errorf("diagnostic lacks ownership hint %q: %+v", part, diagnostic)
		}
	}
	owner := project.Sources[ownerPath]
	if owner == nil {
		t.Fatalf("owning defaults not loaded: %s", ownerPath)
	}
	for _, related := range diagnostic.Related {
		if related.Path != ownerPath {
			continue
		}
		if related.Span.Start < 0 || related.Span.End > len(owner.Data) || related.Span.End <= related.Span.Start || related.Message == "" {
			t.Fatalf("invalid owning-role related location: %+v", related)
		}
		return
	}
	t.Errorf("diagnostic lacks related owning defaults %s: %+v", ownerPath, diagnostic)
}

func TestRoleVariablePrefixOwnership(t *testing.T) {
	owner := prefixFixture(t, "komodo.defaults.yml")
	for _, test := range []struct {
		name, path, input, owner string
		keys                     []string
	}{
		{"foreign instance prefix", "roles/periphery/defaults/main.yml", "komodo_extra: value\n", owner, []string{"komodo_extra"}},
		{"foreign role name", "roles/periphery/defaults/main.yml", "komodo_name: foreign-name\n", owner, []string{"komodo_name"}},
		{"foreign role-default prefix", "roles/periphery/defaults/main.yml", "komodo_role_extra: value\n", owner, []string{"komodo_role_extra"}},
		{"overlapping companion", "roles/komodo_periphery/defaults/main.yml", prefixFixture(t, "komodo_periphery.bad.yml"), owner, []string{"komodo_periphery_name", "komodo_periphery_role_docker_container"}},
		{"custom instance still violates ownership", "roles/komodo_periphery/defaults/main.yml", prefixFixture(t, "komodo_periphery.bad.yml"), strings.Replace(owner, "komodo_name: komodo", "komodo_name: control", 1), []string{"komodo_periphery_name", "komodo_periphery_role_docker_container"}},
		{"dynamic instance still violates ownership", "roles/periphery/defaults/main.yml", "komodo_extra: '{{ left if enabled else right }}'\n", "komodo_name: '{{ inventory_name }}'\n", []string{"komodo_extra"}},
		{"quoted key keeps exact span", "roles/periphery/defaults/main.yml", "'komodo_extra': value # preserve\n", owner, []string{"'komodo_extra'"}},
		{"resource companion", "resources/roles/periphery/defaults/private/options.yml", "komodo_extra: value\n", owner, []string{"komodo_extra"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			project := prefixProject(t, map[string]string{
				prefixOwnerDefaults:           test.owner,
				"roles/komodo/tasks/main.yml": prefixFixture(t, "komodo.tasks.yml"),
				test.path:                     test.input,
			})
			diagnostics := Analyze(project, prefixRules())
			if len(diagnostics) != len(test.keys) {
				t.Fatalf("ownership diagnostics = %+v, want keys %v", diagnostics, test.keys)
			}
			for index, key := range test.keys {
				assertPrefixViolation(t, project, diagnostics[index], test.path, key, prefixOwnerDefaults)
			}
		})
	}
}

func TestRoleVariablePrefixOwnershipAllowsSeparateDeclarationsAndReads(t *testing.T) {
	project := prefixProject(t, map[string]string{
		prefixOwnerDefaults:           prefixFixture(t, "komodo.defaults.yml"),
		"roles/komodo/tasks/main.yml": prefixFixture(t, "komodo.tasks.yml"),
		"roles/periphery/defaults/main.yml": prefixFixture(t, "periphery.good.yml") +
			"komodox_extra: lexical prefix only\nkomodo: scalar without namespace separator\n" +
			"periphery_role_nested:\n  komodo_extra: nested data\n" +
			"periphery_role_literal: |-\n  komodo_extra: literal data\n" +
			"periphery_role_quoted: 'komodo_role_extra: literal text'\n" +
			"# komodo_extra: comment\n",
		"inventory.yml":      "komodo_extra: intentional override\nkomodo_name: control\n",
		"group_vars/all.yml": "komodo_role_extra: intentional override\n",
	})
	if diagnostics := Analyze(project, prefixRules()); len(diagnostics) != 0 {
		t.Fatalf("valid declarations and cross-role reads diagnosed: %+v", diagnostics)
	}
}

func TestRoleVariablePrefixOwnershipDoesNotInventMissingRoles(t *testing.T) {
	for _, files := range []map[string]string{
		{"roles/periphery/defaults/main.yml": "komodo_extra: value\n"},
		{"roles/komodo_periphery/defaults/main.yml": prefixFixture(t, "komodo_periphery.bad.yml")},
		{
			"roles/periphery/defaults/main.yml": "komodo_extra: value\n",
			"inventory.yml":                     "komodo_name: komodo\nkomodo_role_extra: override\n",
		},
	} {
		project := prefixProject(t, files)
		if diagnostics := Analyze(project, prefixRules()); len(diagnostics) != 0 {
			t.Fatalf("missing role ownership was invented: %+v", diagnostics)
		}
	}
}

func TestRoleVariablePrefixOwnershipSameRoleInBothRoots(t *testing.T) {
	project := prefixProject(t, map[string]string{
		prefixOwnerDefaults:                        prefixFixture(t, "komodo.defaults.yml"),
		"resources/roles/komodo/defaults/main.yml": "komodo_name: komodo\nkomodo_role_extra: value\n",
	})
	if diagnostics := Analyze(project, prefixRules()); len(diagnostics) != 0 {
		t.Fatalf("same role name was treated as another namespace owner: %+v", diagnostics)
	}
}

func TestRoleVariablePrefixOwnershipRecomputesContext(t *testing.T) {
	const foreign = "roles/komodo_periphery/defaults/main.yml"
	project := prefixProject(t, map[string]string{foreign: prefixFixture(t, "komodo_periphery.bad.yml")})
	if diagnostics := Analyze(project, prefixRules()); len(diagnostics) != 0 {
		t.Fatalf("absent owner diagnosed: %+v", diagnostics)
	}
	owner := prefixProject(t, map[string]string{prefixOwnerDefaults: prefixFixture(t, "komodo.defaults.yml")}).Sources[prefixOwnerDefaults]
	project.Sources[prefixOwnerDefaults] = owner
	project.Selected[prefixOwnerDefaults] = false
	diagnostics := Analyze(project, prefixRules())
	if len(diagnostics) != 2 {
		t.Fatalf("added context was not used: %+v", diagnostics)
	}
	for index, key := range []string{"komodo_periphery_name", "komodo_periphery_role_docker_container"} {
		assertPrefixViolation(t, project, diagnostics[index], foreign, key, prefixOwnerDefaults)
	}
	delete(project.Sources, prefixOwnerDefaults)
	if diagnostics := Analyze(project, prefixRules()); len(diagnostics) != 0 {
		t.Fatalf("removed owner left stale namespace facts: %+v", diagnostics)
	}
}

func TestRoleVariablePrefixOwnershipSelectedFileLoadsContext(t *testing.T) {
	for _, ownerPath := range []string{prefixOwnerDefaults, "resources/roles/komodo/defaults/main.yml"} {
		t.Run(ownerPath, func(t *testing.T) {
			for _, test := range []struct {
				name, path, input string
				keys              []string
			}{
				{"overlap", "roles/komodo_periphery/defaults/main.yml", prefixFixture(t, "komodo_periphery.bad.yml"), []string{"komodo_periphery_name", "komodo_periphery_role_docker_container"}},
				{"disjoint", "roles/periphery/defaults/main.yml", "komodo_extra: value\nkomodo_role_extra: value\n", []string{"komodo_extra", "komodo_role_extra"}},
			} {
				t.Run(test.name, func(t *testing.T) {
					root := t.TempDir()
					foreign := test.path
					writeTestSource(t, filepath.Join(root, ownerPath), prefixFixture(t, "komodo.defaults.yml")+"foreign_role_value: invalid context-only key\n")
					writeTestSource(t, filepath.Join(root, foreign), test.input)
					project, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, foreign)}, IncludeAnalysis: true})
					if err != nil {
						t.Fatal(err)
					}
					if project.Selected[ownerPath] || !project.Selected[foreign] {
						t.Fatalf("context widened selected files: %+v", project.Selected)
					}
					diagnostics := Analyze(project, prefixRules())
					if len(diagnostics) != len(test.keys) {
						t.Fatalf("selected source missed ownership context: %+v", diagnostics)
					}
					for index, key := range test.keys {
						assertPrefixViolation(t, project, diagnostics[index], foreign, key, ownerPath)
					}
					if project.Dependencies == nil || len(project.Dependencies.Sources) != 1 {
						t.Fatalf("missing selected-source dependency record: %+v", project.Dependencies)
					}
					if !slices.ContainsFunc(project.Dependencies.Sources[0].Files, func(file DependencyFile) bool {
						return file.Path == ownerPath && file.State == "read" && file.SHA256 != ""
					}) {
						t.Fatalf("owner defaults missing from invalidation dependencies: %+v", project.Dependencies.Sources[0])
					}
				})
			}
		})
	}
}

func TestRoleVariablePrefixOwnershipTracksMissingOwnerContext(t *testing.T) {
	root := t.TempDir()
	const foreign = "roles/komodo_periphery/defaults/main.yml"
	writeTestSource(t, filepath.Join(root, foreign), prefixFixture(t, "komodo_periphery.bad.yml"))
	options := Options{Root: root, Paths: []string{filepath.Join(root, foreign)}, IncludeAnalysis: true}
	before, err := Load(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics := Analyze(before, prefixRules()); len(diagnostics) != 0 {
		t.Fatalf("absent owner diagnosed: %+v", diagnostics)
	}
	if before.Dependencies == nil || len(before.Dependencies.Sources) != 1 {
		t.Fatalf("missing dependency record: %+v", before.Dependencies)
	}
	for _, directory := range []string{"roles/komodo/defaults", "resources/roles/komodo/defaults"} {
		if !slices.ContainsFunc(before.Dependencies.Sources[0].Directories, func(observed DependencyDirectory) bool {
			return observed.Path == directory && observed.State == "missing"
		}) {
			t.Errorf("new owning defaults will not invalidate %s: %+v", directory, before.Dependencies.Sources[0])
		}
	}
	writeTestSource(t, filepath.Join(root, prefixOwnerDefaults), prefixFixture(t, "komodo.defaults.yml"))
	after, err := Load(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	if after.Dependencies == nil || after.Dependencies.Generation == before.Dependencies.Generation {
		t.Fatalf("new owner did not change dependency generation: %+v", after.Dependencies)
	}
	diagnostics := Analyze(after, prefixRules())
	if len(diagnostics) != 2 {
		t.Fatalf("new owner context was not detected: %+v", diagnostics)
	}
	for index, key := range []string{"komodo_periphery_name", "komodo_periphery_role_docker_container"} {
		assertPrefixViolation(t, after, diagnostics[index], foreign, key, prefixOwnerDefaults)
	}
}

func TestRoleVariablePrefixOwnershipRequiresValidConventionalRoleContext(t *testing.T) {
	for _, test := range []struct {
		name, ownerPath, input string
		wantOwnership          bool
	}{
		{"tasks establish ownership", "roles/komodo/tasks/main.yml", "- name: Known owning role\n  ansible.builtin.debug:\n    msg: owner\n", true},
		{"handlers establish ownership", "roles/komodo/handlers/main.yml", "- name: Known owning role\n  ansible.builtin.debug:\n    msg: owner\n", true},
		{"vars establish ownership", "roles/komodo/vars/main.yml", "komodo_role_settings: value\n", true},
		{"raw template alone is incomplete", "roles/komodo/templates/main.yml.j2", "{{ komodo_name }}\n", false},
		{"malformed defaults are incomplete", prefixOwnerDefaults, "komodo_name: [\n", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			const foreign = "roles/periphery/defaults/main.yml"
			writeTestSource(t, filepath.Join(root, foreign), "komodo_extra: value\n")
			writeTestSource(t, filepath.Join(root, test.ownerPath), test.input)
			options := Options{Root: root, Paths: []string{filepath.Join(root, foreign)}}
			project, err := Load(t.Context(), options)
			if err != nil {
				t.Fatal(err)
			}
			diagnostics := Analyze(project, prefixRules())
			if !test.wantOwnership {
				if len(diagnostics) != 0 {
					t.Fatalf("incomplete context invented ownership or leaked context diagnostics: %+v", diagnostics)
				}
				full, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
				if err != nil {
					t.Fatal(err)
				}
				for _, diagnostic := range Analyze(full, prefixRules()) {
					if diagnostic.RuleID == "role-variable-prefix" && diagnostic.Path == foreign {
						t.Fatalf("directory selection invented ownership: %+v", diagnostic)
					}
				}
				return
			}
			if len(diagnostics) != 1 {
				t.Fatalf("valid conventional source did not establish owning role: %+v", diagnostics)
			}
			assertPrefixViolation(t, project, diagnostics[0], foreign, "komodo_extra", test.ownerPath)
		})
	}
}

func TestRoleVariablePrefixOwnershipRelatedCapturedReads(t *testing.T) {
	const foreign = "roles/komodo_periphery/defaults/main.yml"
	const parentTasks = "roles/komodo/tasks/main.yml"
	const call = "lookup('role_var', '_periphery_name', role='komodo')"
	project := prefixProject(t, map[string]string{
		prefixOwnerDefaults: prefixFixture(t, "komodo.defaults.yml"),
		parentTasks:         prefixFixture(t, "komodo.tasks.yml"),
		foreign:             prefixFixture(t, "komodo_periphery.bad.yml"),
	})
	diagnostics := Analyze(project, prefixRules())
	if len(diagnostics) != 2 {
		t.Fatalf("captured declarations missed: %+v", diagnostics)
	}
	for _, path := range []string{parentTasks, foreign} {
		source := project.Sources[path]
		start := strings.Index(string(source.Data), call)
		want := Span{start, start + len(call)}
		if !slices.ContainsFunc(diagnostics[0].Related, func(related RelatedLocation) bool {
			return related.Path == path && related.Span == want && strings.Contains(related.Message, "role_var")
		}) {
			t.Errorf("name collision lacks exact related read in %s: %+v", path, diagnostics[0])
		}
	}
	if len(diagnostics[0].Related) != 3 {
		t.Errorf("name collision related locations = %+v, want owner and two literal reads", diagnostics[0].Related)
	}
	if len(diagnostics[1].Related) != 1 {
		t.Errorf("container declaration gained an unrelated name read: %+v", diagnostics[1].Related)
	}
}

func TestRoleVariablePrefixOwnershipRelatedReadsRespectStaticBoundaries(t *testing.T) {
	const foreign = "roles/periphery/defaults/main.yml"
	for _, test := range []struct {
		name, value string
	}{
		{"dynamic target", "{{ lookup('role_var', '_extra', role=owner) }}"},
		{"dynamic suffix", "{{ lookup('role_var', suffix, role='komodo') }}"},
		{"local callee", "{% with lookup=caller_function %}{{ lookup('role_var', '_extra', role='komodo') }}{% endwith %}"},
		{"attribute callee", "{{ module.lookup('role_var', '_extra', role='komodo') }}"},
		{"external plugin", "{{ lookup('external', '_extra', role='komodo') }}"},
		{"implicit target", "{{ lookup('role_var', '_extra') }}"},
		{"different owner", "{{ lookup('role_var', '_extra', role='other') }}"},
		{"literal text", "lookup('role_var', '_extra', role='komodo')"},
		{"Jinja comment", "{# lookup('role_var', '_extra', role='komodo') #}"},
	} {
		t.Run(test.name, func(t *testing.T) {
			project := prefixProject(t, map[string]string{
				prefixOwnerDefaults: prefixFixture(t, "komodo.defaults.yml"),
				foreign:             "komodo_extra: value\nperiphery_role_read: \"" + test.value + "\"\n",
			})
			diagnostics := Analyze(project, prefixRules())
			if len(diagnostics) != 1 {
				t.Fatalf("foreign declaration diagnosed incorrectly: %+v", diagnostics)
			}
			assertPrefixViolation(t, project, diagnostics[0], foreign, "komodo_extra", prefixOwnerDefaults)
			if len(diagnostics[0].Related) != 1 {
				t.Errorf("uncertain/external expression was presented as a related read: %+v", diagnostics[0].Related)
			}
		})
	}
}

func TestRoleVariablePrefixOwnershipUnrelatedCallersPreserveSelectionParity(t *testing.T) {
	root := t.TempDir()
	const foreign = "roles/komodo_periphery/defaults/main.yml"
	const parentTasks = "roles/komodo/tasks/main.yml"
	const caller = "roles/unrelated/tasks/main.yml"
	writeTestSource(t, filepath.Join(root, prefixOwnerDefaults), prefixFixture(t, "komodo.defaults.yml"))
	writeTestSource(t, filepath.Join(root, parentTasks), prefixFixture(t, "komodo.tasks.yml"))
	writeTestSource(t, filepath.Join(root, foreign), prefixFixture(t, "komodo_periphery.bad.yml"))
	writeTestSource(t, filepath.Join(root, caller), "- debug:\n    msg: \"{{ lookup('role_var', '_periphery_name', role='komodo') }}\"\n")
	selected, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, foreign)}})
	if err != nil {
		t.Fatal(err)
	}
	if selected.Sources[caller] != nil {
		t.Fatal("unrelated caller was loaded as namespace context")
	}
	full, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	full.Selected = selected.Selected
	got, want := Analyze(selected, prefixRules()), Analyze(full, prefixRules())
	if len(got) != 2 || !reflect.DeepEqual(got, want) {
		t.Fatalf("selected/full related locations differ: %+v / %+v", got, want)
	}
	for _, diagnostic := range got {
		if slices.ContainsFunc(diagnostic.Related, func(related RelatedLocation) bool { return related.Path == caller }) {
			t.Fatalf("unrelated caller widened diagnostic: %+v", diagnostic)
		}
	}
}

func TestRoleVariablePrefixOwnershipChangedSinceOwnerLifecycle(t *testing.T) {
	for _, rename := range []bool{false, true} {
		t.Run(map[bool]string{false: "remove", true: "rename"}[rename], func(t *testing.T) {
			root := changedFixture(t)
			const foreign = "roles/komodo_periphery/defaults/main.yml"
			putFile(t, root, foreign, prefixFixture(t, "komodo_periphery.bad.yml"))
			commitChangedFixture(t, root)
			baseline := strings.TrimSpace(string(gitReadTest(t, root, "rev-parse", "HEAD")))
			putFile(t, root, prefixOwnerDefaults, prefixFixture(t, "komodo.defaults.yml"))
			added := loadChangedTest(t, root, baseline)
			if !added.Selected[foreign] {
				t.Fatalf("new owner did not select existing foreign declarations: %+v", added.Selection)
			}
			diagnostics := slices.DeleteFunc(Analyze(added, prefixRules()), func(diagnostic Diagnostic) bool { return diagnostic.Path != foreign })
			if len(diagnostics) != 2 {
				t.Fatalf("new owner did not expose both collisions: %+v", diagnostics)
			}
			commitChangedFixture(t, root)
			const renamed = "resources/roles/komodo/defaults/main.yml"
			if rename {
				putFile(t, root, renamed, prefixFixture(t, "komodo.defaults.yml"))
			}
			if err := os.Remove(filepath.Join(root, prefixOwnerDefaults)); err != nil {
				t.Fatal(err)
			}
			changed := loadChangedTest(t, root, "HEAD")
			if !changed.Selected[foreign] || changed.Selection.Fallback == "" {
				t.Fatalf("removed owner did not select affected foreign declarations: %+v", changed.Selection)
			}
			diagnostics = slices.DeleteFunc(Analyze(changed, prefixRules()), func(diagnostic Diagnostic) bool { return diagnostic.Path != foreign })
			if !rename {
				if len(diagnostics) != 0 {
					t.Fatalf("removed owner left stale collisions: %+v", diagnostics)
				}
				return
			}
			if len(diagnostics) != 2 {
				t.Fatalf("relocated owner lost namespace ownership: %+v", diagnostics)
			}
			for index, key := range []string{"komodo_periphery_name", "komodo_periphery_role_docker_container"} {
				assertPrefixViolation(t, changed, diagnostics[index], foreign, key, renamed)
				if slices.ContainsFunc(diagnostics[index].Related, func(related RelatedLocation) bool { return related.Path == prefixOwnerDefaults }) {
					t.Errorf("relocated owner retained stale related path: %+v", diagnostics[index])
				}
			}
		})
	}
}
