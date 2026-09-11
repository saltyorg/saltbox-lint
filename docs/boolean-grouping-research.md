# Scoped parentheses conventions

These are two separate formatting policies shared by Saltbox and Sandbox.
The observations below were checked read-only on 2026-09-11 against Saltbox
HEAD `a243b198eb32ffe39f6f85afc34e35d9632fe0b1` and its working tree.
`inventories/group_vars/all.yml`, `roles/arr_db/defaults/main.yml`, and
`roles/gluetun/defaults/main.yml` already had local changes; references to those
files describe working-tree bytes, not an unmodified HEAD snapshot.

## When-only convention

`ansible-when-parentheses` requires an outer round-parenthesis pair around the
complete `when` condition unless it is a single variable read. This applies
to each YAML list item independently. Direct field/item access and standalone
`lookup(...)`, `query(...)`, and `q(...)` calls are variable reads. The lookup
arguments do not affect this classification. Negation, operators, tests and
filters applied outside the call still need grouping, as do other calls and
computed item keys.
Already-grouped references and inner precedence groups remain valid.

```yaml
- name: Check readiness
  ansible.builtin.debug:
    msg: ready
  when:
    - enabled
    - result.changed
    - values[item.key]
    - (value is defined)
    - (not enabled)
    - (value | bool)
    - (items | length > 0)
    - (a == b)
    - (a and (b or c))
    - lookup('role_var', '_metrics_enabled', role='traefik')
    - (lookup('vars', 'flag') | bool)
    - (values[index + 1])
```

For example, `when: lookup('role_var', '_metrics_enabled', role='traefik')`
is valid without grouping. Qualified plugin names such as
`lookup('ansible.builtin.vars', 'flag')` are also accepted. Dotted function
names are not recognized as lookup entrypoints by the shared call analysis.

The pair must enclose the entire item: `(a) and (b)` needs `((a) and (b))`.
Native YAML boolean `when` values also need `(true)` or `(false)`, including
list items and explicitly tagged booleans. Other non-string values are outside
this formatting rule. Unsafe values, unresolved aliases, template-dependent
conditions and expressions with incomplete lexical delimiters are skipped.
The shared analyzer does not validate arbitrary Jinja grammar or runtime types.

Actual consumer examples show the intended boundary:

| Source | Current `when` value | Required form |
| --- | --- | --- |
| [Clone Git Repo:25](/srv/git/saltbox/resources/tasks/git/clone_git_repo.yml:25) | `_git_repo_branch_handling` | Already valid. |
| [Clone Git Repo:30](/srv/git/saltbox/resources/tasks/git/clone_git_repo.yml:30) | `_git_repo_dest_stat.stat.exists` | Already valid list item. |
| [Add DNS Record:19](/srv/git/saltbox/resources/roles/dns/tasks/cloudflare/subtasks/add_dns_record.yml:19) | `dns_proxy \| bool` | `(dns_proxy \| bool)` |
| [Add DNS Record:17](/srv/git/saltbox/resources/roles/dns/tasks/cloudflare/subtasks/add_dns_record.yml:17) | `dns_record not in ['@', dns_zone]` | `(dns_record not in ['@', dns_zone])` |
| [Stop Saltbox Docker Containers:19](/srv/git/saltbox/resources/tasks/docker/stop_saltbox_docker_containers.yml:19) | `stop_docker_service_running and stop_docker_containers_docker_controller_service_running` | Enclose the entire conjunction. |

Only structural Ansible `when` owners participate: tasks, handlers, blocks,
include `apply` mappings, and play/role entries recognized by task analysis.
`changed_when`, `failed_when`, `until`, `assert.that`, payload keys named `when`,
inline Jinja conditions, statement `if`/`elif`, and boolean outputs/defaults do
not acquire a grouping requirement from this policy.

## Standalone conditional-result parentheses

`jinja-redundant-conditional-parentheses` diagnoses an enclosing pair around a
standalone output's whole `if/else` result:

```jinja
{{ (a if condition else b) }}
```

Its hint is `{{ a if condition else b }}`. It removes no condition or branch
pairs and imposes no grouping convention on the condition. Both new rules are
diagnostic-only; neither offers an automatic fix.

The read-only source audit observed three standalone whole-result wrappers:
[HTTP middleware:292](/srv/git/saltbox/inventories/group_vars/all.yml:292),
[HTTP API middleware:322](/srv/git/saltbox/inventories/group_vars/all.yml:322),
and [qBittorrent headers:23](/srv/git/saltbox/roles/qbittorrent/defaults/main.yml:23).
Each outer pair was removable in a parse-only comparison without changing its
Jinja AST. These observations do not count optional nested branch groups.
For the HTTP API middleware, the resulting expression is:

```jinja
{{ ''
   if (lookup('role_var', '_traefik_middleware_http_api_insecure', role=role_var_role, default=false) | bool)
   else 'redirect-to-https@docker' }}
```

Grouping remains necessary when the conditional result is consumed by another
operation, such as the [middleware addend:327](/srv/git/saltbox/inventories/group_vars/all.yml:327)
or [Docker labels filter:216](/srv/git/saltbox/resources/tasks/docker/create_docker_container.yml:216):

```jinja
{{ prefix + (a if condition else b) }}
{{ (a if condition else b) | string }}
```

A grouped keyword-argument value such as
`dict(value=(a if condition else b))` also remains untouched: its pair is optional,
but argument groups are outside the standalone-output scope.

Tuples, nested branch groups, statement tags, literal/comment/raw text, unsafe
values and incomplete outputs are outside this standalone-wrapper check.
Keyword-named attributes, filters and tests are identified through the existing
Jinja token analysis. No consumer roles, lookups or filters were executed, and
no consumer bytes were changed.
