# Saltbox boolean and conditional-result grouping

Research date: 2026-09-11 (Europe/Copenhagen). **Boolean grouping policy is awaiting the user's decision.** These observations do not implement a rule or change Saltbox sources.

The current source uses several different boundaries: parentheses around an entire `if/else` result, around its condition, and around terms inside the condition. Removing one layer does not imply removing the others. “Multiple variables” also needs a precise definition: repeated predicates on one lexical root, distinct fields of that root, and lookup arguments are all present.

## Source and audit boundary

- Read-only working tree: `/srv/git/saltbox`, HEAD `a243b198eb32ffe39f6f85afc34e35d9632fe0b1`.
- Existing modified files: `inventories/group_vars/all.yml`, `roles/arr_db/defaults/main.yml`, and `roles/gluetun/defaults/main.yml`. Examples below refer to these **working-tree bytes**, including existing edits, rather than claiming HEAD alone reproduces them.
- Enumerated all 452 tracked `.yml`/`.yaml` files and 40 tracked `.j2` files. Used the public [`Expressions`](/opt/git/saltbox-lint/lint/jinja.go:42), [`RuntimeExpressions`](/opt/git/saltbox-lint/lint/tasks.go:146), and [`VariableReads`](/opt/git/saltbox-lint/lint/jinja_reads.go:10) helpers. Templates were wrapped in an in-memory YAML literal for lexical extraction; every template token was checked against its original byte span, with zero mismatches.
- The primary count includes inline output `if` conditions, `if`/`elif` tag conditions, and the helpers' recognized implicit Ansible string conditions. It excludes YAML boolean literals, unsafe values, comments/raw blocks, untracked files, other extensions, and boolean-looking expressions outside these selected sites. Sequence conditions count once per string item. No roles, lookups, filters, or expressions were executed.

| Selected condition sites | Count | Entire condition has an outer pair |
| --- | ---: | ---: |
| Inline output `if` conditions | 407 | 227 |
| Implicit Ansible conditions | 1,248 | 357 |
| Jinja `if` tag conditions | 77 | 10 |
| Jinja `elif` tag conditions | 7 | 0 |
| **Total** | **1,739** | **594** |

All selected conditions parsed with local Jinja 3.1.2. The tag rows comprise 78 template sites and six `if` tags embedded in task YAML. These are bounded syntactic counts, not a count of all runtime booleans or all values Ansible might evaluate.

## The specific middleware example

[`inventories/group_vars/all.yml:320`](/srv/git/saltbox/inventories/group_vars/all.yml:320) declares `traefik_default_middleware_default_http_api`. Its second item is:

```jinja
{{ (''
         if (lookup('role_var', '_traefik_middleware_http_api_insecure', role=role_var_role, default=false) | bool)
         else 'redirect-to-https@docker') }}
```

There are three kinds of parentheses here:

1. The pair enclosing the entire `'' if … else …` result is redundant: the expression stands alone.
2. The pair enclosing `lookup(…) | bool` groups the condition. Removing it also preserves this parse, but its style belongs to the pending boolean policy.
3. `lookup(…)` uses function-call syntax. Those parentheses are not optional grouping.

The user's requested result-parenthesis behavior would remove only the first pair here. In contrast, the conditional result beginning at [`all.yml:327`](/srv/git/saltbox/inventories/group_vars/all.yml:327) is an operand of `+`; removing its enclosing pair changes the parse from addition to a conditional expression. Likewise, [`create_docker_container.yml:216`](/srv/git/saltbox/resources/tasks/docker/create_docker_container.yml:216) uses `(docker_labels_common if _docker_vars._docker_labels_use_common else {}) | combine(_docker_vars._docker_labels)`: its pair makes the filter apply to either result.

A narrow scan found **three output expressions with a conditional AST root and an outermost pair enclosing the whole result**: [`all.yml:292`](/srv/git/saltbox/inventories/group_vars/all.yml:292), [`all.yml:322`](/srv/git/saltbox/inventories/group_vars/all.yml:322), and [`qbittorrent/defaults/main.yml:23`](/srv/git/saltbox/roles/qbittorrent/defaults/main.yml:23). Each outer pair could be removed without changing its AST. This does not count optional nested branch groups, such as the fallback conditional at [`all.yml:218`](/srv/git/saltbox/inventories/group_vars/all.yml:218).

## Representative current condition variants

Snippets below are exact condition fragments; a fragment need not be the entire source scalar. “Optional” describes parsing, not a selected style policy.

