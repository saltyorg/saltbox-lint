package lint

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func duplicateRules() []Rule {
	return slices.DeleteFunc(Rules(), func(rule Rule) bool { return rule.ID != "variable-duplicate" })
}

func TestVariableDuplicateFixtures(t *testing.T) {
	for _, name := range []string{"duplicate.bad.yml", "unique.good.yml"} {
		input, err := os.ReadFile("testdata/variables/" + name)
		if err != nil {
			t.Fatal(err)
		}
		project := defaultsProject(t, "roles/example/defaults/main.yml", string(input))
		ds := Analyze(project, duplicateRules())
		want := 0
		if strings.Contains(name, ".bad.") {
			want = 2
		}
		if len(ds) != want {
			t.Fatalf("%s diagnostics=%+v", name, ds)
		}
	}
}

func TestVariableDuplicatesAcrossDeclarationSources(t *testing.T) {
	for _, context := range []string{
		"roles/other/defaults/main.yml", "resources/roles/other/defaults/extra.yml",
		"roles/example/defaults/extra.yml", "roles/other/vars/main.yml", "vars.yml",
		"group_vars/all.yml", "host_vars/remote.yml", "inventories/prod/group_vars/all.yml",
	} {
		t.Run(context, func(t *testing.T) {
			const primary = "roles/example/defaults/main.yml"
			project := prefixProject(t, map[string]string{primary: "shared_value: same\n", context: "'shared_value': same\n"})
			ds := Analyze(project, duplicateRules())
			if len(ds) != 2 {
				t.Fatalf("same-value duplicate not diagnosed on both declarations: %+v", ds)
			}
			for _, d := range ds {
				if d.Fix != nil || len(d.Related) != 1 || !strings.Contains(d.Message, "shared_value") || d.Expected == "" {
					t.Fatalf("incomplete duplicate diagnostic: %+v", d)
				}
				if got := string(project.Sources[d.Related[0].Path].Data[d.Related[0].Span.Start:d.Related[0].Span.End]); strings.Trim(got, "'") != "shared_value" {
					t.Fatalf("related span = %q", got)
				}
			}
		})
	}
}

func TestVariableDuplicatesExcludeTasksAndLocalhostOverrides(t *testing.T) {
	for _, file := range []struct{ name, contents string }{
		{"roles/example/tasks/main.yml", "- set_fact: {shared_value: override}\n- debug: {msg: ok}\n  vars: {shared_value: local}\n"},
		{"roles/example/handlers/main.yml", "- set_fact: {shared_value: override}\n"},
		{"localhost.yml", "shared_value: override\n"},
		{"inventories/host_vars/localhost.yml", "shared_value: override\n"},
		{"host_vars/localhost.yml", "shared_value: override\n"},
		{"roles/example/templates/data.yml.j2", "shared_value: literal\n"},
		{"roles/other/defaults/main.yml", "other_value:\n  shared_value: nested\n"},
	} {
		project := prefixProject(t, map[string]string{"roles/example/defaults/main.yml": "shared_value: default\n", file.name: file.contents})
		if ds := Analyze(project, duplicateRules()); len(ds) != 0 {
			t.Fatalf("excluded variable in %s was checked: %+v", file.name, ds)
		}
	}
}

func TestVariableDuplicatesInventoryIdentitiesAndVariables(t *testing.T) {
	const inventory = "all:\n  vars:\n    shared_value: group\n  children:\n    services:\n      hosts:\n        shared_value:\n          host_value: host\n"
	project := prefixProject(t, map[string]string{
		"inventory.yml": inventory,
		"vars.yml":      "shared_value: default\nhost_value: default\nall: data\nservices: data\n",
	})
	ds := Analyze(project, duplicateRules())
	if len(ds) != 4 {
		t.Fatalf("inventory identities mistaken for variable declarations: %+v", ds)
	}
	for _, d := range ds {
		if strings.Contains(d.Message, `"all"`) || strings.Contains(d.Message, `"services"`) {
			t.Fatalf("inventory identity diagnosed: %+v", d)
		}
	}
}

func TestVariableDuplicatesIgnoreYAMLMergeDirectives(t *testing.T) {
	project := prefixProject(t, map[string]string{
		"roles/a/defaults/main.yml": "a_role_options: &options\n  a_setting: value\n<<: *options\n",
		"roles/b/defaults/main.yml": "b_role_options: &options\n  b_setting: value\n<<: *options\n",
	})
	if ds := Analyze(project, duplicateRules()); len(ds) != 0 {
		t.Fatalf("YAML merge directives were treated as variable declarations: %+v", ds)
	}
}

func TestVariableDuplicatesSelectedAndFullParity(t *testing.T) {
	root := t.TempDir()
	const primary = "roles/example/defaults/main.yml"
	writeTestSource(t, filepath.Join(root, primary), "shared_value: default\n")
	const context = "roles/unrelated/vars/extra.yml"
	writeTestSource(t, filepath.Join(root, context), "shared_value: other\n")
	const tasks = "roles/unrelated/tasks/main.yml"
	writeTestSource(t, filepath.Join(root, tasks), "- set_fact: {shared_value: task}\n")
	selected, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, primary)}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	if selected.Selected[context] || selected.Sources[tasks] != nil {
		t.Fatal("duplicate context widened selection or admitted unrelated tasks")
	}
	full, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	full.Selected = selected.Selected
	got, want := Analyze(selected, duplicateRules()), Analyze(full, duplicateRules())
	if len(got) != 1 || !reflect.DeepEqual(got, want) {
		t.Fatalf("selected/full duplicate checks differ: %+v / %+v", got, want)
	}
	if !slices.ContainsFunc(selected.Dependencies.Sources[0].Files, func(file DependencyFile) bool {
		return file.Path == context && file.State == "read" && file.SHA256 != ""
	}) {
		t.Fatal("duplicate context missing from dependency hashes")
	}
	before := selected.Dependencies.Generation
	if err := os.Remove(filepath.Join(root, context)); err != nil {
		t.Fatal(err)
	}
	after, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, primary)}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	if after.Dependencies.Generation == before || len(Analyze(after, duplicateRules())) != 0 {
		t.Fatal("removed duplicate left stale dependency facts")
	}
}

