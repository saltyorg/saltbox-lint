package lint

import (
	"os"
	"slices"
	"strings"
	"testing"
)

var ansibleRuleIDs = []string{"docker-helper-arguments", "network-health-contract", "cloudflare-auth-contract", "svm-github-api-resource", "git-clone-resource", "ansible-tag-name", "ansible-static-import", "role-directory-name", "ansible-source-header", "docker-vars-policy"}

func ansibleProject(t *testing.T, name string, files map[string]string) *Project {
	t.Helper()
	p := &Project{Name: name, Sources: map[string]*Source{}, Selected: map[string]bool{}}
	for path, data := range files {
		s, ds := Parse(path, []byte(data))
		if len(ds) > 0 {
			t.Fatalf("parse %s: %+v", path, ds)
		}
		p.Sources[path] = s
		p.Selected[path] = true
	}
	return p
}
func ansibleDiagnostics(t *testing.T, path, input, id string) []Diagnostic {
	t.Helper()
	return Analyze(ansibleProject(t, "saltbox", map[string]string{path: input}), dockerRules(id))
}
func assertAnsible(t *testing.T, path, input, id, span, hint string) {
	t.Helper()
	ds := ansibleDiagnostics(t, path, input, id)
	if len(ds) != 1 {
		t.Fatalf("%s diagnostics=%+v", id, ds)
	}
	d := ds[0]
	if got := input[d.Span.Start:d.Span.End]; got != span {
		t.Errorf("span=%q want %q", got, span)
	}
	if !strings.Contains(d.Expected, hint) || d.Fix != nil {
		t.Errorf("hint/fix=%+v", d)
	}
}
func TestAnsibleStructuralActions(t *testing.T) {
	for _, tc := range []struct{ action, span string }{
		{"git: {repo: example}", "git"}, {"ansible.builtin.git: {repo: example}", "ansible.builtin.git"},
		{"action: git repo=example", "git"}, {"local_action: ansible.builtin.git repo=example", "ansible.builtin.git"},
		{"action: {module: git, repo: example}", "git"}, {"local_action:\n    module: ansible.builtin.git\n    repo: example", "ansible.builtin.git"},
		{"action: >-\n    ansible.builtin.git\n    repo=example", "ansible.builtin.git"},
	} {
		t.Run(tc.action, func(t *testing.T) {
			input := "- name: Clone\n  " + tc.action + "\n"
			assertAnsible(t, "roles/example/tasks/main.yml", input, "git-clone-resource", tc.span, "clone_git_repo.yml")
			for _, branch := range []string{"block", "rescue", "always"} {
				nested := "- name: Parent\n  " + branch + ":\n" + indentText(input, 4)
				assertAnsible(t, "roles/example/handlers/deep/main.yaml", nested, "git-clone-resource", tc.span, "clone_git_repo.yml")
			}
			play := "- hosts: all\n  tasks:\n" + indentText(input, 4)
			assertAnsible(t, "saltbox.yml", play, "git-clone-resource", tc.span, "clone_git_repo.yml")
		})
	}
	for _, input := range []string{
		"- debug:\n    msg: |\n      - ansible.builtin.git: {}\n", "- set_fact:\n    payload:\n      - git: {}\n        tags: Bad_tag\n        import_role: example\n", "- debug: {msg: harmless}\n  vars:\n    payload: {git: {}, tags: Bad_tag, import_tasks: file.yml}\n",
	} {
		if ds := ansibleDiagnostics(t, "roles/example/tasks/main.yml", input, "git-clone-resource"); len(ds) != 0 {
			t.Fatal(ds)
		}
	}
	if ds := ansibleDiagnostics(t, "vars.yml", "payload: [{git: {}}]\n", "git-clone-resource"); len(ds) != 0 {
		t.Fatal(ds)
	}
}
func indentText(s string, n int) string {
	return strings.Repeat(" ", n) + strings.ReplaceAll(strings.TrimSuffix(s, "\n"), "\n", "\n"+strings.Repeat(" ", n)) + "\n"
}
func TestAnsibleStaticImports(t *testing.T) {
	for _, kind := range []string{"tasks", "role"} {
		for _, action := range []string{"import_" + kind + ": example", "ansible.builtin.import_" + kind + ": example", "action: import_" + kind + " example", "local_action: {module: ansible.builtin.import_" + kind + ", name: example}"} {
			input := "- " + action + "\n"
			span := "import_" + kind
			if strings.Contains(action, "ansible.builtin.") {
				span = "ansible.builtin." + span
			}
			assertAnsible(t, "tasks/main.yml", input, "ansible-static-import", span, "include_"+kind)
		}
	}
	input := "- set_fact:\n    payload: {import_tasks: example}\n- include_tasks: example.yml\n"
	if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-static-import"); len(ds) > 0 {
		t.Fatal(ds)
	}
}
func TestAnsibleTagPositions(t *testing.T) {
	for _, tag := range []string{"Bad_tag", "{{ role_name }}", "true", "false", "null", "23", "2026-09-10", "yes", "off", "[bad_tag]", "{name: bad_tag}"} {
		input := "- debug: {msg: ok}\n  tags: " + tag + "\n"
		if strings.Contains(tag, "{{") {
			input = "- debug: {msg: ok}\n  tags: '" + tag + "'\n"
		}
		ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-tag-name")
		if len(ds) != 1 {
			t.Errorf("%s: %+v", tag, ds)
		}
	}
	for _, tag := range []string{"good-tag", "'true'", "'23'", "'2026-09-10'", "[good, 'yes', two-tags]", "[]"} {
		if ds := ansibleDiagnostics(t, "tasks/main.yml", "- debug: {msg: ok}\n  tags: "+tag+"\n", "ansible-tag-name"); len(ds) > 0 {
			t.Errorf("%s: %+v", tag, ds)
		}
	}
	for _, input := range []string{"- hosts: all\n  tags: Bad_tag\n", "- hosts: all\n  roles:\n    - role: example\n      tags: Bad_tag\n", "- include_role:\n    name: example\n    apply:\n      tags: Bad_tag\n"} {
		path := "tasks/main.yml"
		if strings.Contains(input, "hosts:") {
			path = "saltbox.yml"
		}
		assertAnsible(t, path, input, "ansible-tag-name", "Bad_tag", "kebab-case")
	}
	input := "- set_fact:\n    payload: {tags: Bad_tag}\n  vars:\n    tags: Bad_tag\n"
	if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-tag-name"); len(ds) > 0 {
		t.Fatal(ds)
	}
}