| Variant | Current fragment and source | Boundary illustrated |
| --- | --- | --- |
| Bare flag | `cloudflare_scoped_token_is_enabled` — [all.yml:55](/srv/git/saltbox/inventories/group_vars/all.yml:55) | One predicate without grouping. |
| Grouped bare flag | `(traefik_enable_zerossl)` — [traefik/defaults:439](/srv/git/saltbox/roles/traefik/defaults/main.yml:439) | Optional grouping also occurs around a single flag. |
| Negated flag | `(not zerossl_is_enabled)` and `not zerossl_is_enabled` — [all.yml:212](/srv/git/saltbox/inventories/group_vars/all.yml:212), [219](/srv/git/saltbox/inventories/group_vars/all.yml:219) | Both grouped and ungrouped forms exist. |
| Boolean filter | `(traefik.hsts | bool)`; `dns_proxy | bool` — [all.yml:262](/srv/git/saltbox/inventories/group_vars/all.yml:262), [DNS task:19](/srv/git/saltbox/resources/roles/dns/tasks/cloudflare/subtasks/add_dns_record.yml:19) | Filter application does not itself require an outer condition pair. |
| Length test | `(traefik_role_middleware_sso | length > 0)`; `{% if service_after | length > 0 %}` — [all.yml:271](/srv/git/saltbox/inventories/group_vars/all.yml:271), [qbittorrent service template:14](/srv/git/saltbox/roles/qbittorrent/templates/qbittorrent.service.j2:14) | One predicate can contain a filter and comparison. |
| Two flags | `(traefik_error_pages_enabled and traefik_error_pages_role_enabled)` — [all.yml:238](/srv/git/saltbox/inventories/group_vars/all.yml:238) | Whole-condition grouping, without per-flag groups. |
| Two flags, ungrouped | `stop_docker_service_running and stop_docker_containers_docker_controller_service_running` — [stop containers:19](/srv/git/saltbox/resources/tasks/docker/stop_saltbox_docker_containers.yml:19) | Implicit conditions also contain ungrouped conjunctions. |
| Repeated same value | `(not traefik_default_middleware_custom_http_api.startswith(',') and traefik_default_middleware_custom_http_api | length > 0)` — [all.yml:328](/srv/git/saltbox/inventories/group_vars/all.yml:328) | Two predicates, one lexical root. |
| Same root, distinct fields | `(system is defined) and (system.timezone is defined) and ('auto' not in system.timezone | lower)` — [all.yml:149](/srv/git/saltbox/inventories/group_vars/all.yml:149) | Per-term groups; no whole-condition pair. |
| Comparison to a constant | `arr_type == 'whisparr'` — [arr_db/defaults:31](/srv/git/saltbox/roles/arr_db/defaults/main.yml:31) | One variable root and one constant. |
| Comparison between values | `item.username == authentik_role_default_user` — [authentik setup:315](/srv/git/saltbox/roles/authentik/tasks/subtasks/setup.yml:315) | Two variable roots, one comparison, no `and`/`or`. |
| Membership | `dns_record not in ['@', dns_zone]` — [DNS task:17](/srv/git/saltbox/resources/roles/dns/tasks/cloudflare/subtasks/add_dns_record.yml:17) | One membership predicate can read multiple roots. |
| Defined tests | `((traefik_google_kid is defined) and (traefik_google_hmacencoded is defined))` — [all.yml:225](/srv/git/saltbox/inventories/group_vars/all.yml:225) | Both whole-condition and per-predicate pairs. |
| Lookup with variable arguments | `(lookup('role_var', '_traefik_autodetect_enabled', role=role_var_role, default=traefik_default_autodetect) | bool)` — [all.yml:253](/srv/git/saltbox/inventories/group_vars/all.yml:253) | One predicate reads two roots through arguments; quoted lookup names are strings. |
| Two lookups with literal arguments | `(lookup('role_var', '_lan_ip', role='plex') | length > 0) and lookup('role_var', '_open_main_ports', role='plex')` — [plex/defaults:180](/srv/git/saltbox/roles/plex/defaults/main.yml:180) | Two predicates, zero lexical variable-read roots. Runtime lookup targets are unresolved. |
| Mixed precedence | `lookup('role_var', '_access_control_whitelist_host', role='authelia') and (dns_ipv4_enabled or dns_ipv6_enabled)` — [authelia/defaults:86](/srv/git/saltbox/roles/authelia/defaults/main.yml:86) | Inner `or` pair affects meaning; outer whole-condition pair is absent. |
| Negated compound | `not (dns_ipv4_enabled or dns_ipv6_enabled)` — [ddns task:15](/srv/git/saltbox/roles/ddns/tasks/main.yml:15) | Inner pair is necessary to negate the combined result. |
| `elif` comparison | `{% elif service.type == 'single_instance_apikey' %}` — [motd template:41](/srv/git/saltbox/roles/motd/templates/motd.yml.j2:41) | Same comparison syntax occurs in statement tags. |

