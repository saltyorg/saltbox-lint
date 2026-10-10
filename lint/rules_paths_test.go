package lint

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const pathsBanner = "################################\n# Paths\n################################\n\n"

func pathsRules() []Rule {
	return slices.DeleteFunc(Rules(), func(rule Rule) bool { return rule.ID != "paths-role-var" })
}

func pathsFixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "paths-lookups", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func pathsDiagnostics(t *testing.T, path, input string) (*Project, []Diagnostic) {
	t.Helper()
	source, parseDiagnostics := Parse(path, []byte(input))
	if len(parseDiagnostics) != 0 {
		t.Fatalf("invalid fixture: %+v", parseDiagnostics)
	}
	project := &Project{Root: "/project", Sources: map[string]*Source{path: source}, Selected: map[string]bool{path: true}}
	return project, Analyze(project, pathsRules())
}

func assertPathsDiagnostics(t *testing.T, path, input string, calls ...string) {
	t.Helper()
	project, diagnostics := pathsDiagnostics(t, path, input)
	if len(diagnostics) != len(calls) {
		t.Fatalf("paths-role-var diagnostics = %+v, want calls %q", diagnostics, calls)
	}
	for index, diagnostic := range diagnostics {
		if diagnostic.Path != path || diagnostic.RuleID != "paths-role-var" || diagnostic.Severity != "error" {
			t.Fatalf("unexpected Paths diagnostic: %+v", diagnostic)
		}
		if diagnostic.Span.Start < 0 || diagnostic.Span.End > len(input) || diagnostic.Span.End <= diagnostic.Span.Start {
			t.Fatalf("invalid Paths call span: %+v", diagnostic)
		}
		if got := input[diagnostic.Span.Start:diagnostic.Span.End]; got != calls[index] {
			t.Errorf("primary span = %q, want call %q", got, calls[index])
		}
		if diagnostic.Message == "" || diagnostic.Expected == "" || !strings.Contains(diagnostic.Expected, "direct") {
			t.Errorf("missing direct-reference guidance: %+v", diagnostic)
		}
		if diagnostic.Fix != nil || diagnostic.Preview != nil {
			t.Errorf("Paths lookup prohibition offers a semantic replacement: %+v", diagnostic)
		}
	}
	changes, err := PlanFixes(project, diagnostics)
	if err != nil || len(changes) != 0 {
		t.Errorf("semantic Paths diagnostics generated changes: %+v, %v", changes, err)
	}
	if !bytes.Equal(project.Sources[path].Data, []byte(input)) {
		t.Error("Paths analysis changed source bytes")
	}
}

func TestPathsRoleVarRejectsLookup(t *testing.T) {
	const path = "roles/example/defaults/main.yml"
	input := pathsBanner + "example_role_paths_location: \"{{ lookup('role_var', '_paths_folder', role='example') }}\"\n"
	project := defaultsProject(t, path, input)
	diagnostics := Analyze(project, pathsRules())
	if len(diagnostics) != 1 {
		t.Fatalf("paths-role-var diagnostics = %+v, want one lookup violation", diagnostics)
	}
}

func TestPathsRoleVarFixtures(t *testing.T) {
	assertPathsDiagnostics(t, "roles/example/defaults/main.yml", pathsFixture(t, "canonical.good.yml"))
	assertPathsDiagnostics(t, "roles/example/defaults/main.yml", pathsFixture(t, "lookups.bad.yml"),
		"lookup('role_var', '_paths_folder', role='example')",
		"query('role_var', '_paths_location', role='example')",
		"q('role_var', '_paths_location', role='example')",
		"lookup(\n       'role_var', '_paths_location', role='other')",
	)
}

