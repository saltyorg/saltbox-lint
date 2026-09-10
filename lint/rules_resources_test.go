package lint

import (
	"strings"
	"testing"
)

func TestResourceHelperArguments(t *testing.T) {
	for _, helper := range []string{"create", "remove", "restart", "start", "stop"} {
		for _, action := range []string{"include_tasks: /resources/tasks/docker/" + helper + "_docker_container.yml", "ansible.builtin.include_tasks: {file: /resources/tasks/docker/" + helper + "_docker_container.yml}", "action: include_tasks /resources/tasks/docker/" + helper + "_docker_container.yml", "local_action: {module: include_tasks, file: /resources/tasks/docker/" + helper + "_docker_container.yml}"} {
			input := "- " + action + "\n  vars:\n    _var_prefix: example\n"
			assertAnsible(t, "tasks/main.yml", input, "docker-helper-arguments", "_var_prefix", "var_prefix")
			for _, valid := range []string{strings.Replace(input, "_var_prefix:", "var_prefix:", 1), strings.Split(input, "  vars:")[0]} {
				if ds := ansibleDiagnostics(t, "tasks/main.yml", valid, "docker-helper-arguments"); len(ds) > 0 {
					t.Fatal(ds)
				}
			}
		}
	}
	for _, input := range []string{"- debug: {msg: '/docker/create_docker_container.yml'}\n  vars: {_var_prefix: example}\n", "- include_tasks: /docker/create_docker_container.yml\n- debug: {msg: hi}\n  vars: {_var_prefix: example}\n", "- include_tasks: /docker/create_docker_container.yml\n  vars:\n    payload: {_var_prefix: example}\n"} {
		if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "docker-helper-arguments"); len(ds) > 0 {
			t.Fatal(ds)
		}
	}
}
func TestResourceNetworkInputs(t *testing.T) {
	for _, action := range []string{"include_tasks: network_container_health_status.yml", "include_tasks: {file: '/docker/network_container_health_status.yml'}", "action: include_tasks network_container_health_status.yml"} {
		input := "- " + action + "\n  vars:\n    network_container_source: example\n"
		ds := ansibleDiagnostics(t, "tasks/main.yml", input, "network-health-contract")
		if len(ds) != 1 || !strings.Contains(ds[0].Expected, "network_container_target") {
			t.Fatal(ds)
		}
		valid := input + "    network_container_target: gluetun\n"
		if ds := ansibleDiagnostics(t, "tasks/main.yml", valid, "network-health-contract"); len(ds) > 0 {
			t.Fatal(ds)
		}
	}
	input := "- include_tasks: network_container_health_status.yml\n  vars:\n    payload: {network_container_source: example, network_container_target: other}\n- set_fact: {network_container_source: example, network_container_target: other}\n"
	if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "network-health-contract"); len(ds) != 1 {
		t.Fatal(ds)
	}
	for _, v := range []string{"_docker_vars", "_instance_name", "_var_prefix"} {
		input := "- debug: {msg: '{{ " + v + " }}'}\n"
		assertAnsible(t, "resources/tasks/docker/network_container_health_status.yml", input, "network-health-contract", v, "explicit")
	}
}
func TestResourceCanonicalIdentity(t *testing.T) {
	for _, tc := range []struct{ id, path, input string }{{"git-clone-resource", "resources/tasks/git/clone_git_repo.yml", "- git: {}\n"}, {"svm-github-api-resource", "resources/tasks/git/github_api_request.yml", "- debug: {msg: '{{ svm }}'}\n"}} {
		for _, name := range []string{"saltbox", "sandbox", ""} {
			for _, path := range []string{tc.path, "nested/" + tc.path, "resources/tasks/copy/" + strings.TrimPrefix(tc.path, "resources/tasks/")} {
				p := ansibleProject(t, name, map[string]string{path: tc.input})
				if strings.HasPrefix(path, "nested/") {
					p.Sources[path].Kind = Tasks
				}
				ds := Analyze(p, dockerRules(tc.id))
				want := 1
				if name == "saltbox" && path == tc.path {
					want = 0
				}
				if len(ds) != want {
					t.Errorf("%s %s %s: %+v", tc.id, name, path, ds)
				}
			}
		}
	}
}
func TestResourceSVMReadRegressions(t *testing.T) {
	// Retains the 17 legacy SVM test scenarios, including their parametrized bindings.
	for _, tc := range []struct {
		name, input string
		bad         bool
	}{
		{"task", "- uri: {url: '{{ svm }}https://api.github.com'}\n", true},
		{"statement", "- debug: {msg: '{% set endpoint = svm %}{{ endpoint }}'}\n", true},
		{"block hash", "- debug:\n    msg: |\n      # {{ svm }}\n", true},
		{"attribute filter test", "- debug: {msg: '{{ config.svm }} {{ value | svm }} {{ value is svm }}'}\n", false},
		{"global attribute", "- debug: {msg: '{{ svm.endpoint }}'}\n", true},
		{"comments", "- debug: {msg: '{# svm #}literal'} # {% set endpoint = svm %}\n", false},
		{"macro default", "- debug: {msg: '{% macro helper(value=svm) %}{{ value }}{% endmacro %}'}\n", true},
		{"raw", "- debug: {msg: '{% raw %}{{ svm }}{% endraw %}'}\n", false},
		{"comment raw", "# {% raw %}\n- debug: {msg: '{{ svm }}'}\n", true},
		{"anchored block", "- debug:\n    msg: &payload |-\n      # {{ svm }}\n", true},
		{"tagged block", "- debug:\n    msg: !!str |-\n      # {{ svm }}\n", true},
		{"unsafe block", "- debug:\n    msg: !unsafe |-\n      # {{ svm }}\n", false},
		{"literal", "- debug: {msg: \"{{ 'svm' }} {{ svm_url }}\"} # {{ svm }}\n", false},
		{"block set filter", "- debug: {msg: '{% set payload | default(svm) %}literal{% endset %}'}\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ds := ansibleDiagnostics(t, "tasks/main.yml", tc.input, "svm-github-api-resource")
			if (len(ds) > 0) != tc.bad {
				t.Fatal(ds)
			}
			for _, d := range ds {
				if tc.input[d.Span.Start:d.Span.End] != "svm" {
					t.Fatal(d)
				}
			}
		})
	}
	for _, tag := range []string{"{% macro helper(svm) %}{% endmacro %}", "{% set svm %}literal{% endset %}", "{% import 'helpers.j2' as svm %}", "{% from 'helpers.j2' import helper as svm %}", "{% call(svm) helper() %}{% endcall %}", "{% filter svm %}literal{% endfilter %}", "{% for svm in values %}{% endfor %}"} {
		input := "- debug:\n    msg: >-\n      " + tag + "\n"
		if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "svm-github-api-resource"); len(ds) > 0 {
			t.Fatal(ds)
		}
	}
	for _, path := range []string{"roles/example/defaults/main.yml", "inventories/group_vars/all.yml"} {
		assertAnsible(t, path, "example: '{{ svm }}'\n", "svm-github-api-resource", "svm", "github_api_request.yml")
	}
}
func TestResourceCloudflareReads(t *testing.T) {
	for _, access := range []string{"cloudflare.api", "cloudflare.email", "cloudflare.scoped_token", "cloudflare['api']", "cloudflare[\"email\"]"} {
		input := "value: >-\n  {{ " + access + " }}\n"
		assertAnsible(t, "roles/example/defaults/main.yml", input, "cloudflare-auth-contract", access, "cloudflare_")
	}
	for _, expr := range []string{"config.cloudflare.api", "'cloudflare.api'", "value | cloudflare.api", "cloudflare_other.api", "cloudflare.zone", "cloudflare_api_key"} {
		input := "value: >-\n  {{ " + expr + " }}\n"
		if ds := ansibleDiagnostics(t, "roles/example/defaults/main.yml", input, "cloudflare-auth-contract"); len(ds) > 0 {
			t.Fatalf("%s: %+v", expr, ds)
		}
	}
	input := "- command: echo cloudflare.api\n  vars:\n    config: cloudflare.email\n    payload: {when: cloudflare.api}\n"
	if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "cloudflare-auth-contract"); len(ds) > 0 {
		t.Fatal(ds)
	}
}
func TestResourceImplicitConditions(t *testing.T) {
	for _, key := range []string{"when", "changed_when", "failed_when", "until"} {
		input := "- debug: {msg: ok}\n  " + key + ": cloudflare.api != ''\n"
		assertAnsible(t, "tasks/main.yml", input, "cloudflare-auth-contract", "cloudflare.api", "cloudflare_")
	}
	for _, action := range []string{"assert:\n    that:\n      - cloudflare.email != ''", "action:\n    module: assert\n    that: cloudflare.email != ''"} {
		assertAnsible(t, "tasks/main.yml", "- "+action+"\n", "cloudflare-auth-contract", "cloudflare.email", "cloudflare_")
	}
	input := "- debug: {msg: ok}\n  when: \"cloudflare.\\u0061pi != 'cloudflare.api'\"\n"
	assertAnsible(t, "tasks/main.yml", input, "cloudflare-auth-contract", `cloudflare.\u0061pi`, "cloudflare_")
	input = "- debug: {msg: ok}\n  when: \"{{ cloudflare.api }}\"\n"
	assertAnsible(t, "tasks/main.yml", input, "cloudflare-auth-contract", "cloudflare.api", "cloudflare_")
}