Other implicit contexts use the same variants: `changed_when: uv_python_install.rc == 0` ([python task:92](/srv/git/saltbox/roles/python/tasks/main.yml:92)); `failed_when: (plex_db_integrity_check.stdout != 'ok')` ([plex_db task:39](/srv/git/saltbox/roles/plex_db/tasks/main2.yml:39)); `until: (start_docker_result is succeeded)` ([start container:39](/srv/git/saltbox/resources/tasks/docker/start_docker_container.yml:39)); and assert items `arr_db_main_database_matches | length == 1` / `arr_logs_db.stat.exists` ([arr_db database:31](/srv/git/saltbox/roles/arr_db/tasks/database.yml:31)).

YAML lists are another boundary: [`clone_git_repo.yml:28`](/srv/git/saltbox/resources/tasks/git/clone_git_repo.yml:28) has separate `when` items `_git_repo_branch_handling` and `_git_repo_dest_stat.stat.exists`. Ansible combines `when` lists with AND; `failed_when` and `changed_when` lists use the same convention, while `assert.that` accepts condition expressions. There is no single source expression to wrap around an entire YAML list. [Ansible conditions](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_conditionals.html), [failure/change conditions](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_error_handling.html), [assert](https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/assert_module.html).

## Why counting variables is a policy choice

Of the selected sites, **330 contain `and`/`or` somewhere in their AST**: 191 read at least two distinct lexical roots, 138 read exactly one, and one reads none. Conversely, **21 lookup conditions without `and`/`or` read at least two roots**. These feature counts overlap other categories. `VariableReads` excludes callees, filters, tests, attribute names, and keyword labels; it includes variable-valued arguments and does not resolve lookups. Therefore these counts cannot stand in for runtime dependency counts.

Direct computed outputs also exist outside the 1,739 condition sites. A supplemental scan of non-generic sources found **82 outputs whose AST root is `And`, `Or`, `Not`, `Compare`, or `Test`** (50/10/8/13/1 respectively), with zero parse failures. Examples are `{{ cloudflare_api_key_is_enabled or cloudflare_scoped_token_is_enabled }}` ([all.yml:53](/srv/git/saltbox/inventories/group_vars/all.yml:53)) and `{{ 'container:' in lookup('role_var', '_docker_network_mode', role=role_var_role, default=docker_networks_name_common) }}` ([all.yml:519](/srv/git/saltbox/inventories/group_vars/all.yml:519)). This supplemental set excludes bare variables and filtered values, whose runtime type is unknown; it is not all boolean outputs.

## Syntax constraints and decisions still open

Jinja permits grouping for precedence and readability. Its parser gives `and` higher precedence than `or`; negating a combined expression requires grouping that combined expression. Inline `if/else` results can themselves become operands or filter inputs. These syntax constraints are independent of a lint style choice. [Jinja expressions](https://jinja.palletsprojects.com/en/stable/templates/#expressions), [Jinja 3.1.2 parser](https://github.com/pallets/jinja/blob/3.1.2/src/jinja2/parser.py).

Seven local, parse-only probes removed individual pairs in memory. They confirmed the distinction: standalone result / condition-filter pairs preserved the AST; the conditional addend, filtered conditional result, `or` under `and`, and compound under `not` changed it. Grouping an `and` branch before `or` in [`backup/snapshot.yml:29`](/srv/git/saltbox/roles/backup/tasks/snapshot.yml:29) was optional. These are syntax probes, not runtime acceptance tests.

The user's decisions needed before a boolean rule are:

1. **Trigger:** does “multiple variables” mean multiple predicates joined by `and`/`or`, or multiple distinct variable reads? How should repeated roots, separate fields, variable-valued lookup arguments, and literal-only lookups be treated?
2. **Simple predicates:** should flags, `not` flags, `| bool`, length/comparison/membership/defined predicates allow, require, or reject optional outer grouping?
3. **Inner groups:** after requiring a whole-condition pair, should optional per-term groups remain allowed? Necessary precedence groups must remain.
4. **Contexts:** should the same convention cover inline conditions, template `if`/`elif`, implicit task conditions, and direct computed outputs? YAML list items need individual treatment.
5. **Conditional results:** the stated standalone-result preference is separate. Any later implementation must distinguish an unnecessary enclosing result pair from grouping required by an enclosing operation, and decide whether nested fallback-result pairs are in scope.

Reproduction evidence is in `/tmp/saltbox-boolean-audit/`: `extract.go`, `classify.py`, `probe.py`, `direct.py`, their JSON/JSONL outputs, `metadata.json`, and SHA-256 hashes for every enumerated source. Run `go run /tmp/saltbox-boolean-audit/extract.go` from `/opt/git/saltbox-lint`, redirecting output to `expressions.jsonl`, then run the three Python scripts. The helper snapshot was lint HEAD `9f5968bf3df2553d5c291077c42cbaaee07269a6`; helper-file hashes pin the actual working-tree implementation. Tools were Go 1.27.1, Python 3.12.3, and Jinja 3.1.2. The final source hash check found no changed enumerated source bytes during the audit, and the original three-file dirty status was preserved.