func TestVariableDuplicatesSelectedVarsAndInventory(t *testing.T) {
	for _, primary := range []string{"vars.yml", "group_vars/all.yml", "roles/example/vars/main.yml", "inventory.yml"} {
		t.Run(primary, func(t *testing.T) {
			root := t.TempDir()
			contents := "shared_value: primary\n"
			if primary == "inventory.yml" {
				contents = "all:\n  vars:\n    shared_value: primary\n"
			}
			writeTestSource(t, filepath.Join(root, primary), contents)
			writeTestSource(t, filepath.Join(root, "roles/other/defaults/main.yml"), "shared_value: other\n")
			writeTestSource(t, filepath.Join(root, "inventories/host_vars/localhost.yml"), "shared_value: user-override\n")
			project, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, primary)}})
			if err != nil {
				t.Fatal(err)
			}
			if ds := Analyze(project, duplicateRules()); len(ds) != 1 || len(ds[0].Related) != 1 {
				t.Fatalf("selected vars/inventory duplicate or user override checked incorrectly: %+v", ds)
			}
		})
	}
}

func TestVariableDuplicateDependencyScopesKeepTemplateOwnersSeparate(t *testing.T) {
	root := t.TempDir()
	primary := putFile(t, root, "roles/example/defaults/main.yml", "example_role_enabled: true\n")
	putFile(t, root, "roles/example/tasks/main.yml", "- template: {src: config.yml.j2, dest: /tmp/config}\n")
	const template = "roles/example/templates/config.yml.j2"
	putFile(t, root, template, "{{ example_role_enabled }}\n")
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{primary}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	record := project.Dependencies.Sources[0]
	if !slices.ContainsFunc(record.Files, func(file DependencyFile) bool { return file.Path == template && file.State == "read" }) {
		t.Fatal("owning-role template dependency was lost")
	}
	for _, directory := range record.Directories {
		if directory.VariablesOnly {
			for _, member := range directory.Members {
				if !variableDeclarationPath(member) {
					t.Fatalf("template owner leaked into variable-only members: %+v", directory)
				}
			}
		}
	}
}

func TestVariableDuplicateDependencyScopesRetainTemplateAliasCandidates(t *testing.T) {
	root := t.TempDir()
	primary := putFile(t, root, "roles/example/defaults/main.yml", "example_role_enabled: true\n")
	target := putFile(t, root, "roles/example/templates/config.yml.j2", "{{ example_role_enabled }}\n")
	const alias = "roles/example/defaults/alias.yml"
	templateAlias(t, root, alias, target)
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{primary}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	if project.Sources[alias] == nil || project.Sources[alias].Kind != Template {
		t.Fatal("fixture must retain the physical template identity")
	}
	if !slices.ContainsFunc(project.Dependencies.Sources[0].Directories, func(directory DependencyDirectory) bool {
		return directory.Path == "roles" && directory.VariablesOnly && slices.Contains(directory.Members, alias)
	}) {
		t.Fatal("template alias candidate is missing from its lexical declaration scope")
	}
	if ds := Analyze(project, duplicateRules()); len(ds) != 0 {
		t.Fatalf("template alias was treated as a declaration: %+v", ds)
	}
}

func TestVariableDuplicatesNewSourceAffectedSelection(t *testing.T) {
	root := changedFixture(t)
	const primary = "roles/example/defaults/main.yml"
	putFile(t, root, primary, "shared_value: default\n")
	putFile(t, root, "roles/unrelated/defaults/main.yml", "unrelated_role_enabled: true\n")
	commitChangedFixture(t, root)
	putFile(t, root, "group_vars/extra.yml", "shared_value: override\n")
	project := loadChangedTest(t, root, "HEAD")
	if !project.Selected[primary] {
		t.Fatal("new duplicate did not select the existing variable declaration")
	}
	if ds := Analyze(project, duplicateRules()); len(ds) != 2 {
		t.Fatalf("new duplicate was not diagnosed on both selected files: %+v", ds)
	}
}

func TestVariableDuplicateInvalidPrimaryObservesOnlyItsRecovery(t *testing.T) {
	root := t.TempDir()
	const invalid = "roles/broken/defaults/main.yml"
	putFile(t, root, invalid, "broken_value: [\n")
	putFile(t, root, "roles/peer/defaults/main.yml", "peer_role_enabled: true\n")
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, invalid)}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	if project.Sources["roles/peer/defaults/main.yml"] != nil {
		t.Fatal("invalid primary loaded unrelated duplicate context")
	}
	for _, directory := range project.Dependencies.Sources[0].Directories {
		if directory.VariablesOnly {
			t.Fatal("invalid primary observes unrelated declaration changes")
		}
	}
	putFile(t, root, invalid, "peer_role_enabled: recovered\n")
	project, err = Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, invalid)}, IncludeAnalysis: true})
	if err != nil {
		t.Fatal(err)
	}
	if ds := Analyze(project, duplicateRules()); len(ds) != 1 {
		t.Fatalf("recovery did not admit duplicate context: %+v", ds)
	}
}