func TestResourceCloudflareHintUsesActualNormalizedNames(t *testing.T) {
	input := "- debug: {msg: '{{ cloudflare.api }}'}\n"
	ds := ansibleDiagnostics(t, "tasks/main.yml", input, "cloudflare-auth-contract")
	if len(ds) != 1 {
		t.Fatal(ds)
	}
	for _, name := range []string{"cloudflare_api_key", "cloudflare_email", "cloudflare_scoped_token"} {
		if !strings.Contains(ds[0].Expected, name) {
			t.Errorf("actual normalized variable %s missing from %q", name, ds[0].Expected)
		}
	}
}
func TestResourceImplicitConditionsIgnoreNameOnlyReads(t *testing.T) {
	input := "- debug: {msg: ok}\n  when:\n    - config.cloudflare.api is defined\n    - \"'cloudflare.api' == literal\"\n    - value is cloudflare.api\n    - value | cloudflare.api\n    - !unsafe cloudflare.api is defined\n"
	if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "cloudflare-auth-contract"); len(ds) > 0 {
		t.Fatal(ds)
	}
	input = "- assert:\n    that:\n      - svm is defined\n      - cloudflare.api != ''\n"
	assertAnsible(t, "tasks/main.yml", input, "svm-github-api-resource", "svm", "github_api_request.yml")
	assertAnsible(t, "tasks/main.yml", input, "cloudflare-auth-contract", "cloudflare.api", "cloudflare_")
}