const standardHeader = "####################\n# Title: Example\n# Author(s): someone\n# URL: https://example.com\n# GNU General Public License v3.0\n---\n"

func TestAnsibleSourceHeaders(t *testing.T) {
	for _, dir := range []string{"defaults", "vars", "tasks", "handlers"} {
		path := "resources/roles/example/" + dir + "/nested/main.yaml"
		for _, header := range []string{standardHeader, strings.Replace(standardHeader, "# Author(s):", "# Extra: metadata\n# Continued title\n# Author(s):", 1)} {
			if ds := ansibleDiagnostics(t, path, header+"[]\n", "ansible-source-header"); len(ds) > 0 {
				t.Fatal(ds)
			}
		}
		for _, header := range []string{"", strings.Replace(standardHeader, "# Title: Example\n", "", 1), strings.Replace(standardHeader, "# Author(s): someone", "# Author(s):", 1), strings.Replace(standardHeader, "# URL: https://example.com", "# URL: example.com", 1), strings.Replace(standardHeader, "---", "# "+strings.Repeat("\n", 20)+"---", 1)} {
			if ds := ansibleDiagnostics(t, path, header+"[]\n", "ansible-source-header"); len(ds) != 1 {
				t.Fatalf("%q: %+v", header, ds)
			}
		}
	}
	for _, path := range []string{"roles/example/templates/config.yaml", "roles/example/files/config.yaml", "resources/tasks/main.yml"} {
		if ds := ansibleDiagnostics(t, path, "[]\n", "ansible-source-header"); len(ds) > 0 {
			t.Fatal(ds)
		}
	}
}
func TestAnsibleRoleDirectoryName(t *testing.T) {
	for _, path := range []string{"roles/Bad-role/tasks/main.yml", "resources/roles/Bad-role/defaults/nested/main.yaml"} {
		assertAnsible(t, path, "[]\n", "role-directory-name", "[]", "snake_case")
	}
	for _, path := range []string{"roles/good_role/tasks/main.yml", "resources/tasks/Bad-role.yml", "nested/roles/Bad-role/tasks/main.yml"} {
		if ds := ansibleDiagnostics(t, path, "[]\n", "role-directory-name"); len(ds) > 0 {
			t.Fatal(ds)
		}
	}
}
func TestAnsibleFixturePairs(t *testing.T) {
	for _, kind := range []string{"good", "bad"} {
		data, err := os.ReadFile("testdata/ansible/structural." + kind + ".yml")
		if err != nil {
			t.Fatal(err)
		}
		ds := Analyze(ansibleProject(t, "saltbox", map[string]string{"roles/example/tasks/main.yml": string(data)}), dockerRules("ansible-tag-name", "ansible-static-import", "git-clone-resource", "docker-helper-arguments", "network-health-contract"))
		if kind == "good" && len(ds) != 0 {
			t.Fatal(ds)
		}
		if kind == "bad" && len(ds) != 5 {
			t.Fatal(ds)
		}
	}
}
func TestAnsibleRegistry(t *testing.T) {
	rules := dockerRules(ansibleRuleIDs...)
	if len(rules) != 10 {
		t.Fatalf("registered=%d", len(rules))
	}
	for _, r := range rules {
		if r.Explanation == "" || r.GoodExample == "" || r.BadExample == "" || len(r.Kinds) == 0 || r.Scope == "" || r.Fixable || !slices.Contains(ansibleRuleIDs, r.ID) {
			t.Errorf("metadata %+v", r)
		}
	}
}