func TestPathsRoleVarLookupForms(t *testing.T) {
	const path = "resources/roles/example/defaults/nested/options.yaml"
	for _, test := range []struct {
		name, value, call string
	}{
		{"lookup", "\"{{ lookup('role_var', '_paths_folder', role='example') }}\"", "lookup('role_var', '_paths_folder', role='example')"},
		{"query", "\"{{ query('role_var', suffix, role=target) }}\"", "query('role_var', suffix, role=target)"},
		{"q", "\"{{ q('role_var') }}\"", "q('role_var')"},
		{"cross-role", "\"{{ lookup('role_var', '_paths_location', role='postgres') }}\"", "lookup('role_var', '_paths_location', role='postgres')"},
		{"no target", "\"{{ lookup('role_var', '_paths_location') }}\"", "lookup('role_var', '_paths_location')"},
		{"namespaced lookup plugin", "\"{{ lookup('saltbox.role_var', suffix, role=target) }}\"", "lookup('saltbox.role_var', suffix, role=target)"},
		{"namespaced query plugin", "\"{{ query('saltbox.lookups.role_var', '_paths_folder', role='example') }}\"", "query('saltbox.lookups.role_var', '_paths_folder', role='example')"},
		{"single quoted YAML", "'{{ lookup(''role_var'', ''_paths_folder'', role=''example'') }}'", "lookup(''role_var'', ''_paths_folder'', role=''example'')"},
		{"escaped YAML quotes", `"{{ lookup(\"role_var\", \"_paths_folder\", role=\"example\") }}"`, `lookup(\"role_var\", \"_paths_folder\", role=\"example\")`},
		{"nested call", "\"{{ value | default(lookup('role_var', '_paths_folder', role='example')) }}\"", "lookup('role_var', '_paths_folder', role='example')"},
		{"statement", `'{% set path = lookup("role_var", "_paths_folder", role="example") %}{{ path }}'`, `lookup("role_var", "_paths_folder", role="example")`},
		{"literal block", "|-\n  {{ lookup('role_var', '_paths_folder', role='example') }}", "lookup('role_var', '_paths_folder', role='example')"},
		{"folded block", ">-\n  {{ lookup(\n       'role_var', '_paths_folder', role='example') }}", "lookup(\n       'role_var', '_paths_folder', role='example')"},
		{"anchored value", "&path \"{{ lookup('role_var', '_paths_folder', role='example') }}\"\nexample_role_paths_alias: *path", "lookup('role_var', '_paths_folder', role='example')"},
	} {
		t.Run(test.name, func(t *testing.T) {
			assertPathsDiagnostics(t, path, pathsBanner+"example_role_paths_location: "+test.value+"\n", test.call)
		})
	}
}

func TestPathsRoleVarSectionBoundaries(t *testing.T) {
	const call = "lookup('role_var', '_paths_location', role='example')"
	value := "example_role_value: \"{{ " + call + " }}\"\n"
	customBanner := "################################\n# Application settings\n################################\n\n"
	dockerBanner := "################################\n# Docker\n################################\n\n"
	for _, test := range []struct {
		name, input string
		calls       []string
	}{
		{"file end", pathsBanner + value, []string{call}},
		{"custom next section", pathsBanner + "example_role_paths_location: /data\n\n" + customBanner + value, nil},
		{"canonical next section", pathsBanner + "example_role_paths_location: /data\n\n" + dockerBanner + value, nil},
		{"Paths after another section", customBanner + "example_role_setting: enabled\n\n" + pathsBanner + value, []string{call}},
		{"duplicate Paths sections", pathsBanner + value + customBanner + "other: value\n\n" + pathsBanner + strings.Replace(value, "example_role_value:", "example_role_other:", 1), []string{call, call}},
		{"shared section border", strings.TrimSuffix(pathsBanner, "################################\n\n") + "################################\n# Docker\n################################\n\n" + value, nil},
		{"ordinary comment within Paths", pathsBanner + "# Application settings\n" + value, []string{call}},
		{"ordinary Paths comment", "# Paths\n" + value, nil},
		{"header mention", "# Title: Example Paths\n# Paths are defined below\n" + value, nil},
		{"misnamed section", "################################\n# paths\n################################\n\n" + value, nil},
		{"quoted banner", "example_role_note: \"start\n" + pathsBanner + "end\"\n" + value, nil},
		{"literal banner", "example_role_note: |-\n  ################################\n  # Paths\n  ################################\n  documentation\n" + value, nil},
		{"literal cannot end Paths", pathsBanner + "example_role_note: |-\n  ################################\n  # Docker\n  ################################\n  documentation\n" + value, []string{call}},
		{"quoted cannot end Paths", pathsBanner + "example_role_note: \"start\n" + dockerBanner + "end\"\n" + value, []string{call}},
		{"next document resets Paths", pathsBanner + "example_role_paths_location: /data\n---\n" + value, nil},
		{"next document declares Paths", pathsBanner + "example_role_paths_location: /data\n---\n" + pathsBanner + value, []string{call}},
	} {
		t.Run(test.name, func(t *testing.T) {
			assertPathsDiagnostics(t, "roles/example/defaults/main.yml", test.input, test.calls...)
		})
	}
}