func TestResourceAppliedIncludeConditions(t *testing.T) {
	owners := []string{
		"- include_role:\n    name: example\n    apply:\n      when: CONDITION\n",
		"- ansible.builtin.include_tasks:\n    file: example.yml\n    apply:\n      when: CONDITION\n",
		"- action:\n    module: include_role\n    name: example\n    apply:\n      when: CONDITION\n",
		"- local_action:\n    module: ansible.builtin.include_tasks\n    file: example.yml\n    apply:\n      when: CONDITION\n",
		"- action: include_role name=example\n  args:\n    apply:\n      when: CONDITION\n",
		"- include_tasks: example.yml\n  args:\n    apply:\n      when: CONDITION\n",
	}
	for _, owner := range owners {
		t.Run(owner, func(t *testing.T) {
			input := strings.Replace(owner, "CONDITION", "cloudflare.api != ''", 1)
			assertAnsible(t, "tasks/main.yml", input, "cloudflare-auth-contract", "cloudflare.api", "cloudflare_")
			input = strings.Replace(owner, "CONDITION", "svm is defined", 1)
			assertAnsible(t, "tasks/main.yml", input, "svm-github-api-resource", "svm", "github_api_request.yml")
			input = strings.Replace(owner, "CONDITION", "_instance_name is defined", 1)
			assertAnsible(t, networkHealthResource, input, "network-health-contract", "_instance_name", "explicit")
			input = dockerPolicyDeclaration("default: 0") + strings.Replace(owner, "CONDITION", "_docker_vars._docker_memory is defined", 1)
			assertAnsible(t, "resources/tasks/docker/main.yml", input, "docker-vars-policy", "_docker_vars._docker_memory", "omit: true")
		})
	}
	input := "- include_role:\n    name: example\n    apply:\n      when:\n        - \"cloudflare.\\u0061pi != ''\"\n"
	assertAnsible(t, "tasks/main.yml", input, "cloudflare-auth-contract", `cloudflare.\u0061pi`, "cloudflare_")
	for _, input := range []string{
		"- debug:\n    msg:\n      apply: {when: cloudflare.api}\n",
		"- include_role:\n    name: example\n    apply:\n      vars:\n        payload: {when: cloudflare.api}\n",
		"- debug: {msg: ok}\n  args:\n    apply: {when: cloudflare.api}\n",
	} {
		if ds := ansibleDiagnostics(t, "tasks/main.yml", input, "cloudflare-auth-contract"); len(ds) > 0 {
			t.Fatal(ds)
		}
	}
}