func TestAnsibleQuotedActionAndTagSyntax(t *testing.T) {
	assertAnsible(t, "tasks/main.yml", "- 'ansible.builtin.git': {}\n", "git-clone-resource", "'ansible.builtin.git'", "clone_git_repo.yml")
	assertAnsible(t, "tasks/main.yml", "- local_action:\n    module: >-\n      ansible.builtin.git\n    repo: example\n", "git-clone-resource", "ansible.builtin.git", "clone_git_repo.yml")
	for _, tag := range []string{"&tag valid", "*tag", "!!int '23'", "!unsafe good"} {
		input := "- debug: {msg: ok}\n  vars: {seed: &tag good}\n  tags: " + tag + "\n"
		if tag == "&tag valid" {
			input = "- debug: {msg: ok}\n  tags: " + tag + "\n"
		}
		ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-tag-name")
		if len(ds) != 1 {
			t.Errorf("%s: %+v", tag, ds)
		}
	}
	input := "- include_tasks: {file: example.yml, apply: {tags: bad_tag}}\n"
	assertAnsible(t, "tasks/main.yml", input, "ansible-tag-name", "bad_tag", "kebab-case")
	input = "- debug: {msg: ok}\n  tags: !!str true\n"
	if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "ansible-tag-name"); len(ds) > 0 {
		t.Fatal(ds)
	}
}
func TestAnsibleHeaderOrderAndMultilineMetadata(t *testing.T) {
	for _, input := range []string{
		strings.Replace(standardHeader, "# Title: Example\n# Author(s): someone", "# Author(s): someone\n# Title: Example", 1) + "[]\n",
		"payload: |\n" + indentText(standardHeader, 2),
		"payload: '\n" + indentText(standardHeader, 2) + "  '\n",
	} {
		if ds := ansibleDiagnostics(t, "roles/example/vars/nested.yml", input, "ansible-source-header"); len(ds) != 1 {
			t.Fatal(ds)
		}
	}
	valid := strings.Replace(standardHeader, "# Author(s): someone", "# Author(s): someone,\n#            another contributor", 1) + "[]\n"
	if ds := ansibleDiagnostics(t, "roles/example/vars/nested.yml", valid, "ansible-source-header"); len(ds) > 0 {
		t.Fatal(ds)
	}
}
func TestAnsibleSelectedFileDoesNotReportSiblingTags(t *testing.T) {
	a, b := "roles/example/tasks/a.yml", "roles/example/handlers/nested/b.yml"
	p := ansibleProject(t, "saltbox", map[string]string{a: "- debug: {msg: ok}\n  tags: bad_tag\n", b: "- debug: {msg: ok}\n  tags: also_bad\n"})
	p.Selected = map[string]bool{b: true}
	ds := Analyze(p, dockerRules("ansible-tag-name"))
	if len(ds) != 1 || ds[0].Path != b {
		t.Fatal(ds)
	}
}

