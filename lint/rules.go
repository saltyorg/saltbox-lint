package lint

import (
	"bytes"
	"unicode/utf8"
)

// Rules returns the enforced policy registry. Metadata travels with each checker
// so CLI documentation and integration renderers need no separate rule lists.
func Rules() []Rule {
	kinds := []Kind{Generic, Defaults, Tasks, Handlers, Vars, Inventory, Playbook}
	return []Rule{
		{ID: "ansible-when-list", Summary: "Split when conjunctions into block lists", Explanation: "Represent an unparenthesized top-level logical and in a structural when scalar or list item as separate block-list items. Preserve explicit groups as indivisible conditions, retain operand order, and group nontrivial individual conditions. Keep conjunctions beneath or, negation, comparisons, filters, calls and conditional results intact. Other condition fields and Jinja conditions are outside this convention.", GoodExample: "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when:\n    - (value is defined)\n    - value\n", BadExample: "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: (value is defined) and value\n", Kinds: []Kind{Tasks, Handlers, Playbook}, Scope: "structural when fields", Check: checkWhenList},
		{ID: "ansible-when-parentheses", Summary: "Group nontrivial when conditions", Explanation: "Enclose the complete when condition in parentheses unless it is a single variable read, including direct field/item access or a standalone lookup, query or q call. Operations outside a lookup still need grouping. Unparenthesized top-level conjunctions belong to ansible-when-list instead; complete explicit groups remain valid. Check each indivisible when list item on structural Ansible owners; preserve nested precedence. Other condition fields and Jinja conditions are outside this convention.", GoodExample: "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when:\n    - lookup('role_var', '_metrics_enabled', role='traefik')\n    - (value is defined)\n", BadExample: "- name: Example\n  ansible.builtin.debug: {msg: ok}\n  when: value is defined\n", Kinds: []Kind{Tasks, Handlers, Playbook}, Scope: "structural when fields", Check: checkWhenParentheses},
		{ID: "jinja-redundant-conditional-parentheses", Summary: "Omit standalone conditional result wrappers", Explanation: "A standalone Jinja output conditional with if and else does not need an enclosing result pair. Preserve groups used by operators, filters, calls, tuples and nested branches. This does not impose grouping on the condition.", GoodExample: "value: \"{{ a if condition else b }}\"\n", BadExample: "value: \"{{ (a if condition else b) }}\"\n", Kinds: kinds, Scope: "standalone YAML Jinja outputs", Check: checkConditionalResultParentheses},
		{ID: "section-spacing", Summary: "Separate section banners from variables", Explanation: "Named three-line section banners need at least one blank line before their variables. Canonical and custom titles share this spacing policy; empty sections and literal scalar contents are ignored. Fixes preserve existing spacing and variable documentation comments.", GoodExample: "################################\n# Settings\n################################\n\nvalue: true\n", BadExample: "################################\n# Settings\n################################\nvalue: true\n", Kinds: []Kind{Generic, Defaults, Vars, Inventory}, Scope: "file", Fixable: true, Check: checkSectionSpacing},
		{ID: "traefik-api-contract", Summary: "Declare the complete Traefik API contract", Explanation: "Traefik-enabled declarations require the API middleware default/custom pair in order, API enablement and endpoint defaults. Legacy middleware declarations are unsupported even without enablement. Direct and namespaced API endpoint defaults must be empty strings or valid literal Traefik v3 HTTP rules. Runtime templates and unresolved aliases are not evaluated.", GoodExample: "example_role_traefik_middleware_default_api: \"{{ traefik_default_middleware_api }}\"\nexample_role_traefik_middleware_custom_api: \"\"\nexample_role_traefik_enabled: false\nexample_role_traefik_api_enabled: false\nexample_role_traefik_api_endpoint: \"PathPrefix(`/api`)\"\n", BadExample: "example_role_traefik_enabled: false\nexample_role_traefik_api_endpoint: \"/api\"\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkTraefikAPIContract},
		{ID: "traefik-adapter-contract", Summary: "Forward namespaced Traefik contracts in role includes", Explanation: "Matching include_role vars forward each namespaced Traefik suffix through an owner-targeted role_var call; the owning defaults declare the same contract. Context and forwarding diagnostics stay on their owning selected source.", GoodExample: traefikAdapterGoodExample, BadExample: "- include_role: {name: nginx}\n  vars:\n    nginx_role_web_subdomain: \"{{ lookup('role_var', '_nginx_web_subdomain', role='example') }}\"\n", Kinds: []Kind{Defaults, Tasks, Handlers}, Scope: "role defaults and includes", Check: checkTraefikAdapterContract},
		{ID: "traefik-renderer-contract", Summary: "Consume the API contract in Traefik renderers", Explanation: "Roles declaring Traefik use the shared Docker renderer or consume API middleware, enablement and endpoint in actual copy content or referenced templates. Actual retirement fail paths are exempt; comments and debug text do not establish rendering.", GoodExample: traefikRendererGoodExample, BadExample: "example_role_traefik_enabled: false\n", Kinds: []Kind{Defaults, Tasks, Handlers}, Scope: "role defaults, tasks and referenced templates", Check: checkTraefikRendererContract},
		{ID: "docker-vars-policy", Summary: "Keep shared Docker suffix policies consistent", Explanation: "Actual docker_vars lookup specs share one policy across Docker resources. Only literal omit:true declarations permit sparse fallback accesses, including implicit Ansible conditions. Invalid required sibling context is reported on the selected dependent source.", GoodExample: "- debug: {msg: ok}\n", BadExample: "- debug: {msg: '{{ _docker_vars._docker_memory | default(0) }}'}\n", Kinds: []Kind{Tasks}, Scope: "shared Docker resources", Check: checkDockerVarsPolicy},
		{ID: "docker-helper-arguments", Summary: "Pass public Docker lifecycle helper arguments", Explanation: "Docker lifecycle include vars use optional var_prefix, never the private _var_prefix fact.", GoodExample: "- include_tasks: /docker/create_docker_container.yml\n  vars: {var_prefix: example}\n", BadExample: "- include_tasks: /docker/create_docker_container.yml\n  vars: {_var_prefix: example}\n", Kinds: []Kind{Tasks, Handlers, Playbook}, Scope: "file", Check: checkDockerHelperArguments},
		{ID: "network-health-contract", Summary: "Pass explicit network health inputs", Explanation: "Network health includes pass source and target in their own vars; the shared resource cannot read caller-local Docker facts.", GoodExample: "- include_tasks: network_container_health_status.yml\n  vars: {network_container_source: example, network_container_target: gluetun}\n", BadExample: "- include_tasks: network_container_health_status.yml\n", Kinds: []Kind{Tasks, Handlers, Playbook}, Scope: "file", Check: checkNetworkHealthContract},
		{ID: "cloudflare-auth-contract", Summary: "Read normalized Cloudflare authentication", Explanation: "Runtime expressions use normalized Cloudflare authentication variables instead of raw account members. Literal text and unrelated object attributes are not global account reads.", GoodExample: "value: '{{ cloudflare_scoped_token }}'\n", BadExample: "value: '{{ cloudflare.api }}'\n", Kinds: kinds, Scope: "file", Check: checkCloudflareAuth},
		{ID: "svm-github-api-resource", Summary: "Keep SVM access in the GitHub fallback resource", Explanation: "Only the exact canonical Saltbox GitHub API resource may read global svm; lexical bindings, attribute names and literal text are not reads.", GoodExample: "value: '{{ github_api_result }}'\n", BadExample: "value: '{{ svm }}'\n", Kinds: kinds, Scope: "project identity", Check: checkSVMResource},
		{ID: "git-clone-resource", Summary: "Keep Git actions in the shared clone resource", Explanation: "Only the exact canonical Saltbox clone resource may invoke Git. Task and handler lists, nested blocks and action forms share this policy.", GoodExample: "- include_tasks: /resources/tasks/git/clone_git_repo.yml\n", BadExample: "- git: {repo: example}\n", Kinds: []Kind{Tasks, Handlers, Playbook}, Scope: "project identity", Check: checkGitCloneResource},
		{ID: "ansible-tag-name", Summary: "Use literal kebab-case Ansible tags", Explanation: "Actual task, play, role and include-apply tags must be literal lowercase kebab-case strings. Quote string spellings of YAML typed values.", GoodExample: "- debug: {msg: ok}\n  tags: good-tag\n", BadExample: "- debug: {msg: ok}\n  tags: Bad_tag\n", Kinds: []Kind{Tasks, Handlers, Playbook}, Scope: "file", Check: checkAnsibleTags},
		{ID: "ansible-static-import", Summary: "Use dynamic Ansible includes", Explanation: "Static task and role imports are rejected on actual tasks, with the corresponding include alternative. This semantic change is not an automatic fix.", GoodExample: "- include_tasks: example.yml\n", BadExample: "- import_tasks: example.yml\n", Kinds: []Kind{Tasks, Handlers, Playbook}, Scope: "file", Check: checkAnsibleStaticImports},
		{ID: "role-directory-name", Summary: "Use snake_case role directories", Explanation: "Role directories under roles and resources/roles use lowercase snake_case names; each selected source reports its own invalid owner.", GoodExample: "# roles/good_role/tasks/main.yml\n[]\n", BadExample: "# roles/bad-role/tasks/main.yml\n[]\n", Kinds: []Kind{Defaults, Tasks, Handlers, Vars, Generic}, Scope: "file path", Check: checkRoleDirectoryName},
		{ID: "ansible-source-header", Summary: "Keep ordered role source headers", Explanation: "Role defaults, tasks, handlers and vars start with the standard ordered header and a document marker within 20 lines. Extra metadata and continuation comments are allowed.", GoodExample: "####################\n# Title: Example\n# Author(s): someone\n# URL: https://example.com\n# GNU General Public License v3.0\n---\n[]\n", BadExample: "[]\n", Kinds: []Kind{Defaults, Tasks, Handlers, Vars}, Scope: "file", Check: checkAnsibleSourceHeader},
		{ID: "docker-healthcheck-shape", Summary: "Use explicit Docker healthcheck block lists", Explanation: "Healthchecks declare exactly one test block list: NONE alone, CMD plus a nonempty executable and optional scalar argv, or CMD-SHELL plus one nonempty scalar command. Numeric and boolean values follow Ansible string normalization; null and collections are invalid.", GoodExample: "example_role_docker_healthcheck:\n  test:\n    - CMD\n    - curl\n", BadExample: "example_role_docker_healthcheck:\n  test: [CMD, curl]\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkDockerHealthcheckShape},
		{ID: "docker-healthcheck-mode", Summary: "Allow shell healthchecks explicitly", Explanation: "CMD-SHELL needs the exact cmd-shell allowance on its test key. The allowance affects only shell mode and cannot suppress shape or Jinja diagnostics.", GoodExample: "example_role_docker_healthcheck:\n  test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - curl --fail || exit 1\n", BadExample: "example_role_docker_healthcheck:\n  test:\n    - CMD-SHELL\n    - curl --fail || exit 1\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkDockerHealthcheckMode},
		{ID: "lint-directive", Summary: "Keep lint allowances exact and local", Explanation: "Only # saltbox-lint allow cmd-shell is supported, on a Docker healthcheck test key that needs shell execution. Unknown, malformed, misplaced and unnecessary directives fail; quoted and block command contents are not comments.", GoodExample: "example_role_docker_healthcheck:\n  test: # saltbox-lint allow cmd-shell\n    - CMD-SHELL\n    - curl --fail || exit 1\n", BadExample: "# saltbox-lint allow cmd-shell\nexample_role_enabled: true\n", Kinds: kinds, Scope: "file", Check: checkLintDirectives},
		{ID: "docker-aggregate-contract", Summary: "Compose Docker aggregates in override order", Explanation: "Read explicit role-local default before custom layers; preserve the supported network and host formulas, and keep custom environments solely in their final aggregate combine layer. Group conditional bases before combining the custom layer so it applies across every branch.", GoodExample: "example_role_docker_ports_default: [80]\nexample_role_docker_ports_custom: []\nexample_role_docker_ports: \"{{ lookup('role_var', '_docker_ports_default', role='example') + lookup('role_var', '_docker_ports_custom', role='example') }}\"\n", BadExample: "example_role_docker_networks: []\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkDockerAggregateContract},
		{ID: "docker-empty-layers", Summary: "Omit redundant empty Docker layers", Explanation: "Matching empty default/custom lists or maps need a meaningful additional aggregate source; network layers are exempt. Removing declarations requires a deliberate semantic change.", GoodExample: "example_role_docker_ports_default: [80]\nexample_role_docker_ports_custom: []\n", BadExample: "example_role_docker_ports_default: []\nexample_role_docker_ports_custom: []\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkDockerEmptyLayers},
		{ID: "jinja-layout", Summary: "Align multiline Jinja expressions", Explanation: "Align operators, conditional branches, call arguments and dictionary keys with their structural owner. Keep non-block closing braces beside the final token.", GoodExample: "v: \"{{ a\n       | f }}\"", BadExample: "v: \"{{ a\n | f }}\"", Kinds: kinds, Scope: "file", Fixable: true, Check: checkLayout},
		{ID: "jinja-conditional-length", Summary: "Wrap long inline conditionals", Explanation: "A wholly inline Jinja conditional, including one without else, must not occupy a source line longer than 160 Unicode characters.", GoodExample: "v: \"{{ a if enabled else b }}\"", BadExample: "v: \"{{ 'this deliberately long value makes the complete physical source line exceed the conditional length limit' if a_long_condition_name_that_keeps_the_expression_inline else another_long_fallback_value }}\"", Kinds: kinds, Scope: "file", Check: checkConditionalLength},
		{ID: "lookup-conditional-argument", Summary: "Resolve conditionals before lookup calls", Explanation: "Lookup arguments must not contain unquoted conditional expressions, including forms without else. Choose between lookups outside the calls or pass an already resolved value.", GoodExample: "v: \"{{ lookup('a') if enabled else lookup('b') }}\"", BadExample: "v: \"{{ lookup('a', default=x if enabled else y) }}\"", Kinds: kinds, Scope: "file", Check: checkLookupConditional},
		{ID: "role-variable-prefix", Summary: "Use the owning role variable prefix", Explanation: "Top-level role defaults containing _role_ must start with the exact role name derived from their role or resource-role path.", GoodExample: "example_role_enabled: true\n", BadExample: "other_role_enabled: true\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkRoleVariablePrefix},
		{ID: "defaults-sections", Summary: "Keep canonical defaults sections ordered", Explanation: "Recognized defaults section banners are unique and follow their canonical relative order; optional and unknown sections do not create requirements.", GoodExample: "################################\n# Basics\n################################\n################################\n# Docker\n################################\n", BadExample: "################################\n# Docker\n################################\n################################\n# Basics\n################################\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkDefaultsSections},
		{ID: "computed-default-documentation", Summary: "Exclude computed defaults from inventory docs", Explanation: "Owner-local computed _lookup defaults carry one of the two supported documentation-exclusion directives on the immediately preceding physical line.", GoodExample: "# Skip docs\nexample_role_secret_lookup: value\n", BadExample: "example_role_secret_lookup: value\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkComputedDefaultDocumentation},
		{ID: "role-docker-state", Summary: "Keep container state in the shared helper", Explanation: "Role defaults do not declare _role_docker_state because shared Docker lifecycle helpers own container state.", GoodExample: "example_role_enabled: true\n", BadExample: "example_role_docker_state: started\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkRoleDockerState},
		{ID: "docker-image-contract", Summary: "Compose Docker images from role defaults", Explanation: "A role Docker image declaration has repository and tag companion defaults and reads both through explicit owner-targeted role_var lookups.", GoodExample: "example_role_docker_image_repo: example/app\nexample_role_docker_image_tag: latest\nexample_role_docker_image: \"{{ lookup('role_var', '_docker_image_repo', role='example') }}:{{ lookup('role_var', '_docker_image_tag', role='example') }}\"\n", BadExample: "example_role_docker_image: example/app:latest\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkDockerImageContract},
		{ID: "role-lookup-target", Summary: "Target role-aware lookups explicitly", Explanation: "Every live role_var and role_web lookup in defaults specifies role=, including legitimate cross-role reads.", GoodExample: "example_role_value: \"{{ lookup('role_var', '_value', role='other') }}\"\n", BadExample: "example_role_value: \"{{ lookup('role_var', '_value') }}\"\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkRoleLookupTarget},
		{ID: "role-web-contract", Summary: "Use canonical role endpoint defaults", Explanation: "Complete subdomain/domain endpoint families derive host and URL defaults through role_web, with supported schemes and the HTTPS host fallback; repeated component composition uses the same policy.", GoodExample: "example_role_web_subdomain: example\nexample_role_web_domain: example.com\nexample_role_web_url: \"{{ lookup('role_web', role='example', scheme='https') }}\"\n", BadExample: "example_role_web_subdomain: example\nexample_role_web_domain: example.com\nexample_role_web_url: \"https://example.com\"\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkRoleWebContract},
		{ID: "role-var-empty-default", Summary: "Use role_var empty-value defaults", Explanation: "A repeated role_var conditional fallback uses the lookup's default= argument with default_if_empty=true instead of reading the same value twice.", GoodExample: "example_role_value: \"{{ lookup('role_var', '_value', role='example', default=omit, default_if_empty=true) }}\"\n", BadExample: "example_role_value: \"{{ lookup('role_var', '_value', role='example') if (lookup('role_var', '_value', role='example') | length > 0) else omit }}\"\n", Kinds: []Kind{Defaults}, Scope: "file", Check: checkRoleVarEmptyDefault},
	}
}
func checkConditionalLength(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, e := range Expressions(s) {
		if e.Kind != "output" || !e.Complete || len(conditionalOperators(e.Tokens)) == 0 || s.Position(e.Span.Start).Line != s.Position(e.Span.End-1).Line {
			continue
		}
		start := bytes.LastIndexByte(s.Data[:e.Span.Start], '\n') + 1
		end := bytes.IndexByte(s.Data[e.Span.End:], '\n')
		if end < 0 {
			end = len(s.Data)
		} else {
			end += e.Span.End
		}
		if end > start && s.Data[end-1] == '\r' {
			end--
		}
		if utf8.RuneCount(s.Data[start:end]) > 160 {
			ds = append(ds, Diagnostic{Path: s.Path, RuleID: "jinja-conditional-length", Severity: "error", Span: e.Span, Message: "inline conditional exceeds the 160-character source-line limit", Expected: "Wrap the existing conditional operators onto aligned continuation lines."})
		}
	}
	return ds
}
func checkLookupConditional(_ *Project, s *Source) []Diagnostic {
	var ds []Diagnostic
	for _, e := range Expressions(s) {
		reported := map[Span]bool{}
		// Report the conditional's own location once, even through nested lookups.
		for _, call := range Calls(e, "lookup") {
			for _, arg := range call.Arguments {
				for _, index := range conditionalOperators(arg.Tokens) {
					token := arg.Tokens[index]
					if reported[token.Span] {
						continue
					}
					reported[token.Span] = true
					ds = append(ds, Diagnostic{Path: s.Path, RuleID: "lookup-conditional-argument", Severity: "error", Span: token.Span, Message: "conditional expression appears inside a lookup argument", Expected: "Resolve the conditional before passing its value to lookup()."})
				}
			}
		}
	}
	return ds
}

const traefikAdapterGoodExample = `# roles/example/defaults/main.yml
example_role_nginx_web_subdomain: "nginx"
example_role_nginx_traefik_sso_middleware: "{{ traefik_default_sso_middleware }}"
example_role_nginx_traefik_middleware_default: "{{ traefik_default_middleware }}"
example_role_nginx_traefik_middleware_custom: ""
example_role_nginx_traefik_middleware_default_api: "{{ traefik_default_middleware_api }}"
example_role_nginx_traefik_middleware_custom_api: ""
example_role_nginx_traefik_certresolver: "{{ traefik_default_certresolver }}"
example_role_nginx_traefik_enabled: true
example_role_nginx_traefik_api_enabled: false
example_role_nginx_traefik_api_endpoint: ""

---
# roles/example/tasks/main.yml
- name: Execute nginx role
  ansible.builtin.include_role:
    name: nginx
  vars:
    nginx_role_web_subdomain: "{{ lookup('role_var', '_nginx_web_subdomain', role='example') }}"
    nginx_role_traefik_sso_middleware: "{{ lookup('role_var', '_nginx_traefik_sso_middleware', role='example') }}"
    nginx_role_traefik_middleware_default: "{{ lookup('role_var', '_nginx_traefik_middleware_default', role='example') }}"
    nginx_role_traefik_middleware_custom: "{{ lookup('role_var', '_nginx_traefik_middleware_custom', role='example') }}"
    nginx_role_traefik_middleware_default_api: "{{ lookup('role_var', '_nginx_traefik_middleware_default_api', role='example') }}"
    nginx_role_traefik_middleware_custom_api: "{{ lookup('role_var', '_nginx_traefik_middleware_custom_api', role='example') }}"
    nginx_role_traefik_certresolver: "{{ lookup('role_var', '_nginx_traefik_certresolver', role='example') }}"
    nginx_role_traefik_enabled: "{{ lookup('role_var', '_nginx_traefik_enabled', role='example') }}"
    nginx_role_traefik_api_enabled: "{{ lookup('role_var', '_nginx_traefik_api_enabled', role='example') }}"
    nginx_role_traefik_api_endpoint: "{{ lookup('role_var', '_nginx_traefik_api_endpoint', role='example') }}"
`

const traefikRendererGoodExample = `# roles/example/defaults/main.yml
example_role_traefik_middleware_default_api: "{{ traefik_default_middleware_api }}"
example_role_traefik_middleware_custom_api: ""
example_role_traefik_enabled: true
example_role_traefik_api_enabled: true
example_role_traefik_api_endpoint: "PathPrefix(` + "`/api`" + `)"

---
# roles/example/tasks/main.yml
- name: Render API router
  ansible.builtin.copy:
    dest: /traefik/router.yml
    mode: "0644"
    content: |
      http:
        routers:
      {% if example_role_traefik_api_enabled %}
          example-api:
            entrypoints:
              - "websecure"
            rule: "{{ example_role_traefik_api_endpoint }}"
            middlewares:
      {% for item in traefik_middleware_api.split(',') %}
              - {{ item.strip() | string | to_json }}
      {% endfor %}
            service: "example"
      {% endif %}
        services:
          example:
            loadBalancer:
              servers:
                - url: "http://127.0.0.1:8080"
`
