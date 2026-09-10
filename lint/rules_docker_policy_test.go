package lint

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func dockerPolicyDeclaration(policy string) string {
	return "- set_fact:\n    _docker_vars: \"{{ lookup('docker_vars', specs=_docker_var_specs) }}\"\n  vars:\n    _docker_var_specs:\n      _docker_memory:\n        " + policy + "\n"
}
func TestDockerPolicySparseAccess(t *testing.T) {
	for _, access := range []string{"_docker_vars._docker_memory | default(0)", "_docker_vars['_docker_memory'] | default(0)", "_docker_vars.get('_docker_memory', 0)", "_docker_vars._docker_memory is defined", "_docker_vars['_docker_memory'] is not defined"} {
		for _, policy := range []string{"default: 0", "required: true", "omit: false", "omit: '{{ enabled }}'", "omit: true"} {
			t.Run(access+policy, func(t *testing.T) {
				input := dockerPolicyDeclaration(policy) + "- debug:\n    msg: >-\n      {{ " + access + " }}\n"
				ds := ansibleDiagnostics(t, "resources/tasks/docker/nested/main.yml", input, "docker-vars-policy")
				if policy == "omit: true" {
					if len(ds) > 0 {
						t.Fatal(ds)
					}
				} else {
					if len(ds) != 1 || !strings.Contains(ds[0].Expected, "omit: true") {
						t.Fatal(ds)
					}
					if ds[0].Fix != nil {
						t.Fatal(ds)
					}
				}
			})
		}
	}
	for _, access := range []string{"_docker_vars._docker_missing | default(0)", "_docker_vars.get('_docker_missing')"} {
		ds := ansibleDiagnostics(t, "resources/tasks/docker/main.yml", "- debug: {msg: \"{{ "+access+" }}\"}\n", "docker-vars-policy")
		if len(ds) != 1 || !strings.Contains(ds[0].Message, "undeclared") {
			t.Fatal(ds)
		}
	}
}
func TestDockerPolicyActualDeclarationAndReadOwnership(t *testing.T) {
	for _, input := range []string{
		"- set_fact:\n    _docker_vars: \"{{ lookup('docker_vars', specs={'_docker_memory': {'omit': true}}) }}\"\n",
		"- set_fact:\n    _docker_vars: \"{{ lookup('docker_vars', specs=custom_specs) }}\"\n  vars:\n    custom_specs: {_docker_memory: {omit: true}}\n",
	} {
		input += "- debug: {msg: \"{{ _docker_vars._docker_memory | default(0) }}\"}\n"
		if ds := ansibleDiagnostics(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy"); len(ds) > 0 {
			t.Fatal(ds)
		}
	}
	for _, input := range []string{
		"- debug: {msg: ok}\n  vars:\n    _docker_var_specs: {_docker_memory: {omit: true}}\n",
		"- set_fact:\n    payload: {_docker_memory: {omit: true}}\n",
		"- debug: {msg: \"{{ helper('docker_vars', specs={'_docker_memory': {'omit': true}}) }}\"}\n",
	} {
		input += "- debug: {msg: \"{{ _docker_vars._docker_memory | default(0) }}\"}\n"
		ds := ansibleDiagnostics(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy")
		if len(ds) != 1 {
			t.Fatal(ds)
		}
	}
	input := dockerPolicyDeclaration("default: 0") + "- debug:\n    msg: >-\n      {{ config._docker_vars._docker_memory | default(0) }} {{ '_docker_vars._docker_memory | default(0)' }}\n  vars:\n    payload: {when: '_docker_vars._docker_memory is defined'}\n- command: echo _docker_vars._docker_memory is defined\n"
	if ds := ansibleDiagnostics(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy"); len(ds) > 0 {
		t.Fatal(ds)
	}
	input = dockerPolicyDeclaration("default: 0") + "- debug: {msg: ok}\n  when: _docker_vars._docker_memory is defined\n"
	assertAnsible(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy", "_docker_vars._docker_memory", "omit: true")
}
func TestDockerPolicySharedContext(t *testing.T) {
	a := "resources/tasks/docker/a.yml"
	b := "resources/tasks/docker/nested/b.yaml"
	p := ansibleProject(t, "saltbox", map[string]string{a: dockerPolicyDeclaration("default: 0"), b: dockerPolicyDeclaration("omit: true")})
	p.Selected = map[string]bool{b: true}
	ds := Analyze(p, dockerRules("docker-vars-policy"))
	if len(ds) != 1 || ds[0].Path != b || len(ds[0].Related) != 1 || ds[0].Related[0].Path != a || !strings.Contains(ds[0].Message, "conflicting") {
		t.Fatal(ds)
	}
	if got := string(p.Sources[b].Data[ds[0].Span.Start:ds[0].Span.End]); got != "_docker_memory" {
		t.Fatal(got)
	}
	p = ansibleProject(t, "saltbox", map[string]string{a: dockerPolicyDeclaration("omit: true"), b: "- debug: {msg: \"{{ _docker_vars._docker_memory | default(0) }}\"}\n"})
	p.Selected = map[string]bool{b: true}
	if ds := Analyze(p, dockerRules("docker-vars-policy")); len(ds) > 0 {
		t.Fatal(ds)
	}
	p = ansibleProject(t, "saltbox", map[string]string{a: dockerPolicyDeclaration("default: 0"), b: "- debug: {msg: \"{{ _docker_vars._docker_memory | default(0) }}\"}\n"})
	p.Selected = map[string]bool{b: true}
	ds = Analyze(p, dockerRules("docker-vars-policy"))
	if len(ds) != 1 || len(ds[0].Related) != 1 || ds[0].Related[0].Path != a {
		t.Fatal(ds)
	}
}
func TestDockerPolicyInvalidContext(t *testing.T) {
	a := "resources/tasks/docker/a.yml"
	b := "resources/tasks/docker/b.yml"
	p := ansibleProject(t, "saltbox", map[string]string{b: "- debug: {msg: \"{{ _docker_vars._docker_memory | default(0) }}\"}\n"})
	p.Sources[a], _ = Parse(a, []byte("- broken: [\n"))
	ds := Analyze(p, dockerRules("docker-vars-policy"))
	if len(ds) != 1 || ds[0].Path != b || !strings.Contains(ds[0].Message, "invalid") || len(ds[0].Related) != 1 || ds[0].Related[0].Path != a {
		t.Fatal(ds)
	}
	p.Sources[b], _ = Parse(b, []byte("- debug: {msg: ok}\n"))
	if ds := Analyze(p, dockerRules("docker-vars-policy")); len(ds) != 0 {
		t.Fatal(ds)
	}
}
func TestDockerPolicyLoadSingleFile(t *testing.T) {
	root := t.TempDir()
	for name, data := range map[string]string{"saltbox.yml": "- hosts: all\n", "resources/tasks/docker/a.yml": dockerPolicyDeclaration("omit: true"), "resources/tasks/docker/nested/b.yaml": "- debug: {msg: \"{{ _docker_vars._docker_memory | default(0) }}\"}\n"} {
		name = filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(name), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(data), 0644); err != nil {
			t.Fatal(err)
		}
	}
	p, err := Load(t.Context(), Options{Root: root, Paths: []string{filepath.Join(root, "resources/tasks/docker/nested/b.yaml")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Selected) != 1 || len(p.Sources) != 2 {
		t.Fatalf("selected %v sources %v", p.Selected, p.Sources)
	}
	if ds := Analyze(p, dockerRules("docker-vars-policy")); len(ds) > 0 {
		t.Fatal(ds)
	}
}

func TestDockerPolicyDeclarationsAreActualLookupCalls(t *testing.T) {
	for _, expr := range []string{"data | lookup('docker_vars', specs={'_docker_memory': {'omit': true}})", "data.lookup('docker_vars', specs={'_docker_memory': {'omit': true}})"} {
		input := "- debug:\n    msg: >-\n      {{ " + expr + " }}\n- debug: {msg: \"{{ _docker_vars._docker_memory | default(0) }}\"}\n"
		ds := ansibleDiagnostics(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy")
		if len(ds) != 1 {
			t.Fatalf("%s: %+v", expr, ds)
		}
	}
}
func TestDockerPolicyDuplicateLookupEvidence(t *testing.T) {
	a, b := "resources/tasks/docker/a.yml", "resources/tasks/docker/b.yml"
	input := strings.Replace(dockerPolicyDeclaration("default: 0"), "    _docker_vars:", "    second: \"{{ lookup('docker_vars', specs=_docker_var_specs) }}\"\n    _docker_vars:", 1)
	p := ansibleProject(t, "saltbox", map[string]string{a: input, b: dockerPolicyDeclaration("omit: true")})
	ds := Analyze(p, dockerRules("docker-vars-policy"))
	if len(ds) != 2 {
		t.Fatal(ds)
	}
	for _, d := range ds {
		if len(d.Related) != 1 {
			t.Fatal(ds)
		}
	}
}
func TestDockerPolicyLiteralConflictingSpecs(t *testing.T) {
	input := "- set_fact:\n    value: \"{{ lookup('docker_vars', specs={'_docker_memory': {'default': {'nested': [0, 1]}, 'omit': true}}) }}\"\n"
	ds := ansibleDiagnostics(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy")
	if len(ds) != 1 || !strings.Contains(ds[0].Message, "conflicting") {
		t.Fatal(ds)
	}
}

func TestDockerPolicyOmitYAMLType(t *testing.T) {
	for _, policy := range []string{"omit: !!str true", "omit: 'true'", "omit: !!bool true", "omit: True"} {
		input := dockerPolicyDeclaration(policy) + "- debug: {msg: '{{ _docker_vars._docker_memory | default(0) }}'}\n"
		ds := ansibleDiagnostics(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy")
		want := 0
		if policy == "omit: !!str true" || policy == "omit: 'true'" {
			want = 1
		}
		if len(ds) != want {
			t.Errorf("%s: %+v", policy, ds)
		}
	}
}

func TestDockerPolicyDynamicGetKeyIsNotLiteralSuffix(t *testing.T) {
	input := dockerPolicyDeclaration("default: 0") + "- debug:\n    msg: >-\n      {{ _docker_vars.get('_docker_memory' ~ suffix, 0) }}\n"
	if ds := ansibleDiagnostics(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy"); len(ds) > 0 {
		t.Fatal(ds)
	}
}
