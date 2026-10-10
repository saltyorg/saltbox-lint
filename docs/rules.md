# Rule reference

Generated from the rule registry. Run `make rules-update` to refresh it.

This reference describes source-built, unreleased functionality. The published v0.1.0 CLI does not export registry JSON or source explanations.

- [ansible-source-header](#ansible-source-header)
- [ansible-static-import](#ansible-static-import)
- [ansible-tag-name](#ansible-tag-name)
- [ansible-when-list](#ansible-when-list)
- [ansible-when-parentheses](#ansible-when-parentheses)
- [cloudflare-auth-contract](#cloudflare-auth-contract)
- [computed-default-documentation](#computed-default-documentation)
- [defaults-sections](#defaults-sections)
- [docker-aggregate-contract](#docker-aggregate-contract)
- [docker-empty-layers](#docker-empty-layers)
- [docker-healthcheck-mode](#docker-healthcheck-mode)
- [docker-healthcheck-shape](#docker-healthcheck-shape)
- [docker-helper-arguments](#docker-helper-arguments)
- [docker-image-contract](#docker-image-contract)
- [docker-vars-policy](#docker-vars-policy)
- [git-clone-resource](#git-clone-resource)
- [jinja-conditional-length](#jinja-conditional-length)
- [jinja-layout](#jinja-layout)
- [jinja-redundant-conditional-parentheses](#jinja-redundant-conditional-parentheses)
- [lint-directive](#lint-directive)
- [lookup-conditional-argument](#lookup-conditional-argument)
- [network-health-contract](#network-health-contract)
- [role-directory-name](#role-directory-name)
- [role-docker-state](#role-docker-state)
- [role-lookup-target](#role-lookup-target)
- [role-var-empty-default](#role-var-empty-default)
- [role-variable-prefix](#role-variable-prefix)
- [role-web-contract](#role-web-contract)
- [section-spacing](#section-spacing)
- [svm-github-api-resource](#svm-github-api-resource)
- [template-partial-coverage](#template-partial-coverage)
- [template-syntax](#template-syntax)
- [traefik-adapter-contract](#traefik-adapter-contract)
- [traefik-api-contract](#traefik-api-contract)
- [traefik-renderer-contract](#traefik-renderer-contract)

## ansible-source-header

Keep ordered role source headers

Role defaults, tasks, handlers and vars start with the standard ordered header and a document marker within 20 lines. Extra metadata and continuation comments are allowed. Complete unambiguous metadata can be reordered with its comments; incomplete headers remain manual.

Source kinds: defaults, handlers, tasks, vars. Scope: file. Automatic fix: true.

Expected example:

```yaml
####################
# Title: Example
# Author(s): someone
# URL: https://example.com
# GNU General Public License v3.0
---
[]
```

Violation example:

```yaml
[]
```

## ansible-static-import

Use dynamic Ansible includes

Static task and role imports are rejected on actual tasks, with the corresponding include alternative. This semantic change is not an automatic fix.

Source kinds: handlers, playbook, tasks. Scope: file. Automatic fix: false.

Expected example:

```yaml
- include_tasks: example.yml
```

Violation example:

```yaml
- import_tasks: example.yml
```

## ansible-tag-name

Use literal kebab-case Ansible tags

Actual task, play, role and include-apply tags must be literal lowercase kebab-case strings. Quote string spellings of YAML typed values.

Source kinds: handlers, playbook, tasks. Scope: file. Automatic fix: false.

Expected example:

```yaml
- debug: {msg: ok}
  tags: good-tag
```

Violation example:

```yaml
- debug: {msg: ok}
  tags: Bad_tag
```

## ansible-when-list

Split when conjunctions into block lists

Represent an unparenthesized top-level logical and in a structural when scalar or list item as separate block-list items. Preserve explicit groups as indivisible conditions, retain operand order, and group nontrivial individual conditions. Keep conjunctions beneath or, negation, comparisons, filters, calls and conditional results intact. Other condition fields and Jinja conditions are outside this convention.

Source kinds: handlers, playbook, tasks. Scope: structural when fields. Automatic fix: true.

Expected example:

```yaml
- name: Example
  ansible.builtin.debug: {msg: ok}
  when:
    - (value is defined)
    - value
```

Violation example:

```yaml
- name: Example
  ansible.builtin.debug: {msg: ok}
  when: (value is defined) and value
```

## ansible-when-parentheses

Group nontrivial when conditions

Enclose the complete when condition in parentheses unless it is a single variable read, including direct field/item access or a standalone lookup, query or q call. Operations outside a lookup still need grouping. Unparenthesized top-level conjunctions belong to ansible-when-list instead; complete explicit groups remain valid. Check each indivisible when list item on structural Ansible owners; preserve nested precedence. Other condition fields and Jinja conditions are outside this convention.

Source kinds: handlers, playbook, tasks. Scope: structural when fields. Automatic fix: true.

Expected example:

```yaml
- name: Example
  ansible.builtin.debug: {msg: ok}
  when:
    - lookup('role_var', '_metrics_enabled', role='traefik')
    - (value is defined)
```

Violation example:

```yaml
- name: Example
  ansible.builtin.debug: {msg: ok}
  when: value is defined
```

## cloudflare-auth-contract

Read normalized Cloudflare authentication

Runtime expressions use normalized Cloudflare authentication variables instead of raw account members. Literal text and unrelated object attributes are not global account reads.

Source kinds: defaults, generic, handlers, inventory, playbook, tasks, vars. Scope: file. Automatic fix: false.

Expected example:

```yaml
value: '{{ cloudflare_scoped_token }}'
```

Violation example:

```yaml
value: '{{ cloudflare.api }}'
```

## computed-default-documentation

Exclude computed defaults from inventory docs

Owner-local computed _lookup defaults carry one of the two supported documentation-exclusion directives on the immediately preceding physical line. Safe block declarations can receive a Skip docs comment without changing their YAML data.

Source kinds: defaults. Scope: file. Automatic fix: true.

Expected example:

```yaml
# Skip docs
example_role_secret_lookup: value
```

Violation example:

```yaml
example_role_secret_lookup: value
```

## defaults-sections

Keep canonical defaults sections ordered

Recognized defaults section banners are unique and follow their canonical relative order; optional and unknown sections do not create requirements.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
################################
# Basics
################################
################################
# Docker
################################
```

Violation example:

```yaml
################################
# Docker
################################
################################
# Basics
################################
```

## docker-aggregate-contract

Compose Docker aggregates in override order

Read explicit role-local default before custom layers; preserve the supported network and host formulas, and keep custom environments solely in their final aggregate combine layer. Group conditional bases before combining the custom layer so it applies across every branch.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_docker_ports_default: [80]
example_role_docker_ports_custom: []
example_role_docker_ports: "{{ lookup('role_var', '_docker_ports_default', role='example') + lookup('role_var', '_docker_ports_custom', role='example') }}"
```

Violation example:

```yaml
example_role_docker_networks: []
```

## docker-empty-layers

Omit redundant empty Docker layers

Matching empty default/custom lists or maps need a meaningful additional aggregate source; network layers are exempt. Removing declarations requires a deliberate semantic change.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_docker_ports_default: [80]
example_role_docker_ports_custom: []
```

Violation example:

```yaml
example_role_docker_ports_default: []
example_role_docker_ports_custom: []
```

## docker-healthcheck-mode

Allow shell healthchecks explicitly

CMD-SHELL needs the exact cmd-shell allowance on its test key. The allowance affects only shell mode and cannot suppress shape or Jinja diagnostics.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_docker_healthcheck:
  test: # saltbox-lint allow cmd-shell
    - CMD-SHELL
    - curl --fail || exit 1
```

Violation example:

```yaml
example_role_docker_healthcheck:
  test:
    - CMD-SHELL
    - curl --fail || exit 1
```

## docker-healthcheck-shape

Use explicit Docker healthcheck block lists

Healthchecks declare exactly one test block list: NONE alone, CMD plus a nonempty executable and optional scalar argv, or CMD-SHELL plus one nonempty scalar command. Numeric and boolean values follow Ansible string normalization; null and collections are invalid. Otherwise valid flow lists with preservable scalar spellings and comments can be converted.

Source kinds: defaults. Scope: file. Automatic fix: true.

Expected example:

```yaml
example_role_docker_healthcheck:
  test:
    - CMD
    - curl
```

Violation example:

```yaml
example_role_docker_healthcheck:
  test: [CMD, curl]
```

## docker-helper-arguments

Pass public Docker lifecycle helper arguments

Docker lifecycle include vars use optional var_prefix, never the private _var_prefix fact.

Source kinds: handlers, playbook, tasks. Scope: file. Automatic fix: false.

Expected example:

```yaml
- include_tasks: /docker/create_docker_container.yml
  vars: {var_prefix: example}
```

Violation example:

```yaml
- include_tasks: /docker/create_docker_container.yml
  vars: {_var_prefix: example}
```

## docker-image-contract

Compose Docker images from role defaults

A role Docker image declaration has repository and tag companion defaults and reads both through explicit owner-targeted role_var lookups.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_docker_image_repo: example/app
example_role_docker_image_tag: latest
example_role_docker_image: "{{ lookup('role_var', '_docker_image_repo', role='example') }}:{{ lookup('role_var', '_docker_image_tag', role='example') }}"
```

Violation example:

```yaml
example_role_docker_image: example/app:latest
```

## docker-vars-policy

Keep shared Docker suffix policies consistent

Actual docker_vars lookup specs share one policy across Docker resources. Only literal omit:true declarations permit sparse fallback accesses, including implicit Ansible conditions. Invalid required sibling context is reported on the selected dependent source.

Source kinds: tasks. Scope: shared Docker resources. Automatic fix: false.

Expected example:

```yaml
- debug: {msg: ok}
```

Violation example:

```yaml
- debug: {msg: '{{ _docker_vars._docker_memory | default(0) }}'}
```

## git-clone-resource

Keep Git actions in the shared clone resource

Only the exact canonical Saltbox clone resource may invoke Git. Task and handler lists, nested blocks and action forms share this policy.

Source kinds: handlers, playbook, tasks. Scope: project identity. Automatic fix: false.

Expected example:

```yaml
- include_tasks: /resources/tasks/git/clone_git_repo.yml
```

Violation example:

```yaml
- git: {repo: example}
```

## jinja-conditional-length

Wrap long inline conditionals

A wholly inline Jinja conditional, including one without else, must not occupy a source line longer than 160 Unicode characters.

Source kinds: defaults, generic, handlers, inventory, playbook, tasks, vars. Scope: file. Automatic fix: true.

Expected example:

```yaml
v: "{{ a if enabled else b }}"
```

Violation example:

```yaml
v: "{{ 'this deliberately long value makes the complete physical source line exceed the conditional length limit' if a_long_condition_name_that_keeps_the_expression_inline else another_long_fallback_value }}"
```

## jinja-layout

Align multiline Jinja expressions

Align operators, conditional branches, call arguments and dictionary keys with their structural owner. Keep non-block closing braces beside the final token.

Source kinds: defaults, generic, handlers, inventory, playbook, tasks, vars. Scope: file. Automatic fix: true.

Expected example:

```yaml
v: "{{ a
       | f }}"
```

Violation example:

```yaml
v: "{{ a
 | f }}"
```

## jinja-redundant-conditional-parentheses

Omit standalone conditional result wrappers

A standalone Jinja output conditional with if and else does not need an enclosing result pair. Preserve groups used by operators, filters, calls, tuples and nested branches. This does not impose grouping on the condition.

Source kinds: defaults, generic, handlers, inventory, playbook, tasks, vars. Scope: standalone YAML Jinja outputs. Automatic fix: true.

Expected example:

```yaml
value: "{{ a if condition else b }}"
```

Violation example:

```yaml
value: "{{ (a if condition else b) }}"
```

## lint-directive

Keep lint allowances exact and local

Only # saltbox-lint allow cmd-shell is supported, on a Docker healthcheck test key that needs shell execution. Unknown, malformed, misplaced and unnecessary directives fail; quoted and block command contents are not comments.

Source kinds: defaults, generic, handlers, inventory, playbook, tasks, vars. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_docker_healthcheck:
  test: # saltbox-lint allow cmd-shell
    - CMD-SHELL
    - curl --fail || exit 1
```

Violation example:

```yaml
# saltbox-lint allow cmd-shell
example_role_enabled: true
```

## lookup-conditional-argument

Resolve conditionals before lookup calls

Lookup arguments must not contain unquoted conditional expressions, including forms without else. Choose between lookups outside the calls or pass an already resolved value.

Source kinds: defaults, generic, handlers, inventory, playbook, tasks, vars. Scope: file. Automatic fix: false.

Expected example:

```yaml
v: "{{ lookup('a') if enabled else lookup('b') }}"
```

Violation example:

```yaml
v: "{{ lookup('a', default=x if enabled else y) }}"
```

## network-health-contract

Pass explicit network health inputs

Network health includes pass source and target in their own vars; the shared resource cannot read caller-local Docker facts.

Source kinds: handlers, playbook, tasks. Scope: file. Automatic fix: false.

Expected example:

```yaml
- include_tasks: network_container_health_status.yml
  vars: {network_container_source: example, network_container_target: gluetun}
```

Violation example:

```yaml
- include_tasks: network_container_health_status.yml
```

## role-directory-name

Use snake_case role directories

Role directories under roles and resources/roles use lowercase snake_case names; each selected source reports its own invalid owner.

Source kinds: defaults, generic, handlers, tasks, vars. Scope: file path. Automatic fix: false.

Expected example:

```yaml
# roles/good_role/tasks/main.yml
[]
```

Violation example:

```yaml
# roles/bad-role/tasks/main.yml
[]
```

## role-docker-state

Keep container state in the shared helper

Role defaults do not declare _role_docker_state because shared Docker lifecycle helpers own container state.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_enabled: true
```

Violation example:

```yaml
example_role_docker_state: started
```

## role-lookup-target

Target role-aware lookups explicitly

Every live role_var and role_web lookup in defaults specifies role=, including legitimate cross-role reads.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_value: "{{ lookup('role_var', '_value', role='other') }}"
```

Violation example:

```yaml
example_role_value: "{{ lookup('role_var', '_value') }}"
```

## role-var-empty-default

Use role_var empty-value defaults

A repeated role_var conditional fallback uses the lookup's default= argument with default_if_empty=true instead of reading the same value twice.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_value: "{{ lookup('role_var', '_value', role='example', default=omit, default_if_empty=true) }}"
```

Violation example:

```yaml
example_role_value: "{{ lookup('role_var', '_value', role='example') if (lookup('role_var', '_value', role='example') | length > 0) else omit }}"
```

## role-variable-prefix

Use the owning role variable prefix

Top-level role defaults containing _role_ use their exact owning role prefix. All top-level defaults also avoid another locally established role's instance and role-default namespaces, including _name declarations and overlapping companion prefixes. Valid local defaults, tasks, handlers or vars establish an owner; missing or malformed context does not. Explicit cross-role reads and inventory overrides remain valid. Namespace renames require a deliberate semantic change.

Source kinds: defaults. Scope: role defaults and local namespace owners. Automatic fix: false.

Expected example:

```yaml
example_name: example
example_role_enabled: true
```

Violation example:

```yaml
other_role_enabled: true
```

## role-web-contract

Use canonical role endpoint defaults

Complete subdomain/domain endpoint families derive host and URL defaults through role_web, with supported schemes and the HTTPS host fallback; direct string composition of matching subdomain and domain lookups uses the same policy.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_web_subdomain: example
example_role_web_domain: example.com
example_role_web_url: "{{ lookup('role_web', role='example', scheme='https') }}"
```

Violation example:

```yaml
example_role_web_subdomain: example
example_role_web_domain: example.com
example_role_web_url: "https://example.com"
```

## section-spacing

Separate section banners from variables

Named three-line section banners need at least one blank line before their variables. Canonical and custom titles share this spacing policy; empty sections and literal scalar contents are ignored. Fixes preserve existing spacing and variable documentation comments.

Source kinds: defaults, generic, inventory, vars. Scope: file. Automatic fix: true.

Expected example:

```yaml
################################
# Settings
################################

value: true
```

Violation example:

```yaml
################################
# Settings
################################
value: true
```

## svm-github-api-resource

Keep SVM access in the GitHub fallback resource

Only the exact canonical Saltbox GitHub API resource may read global svm; lexical bindings, attribute names and literal text are not reads.

Source kinds: defaults, generic, handlers, inventory, playbook, tasks, vars. Scope: project identity. Automatic fix: false.

Expected example:

```yaml
value: '{{ github_api_result }}'
```

Violation example:

```yaml
value: '{{ svm }}'
```

## template-partial-coverage

Explain unsupported static template coverage

Unsupported configuration, extension statements, expression grammar and scanner bounds receive an explicit partial-coverage warning. Supported checks do not validate runtime values, load imports or render output. Templates never receive fixes.

Source kinds: template. Scope: explicit template. Automatic fix: false.

Expected example:

```yaml
{{ value }}
```

Violation example:

```yaml
{% custom_extension value %}
```

## template-syntax

Check supported template delimiters and blocks

Explicit templates receive bounded, read-only delimiter and block checks. Literal text, quoted delimiters, comments and raw content are preserved. Unsupported expression or statement grammar is partial coverage, never a fabricated syntax error. No layout or style policy applies.

Source kinds: template. Scope: explicit template. Automatic fix: false.

Expected example:

```yaml
{% if enabled %}{{ value }}{% endif %}
```

Violation example:

```yaml
{% if enabled %}{{ value }}
```

## traefik-adapter-contract

Forward namespaced Traefik contracts in role includes

Matching include_role vars forward each namespaced Traefik suffix through an owner-targeted role_var call; the owning defaults declare the same contract. Context and forwarding diagnostics stay on their owning selected source.

Source kinds: defaults, handlers, tasks. Scope: role defaults and includes. Automatic fix: false.

Expected example:

```yaml
# roles/example/defaults/main.yml
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
```

Violation example:

```yaml
- include_role: {name: nginx}
  vars:
    nginx_role_web_subdomain: "{{ lookup('role_var', '_nginx_web_subdomain', role='example') }}"
```

## traefik-api-contract

Declare the complete Traefik API contract

Traefik-enabled declarations require the API middleware default/custom pair in order, API enablement and endpoint defaults. Legacy middleware declarations are unsupported even without enablement. Direct and namespaced API endpoint defaults must be empty strings or valid literal Traefik v3 HTTP rules. Runtime templates and unresolved aliases are not evaluated.

Source kinds: defaults. Scope: file. Automatic fix: false.

Expected example:

```yaml
example_role_traefik_middleware_default_api: "{{ traefik_default_middleware_api }}"
example_role_traefik_middleware_custom_api: ""
example_role_traefik_enabled: false
example_role_traefik_api_enabled: false
example_role_traefik_api_endpoint: "PathPrefix(`/api`)"
```

Violation example:

```yaml
example_role_traefik_enabled: false
example_role_traefik_api_endpoint: "/api"
```

## traefik-renderer-contract

Consume the API contract in Traefik renderers

Roles declaring Traefik use the shared Docker renderer or consume API middleware, enablement and endpoint in actual copy content or referenced templates. Actual retirement fail paths are exempt; comments and debug text do not establish rendering.

Source kinds: defaults, handlers, tasks, template. Scope: role defaults, tasks and explicitly selected referenced templates. Automatic fix: false.

Expected example:

```yaml
# roles/example/defaults/main.yml
example_role_traefik_middleware_default_api: "{{ traefik_default_middleware_api }}"
example_role_traefik_middleware_custom_api: ""
example_role_traefik_enabled: true
example_role_traefik_api_enabled: true
example_role_traefik_api_endpoint: "PathPrefix(`/api`)"

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
```

Violation example:

```yaml
example_role_traefik_enabled: false
```
