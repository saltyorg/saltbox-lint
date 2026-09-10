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