func TestAnsibleRegisteredExamples(t *testing.T) {
	for _, rule := range dockerRules(ansibleRuleIDs...) {
		t.Run(rule.ID, func(t *testing.T) {
			for _, bad := range []bool{false, true} {
				path, input := "tasks/main.yml", rule.GoodExample
				if bad {
					input = rule.BadExample
				}
				switch rule.ID {
				case "role-directory-name":
					path = "roles/good_role/tasks/main.yml"
					if bad {
						path = "roles/bad-role/tasks/main.yml"
					}
				case "ansible-source-header":
					path = "roles/example/tasks/main.yml"
				case "docker-vars-policy":
					path = "resources/tasks/docker/main.yml"
				case "svm-github-api-resource", "cloudflare-auth-contract":
					path = "vars.yml"
				}
				ds := ansibleDiagnostics(t, path, input, rule.ID)
				if (!bad && len(ds) > 0) || (bad && len(ds) != 1) {
					t.Fatalf("bad=%v diagnostics=%+v", bad, ds)
				}
			}
		})
	}
}

func TestAnsibleTaskMetadataCannotHideActions(t *testing.T) {
	// Values are independently taken from the installed Ansible Base, Task and
	// Handler field contracts and ModuleArgsParser metadata exclusions.
	metadata := []string{
		"name: Clone", "connection: local", "port: 22", "remote_user: root",
		"vars: {}", "module_defaults: {}", "environment: {}", "no_log: true",
		"run_once: true", "ignore_errors: true", "ignore_unreachable: true",
		"check_mode: false", "diff: false", "any_errors_fatal: true", "throttle: 1",
		"timeout: 10", "debugger: never", "become: true", "become_method: sudo",
		"become_user: root", "become_flags: '-H'", "become_exe: sudo",
		"args: {}", "async: 10", "async_val: 10", "changed_when: false",
		"delay: 1", "failed_when: false", "loop: []", "loop_control: {}",
		"poll: 1", "register: result", "retries: 1", "until: false",
		"loop_with: items", "when: true", "tags: good", "collections: []",
		"notify: handler", "delegate_to: localhost", "delegate_facts: false",
		"listen: handler", "static: false", "with_items: []",
	}
	for _, field := range metadata {
		t.Run(field, func(t *testing.T) {
			for _, action := range []struct{ source, id, span, hint string }{
				{"ansible.builtin.git: {repo: example}", "git-clone-resource", "ansible.builtin.git", "clone_git_repo.yml"},
				{"action: git repo=example", "git-clone-resource", "git", "clone_git_repo.yml"},
				{"local_action: {module: import_tasks, file: example.yml}", "ansible-static-import", "import_tasks", "include_tasks"},
			} {
				for _, input := range []string{"- " + field + "\n  " + action.source + "\n", "- " + action.source + "\n  " + field + "\n"} {
					assertAnsible(t, "roles/example/handlers/main.yml", input, action.id, action.span, action.hint)
				}
			}
		})
	}
}