func TestPathsRoleVarIgnoresNonCalls(t *testing.T) {
	for _, value := range []string{
		`"{{ example_role_paths_location }}/config.xml"`,
		`"{{ lookup('vars', 'example_role_paths_location') }}"`,
		`"{{ lookup('role_web', role='example') }}"`,
		`"{{ lookup('saltbox.role_variable', '_paths_folder', role='example') }}"`,
		`"lookup('role_var', '_paths_folder', role='example')"`,
		`'{{ "lookup(role_var)" }}'`,
		`"{{ config.lookup('role_var', '_paths_location') }}"`,
		`"{{ values | lookup('role_var') }}"`,
		`"{{ value is lookup('role_var') }}"`,
		`"{% set lookup = other %}{{ example_role_paths_location }}"`,
		`"{% set lookup = other %}{{ lookup('role_var', '_paths_folder', role='example') }}"`,
		`"{{ lookup('role_var', '_paths_folder', role='example') }}{% set lookup = other %}"`,
		`"{% set query = other %}{{ query('role_var', '_paths_folder', role='example') }}"`,
		`"{% set q = other %}{{ q('role_var', '_paths_folder', role='example') }}"`,
		`"{% raw %}{{ lookup('role_var', '_paths_folder') }}{% endraw %}"`,
		`"{# lookup('role_var', '_paths_folder') #}{{ example_role_paths_location }}"`,
		`!unsafe "{{ lookup('role_var', '_paths_folder', role='example') }}"`,
		`"{{ lookup(plugin_name, '_paths_folder', role='example') }}"`,
	} {
		t.Run(value, func(t *testing.T) {
			assertPathsDiagnostics(t, "roles/example/defaults/main.yml", pathsBanner+"example_role_paths_location: "+value+"\n")
		})
	}
	assertPathsDiagnostics(t, "roles/example/defaults/main.yml", pathsBanner+"# {{ lookup('role_var', '_paths_folder') }}\nexample_role_paths_location: /data\n")
	assertPathsDiagnostics(t, "roles/example/defaults/main.yml", pathsBanner+"example_role_paths_options: !unsafe\n  location: \"{{ lookup('role_var', '_paths_folder', role='example') }}\"\n")
	assertPathsDiagnostics(t, "roles/example/defaults/main.yml", "example_role_option: &shared \"{{ lookup('role_var', '_paths_folder', role='example') }}\"\n"+pathsBanner+"example_role_paths_location: *shared\n")
}

func TestPathsRoleVarSourceKinds(t *testing.T) {
	const call = "lookup('role_var', '_paths_folder', role='example')"
	input := pathsBanner + "example_role_paths_location: \"{{ " + call + " }}\"\n"
	for _, path := range []string{"inventory.yml", "group_vars/all.yml", "host_vars/server.yml", "roles/example/vars/main.yml", "resources/roles/example/vars/main.yml", "examples.yaml", "defaults/main.yml"} {
		t.Run(path, func(t *testing.T) { assertPathsDiagnostics(t, path, input) })
	}
	for _, path := range []string{"roles/example/defaults/main.yml", "resources/roles/example/defaults/nested/options.yaml"} {
		t.Run(path, func(t *testing.T) { assertPathsDiagnostics(t, path, input, call) })
	}
	for _, path := range []string{"roles/example/tasks/main.yml", "roles/example/handlers/main.yml", "playbook.yml"} {
		t.Run(path, func(t *testing.T) {
			input := pathsBanner + "- name: Example\n  ansible.builtin.debug:\n    msg: \"{{ " + call + " }}\"\n"
			assertPathsDiagnostics(t, path, input)
		})
	}
}

func TestPathsRoleVarOriginalSpansWithUnicodeAndCRLF(t *testing.T) {
	const call = "lookup('role_var', '_paths_folder', role='example')"
	input := pathsBanner + "example_role_paths_location: \"/é/日本語/{{ " + call + " }}\"\n"
	assertPathsDiagnostics(t, "roles/example/defaults/main.yml", strings.ReplaceAll(input, "\n", "\r\n"), call)
}

func TestPathsRoleVarSelectedFile(t *testing.T) {
	root := t.TempDir()
	const selected = "roles/example/defaults/main.yml"
	const unselected = "roles/other/defaults/main.yml"
	const call = "lookup('role_var', '_paths_folder', role='example')"
	input := pathsBanner + "example_role_paths_location: \"{{ " + call + " }}\"\n"
	writeTestSource(t, filepath.Join(root, selected), input)
	writeTestSource(t, filepath.Join(root, unselected), strings.ReplaceAll(input, "example", "other"))
	project, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, selected)}})
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := Analyze(project, pathsRules())
	if len(diagnostics) != 1 || diagnostics[0].Path != selected {
		t.Fatalf("selected-file Paths diagnostics = %+v", diagnostics)
	}
	if project.Selected[unselected] || !project.Selected[selected] {
		t.Fatalf("Paths policy widened selected files: %+v", project.Selected)
	}
	if got := string(project.Sources[selected].Data[diagnostics[0].Span.Start:diagnostics[0].Span.End]); got != call {
		t.Fatalf("selected-file call span = %q, want %q", got, call)
	}
	full, err := Load(t.Context(), Options{Root: root, Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	fullDiagnostics := Analyze(full, pathsRules())
	if len(fullDiagnostics) != 2 {
		t.Fatalf("full-source Paths diagnostics = %+v, want both defaults files", fullDiagnostics)
	}
	match := slices.IndexFunc(fullDiagnostics, func(diagnostic Diagnostic) bool { return diagnostic.Path == selected })
	if match < 0 || fullDiagnostics[match].Span != diagnostics[0].Span || fullDiagnostics[match].Message != diagnostics[0].Message || fullDiagnostics[match].Expected != diagnostics[0].Expected {
		t.Errorf("selected-file diagnostic differs from full analysis: selected=%+v full=%+v", diagnostics, fullDiagnostics)
	}
	before, err := os.ReadFile(filepath.Join(root, selected))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, []byte(input)) {
		t.Error("selected-file analysis modified its input")
	}
}
