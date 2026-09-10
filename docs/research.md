# Saltbox Lint legacy and integration research

Research date: 2026-09-10. This records the primary-source research for the accepted Go
rewrite. Legacy observations below describe the frozen Python reference, not
new-engine acceptance results; see [the migration catalog](rule-migration.md).
The first implementation remains scoped to this repository: broader YAML
coverage, file/workspace VS Code tasks, safe `check --fix` with `--diff`, and a
GitHub Action with consumer examples. Consumer repositories remain unchanged.

## Sources and reproducible observations

| Source | Verified identity |
| --- | --- |
| Saltbox checkout | `a243b198eb32ffe39f6f85afc34e35d9632fe0b1` |
| `scripts/saltbox-linter.py` Git blob | `9d08d8f89ae4a5530380b901fd3360d205436961` |
| Sandbox checkout | `1d1c40e3e17b97afdd318e35b8663a0c9563dc20` |
| Local Saltbox `tests/test_saltbox_linter.py` SHA-256 | `ccaf2a27ebb3746ed2b9d28a4dc9d100de3adb35b42e7cab97f917e144ef4ada` |

The [frozen Python source][legacy] is the migration reference. `git hash-object
scripts/saltbox-linter.py` also returned the recorded blob for the working file.
The local test file is **untracked**: `git ls-files --error-unmatch
tests/test_saltbox_linter.py` returned exit 1. Its contents are useful regression
evidence, not a complete or tracked policy specification.

Fresh read-only probes in this research task:

```text
PYTHONDONTWRITEBYTECODE=1 python3 /srv/git/saltbox/tests/test_saltbox_linter.py
Ran 47 tests in 0.041s
OK

len(LINTER_RULES)
40

SaltboxLinter(Path('examples.yaml')).lint_shared_jinja()
[]
```

The test-method count was also checked with Python's AST: 47. The example probe
called the legacy class directly because its public CLI accepts only a
repository root containing `roles/`. These observations do not establish full
corpus cleanliness, adequate coverage, or correctness of the new implementation.
No Ansible roles, VM workloads, or authenticated remote mutations were run.

## Lessons from other linters

| Tool | Verified behavior | Application to this project |
| --- | --- | --- |
| ansible-lint | Accepts file/path targets, lists rules, separates findings on stdout from logging on stderr, supports GitHub annotations and SARIF. Custom rules distinguish line checks from normalized task/handler checks. | Share source classification and task analysis; keep Saltbox rules separate from presentation. [Usage][ansible-usage], [custom rules][ansible-rules]. |
| yamllint | Accepts files, directories, and stdin; its parsable format includes file, line, column, severity, and rule. | File targeting and stable machine output belong in the CLI from the start. [Quickstart][yamllint]. |
| Ruff | Supports `--stdin-filename`, selected paths, rule selection, and multiple report formats. Its editor documentation demonstrates stdin-based invocation. | Preserve document identity for unsaved input without temporary files. [CLI][ruff-cli], [editor setup][ruff-setup]. |
| actionlint | Accepts chosen YAML workflows and stdin; provides structured output and GitHub integration. Optional external analyzers introduce process overhead. | A focused domain linter is a useful model; broad Saltbox coverage does not require an external-linter orchestration framework. [Usage][actionlint]. |
| golangci-lint | Provides rule controls, output renderers, and changed-issue filtering. Its chosen-file interface still has package constraints. | Distinguish selected diagnostic locations from the context analysis needs. [Quickstart][golangci-start], [CLI][golangci-cli]. |

Ansible-lint already uses yamllint for generic YAML validation. The rewrite can
expand Saltbox-specific coverage while consumer CI continues running its general
Ansible checks. Replacing all general-purpose lint tools is not part of the
accepted scope. [Ansible YAML rule][ansible-yaml]

Recommendations derived from those sources: one source-analysis engine, built-in
rules with shared metadata, one diagnostic representation, and separate text,
JSON, and GitHub renderers. Keep plugins, a daemon, an external-linter runner,
and caching outside v1 unless measured requirements justify them.

### VS Code choices

VS Code tasks parse process output into editor markers and the Problems panel;
custom matchers support rule codes and start/end locations. The accepted v1 is
tasks for the saved current file and workspace. Tasks do not themselves provide
document synchronization or unsaved-buffer analysis. [Task matchers][vscode-tasks]

A small extension can run the same binary on open/save/change, send unsaved
contents over stdin, and use `DiagnosticCollection` directly. LSP is an optional
later alternative for shared multi-editor support and persistent document state;
it still needs a VS Code client extension and adds protocol/lifecycle work.
These are explicit alternatives in the [VS Code diagnostics API][vscode-diag]
and [language-server guide][vscode-lsp]. Ansible's language-server documentation
describes invoking ansible-lint on document open/save. [Ansible server][ansible-ls]

Source ranges should remain independent of the editor. Test Unicode, tabs, CRLF,
multiline YAML scalars, and multiple diagnostics on one line. Selected-file
checks may read context, but report only findings whose primary location is in
the selected source; the same policy applies to Saltbox and Sandbox.

### GitHub Action choices and consumer evidence

GitHub supports composite, JavaScript, and Docker actions. Composite actions
combine install/run steps; JavaScript adds a Node distribution but supports more
involved installation logic; Docker packages its environment but requires Linux
and Docker and incurs image startup/build/pull work. [Action types][action-types]
Ruff's own action is a JavaScript installer/runner, illustrating that alternative.
[Ruff Action metadata][ruff-action]

The initial recommendation is a composite Action invoking the released binary
with a reproducible version, verified download, explicit working directory and
target paths, and the CLI's exit status. Unsupported platforms and installation
failures must be explicit. Do not evaluate user-provided argument strings as
shell programs. The parent implementation owns the final packaging interface.

Workflow-command annotations associate a finding with a file and range without
a PR-comment API client. SARIF adds a code-scanning integration; GitHub's upload
workflow requires `security-events: write`. SARIF upload is not necessary for
the accepted CI annotations and remains outside v1. [Annotations][gh-annotations],
[SARIF upload][gh-sarif]

At the recorded snapshots:

- Saltbox's `saltbox.yml` and `saltbox-os.yml` linter jobs invoke
  `python3 scripts/saltbox-linter.py .` on Ubuntu 24.04. The linter job also runs
  `test_saltbox_facts.py`; removing Python there requires accounting for that
  independent test. [Saltbox workflow][saltbox-workflow]
- Sandbox checks out `sandbox/` and a separate `saltbox/`, then invokes
  `python3 ../saltbox/scripts/saltbox-linter.py .` from the Sandbox directory.
  An independent binary Action can remove this additional checkout from that
  linter job. Its working-directory and annotation behavior must be tested with
  this nested checkout layout. [Sandbox workflow][sandbox-workflow]
- This work supplies Action code and examples only; it does not edit those
  consumer workflows or publish releases/tags.

## Exact contract notes for implementers

Function names and line references below refer to the frozen [Python source][legacy].
Describe intentional improvements separately from behavior copied from its
regex/scanner implementation.

### Docker aggregate formulas

`check_docker_layer_composition` (line 1784) finds top-level
`<role>_role_docker_*` aggregates with both `_default` and `_custom` companions.
It requires explicit `lookup('role_var', '<suffix>', role='<role>')` access and
default-before-custom order. It does not by itself establish a correct formula.
The explicit-lookup regex (line 3327) recognizes the companion suffix, literal
role, and closing parenthesis; arbitrary extra keyword arguments are not part
of that legacy accepted form.

`check_docker_network_formula` (line 2170) requires both companions and one of:

```jinja
docker_networks_common
+ lookup('role_var', '_docker_networks_default', role='example')
+ lookup('role_var', '_docker_networks_custom', role='example')
```

```jinja
(docker_networks_common
 | map('combine', {'driver_opts': {'com.docker.network.endpoint.ifname': 'eth1'}})
 | list)
+ lookup('role_var', '_docker_networks_default', role='example')
+ lookup('role_var', '_docker_networks_custom', role='example')
```

For the second form, the role's default network entries must contain application
interface pins and none may equal the common interface name. The Python check
looks for at least one matching `com.docker.network.endpoint.ifname` line and
checks common-name collision; it does not establish that every entry is pinned
or that application pins are pairwise unique. Do not silently claim those
stronger properties as legacy parity.

`check_docker_hosts_formula` (line 2601) requires both role-local companions and
only this composition, without a common layer or an additional transform:

```jinja
lookup('role_var', '_docker_hosts_default', role='example')
| combine(lookup('role_var', '_docker_hosts_custom', role='example'))
```

`check_docker_envs_custom_usage` (line 2356) additionally restricts every
`_docker_envs_custom` reference: no direct variable read, literal explicit role
target, only inside that role's corresponding environment aggregate, and only
as its final `combine(...)` layer. Earlier environment layers remain possible.
The new shared checker must inspect references as well as aggregate definitions
and avoid issuing both a generic and specialized finding for the same failure.

`check_redundant_docker_layers` (line 2501) is separate: matching empty lists or
maps in both companions are redundant when no aggregate exists or when the
aggregate only combines those two layers. Networks are exempt; a meaningful
additional source keeps the layers valid. Removing declarations is not a
whitespace-only fix.

`check_docker_image_composition` (line 2016) requires `_docker_image_repo` and
`_docker_image_tag` when `_docker_image` exists and explicit role_var reads of
both. It does not parse or validate the complete image reference syntax.

### Web and Traefik

`check_web_url_composition` (line 1853) discovers complete
`<role>_role_<endpoint>_{subdomain,domain}` pairs. Existing associated `_host`,
`_url`, and `_insecure_url` defaults use role_web with respectively no scheme,
`https`, or `http`. `endpoint='web'` is omitted in its canonical spelling.
An HTTPS URL may instead be `https://{{ lookup('role_var', '_<endpoint>_host',
role='<role>') }}` when that host default exists. A direct role_web `_host`/`_url`
outside a recognized endpoint family fails. The old check compares the entire
first source line against a canonical string; semantic contract checks and
formatting should be separated in the rewrite.

`check_direct_web_host_composition` (line 1961) finds same-role, same-endpoint
subdomain and domain lookups in another default and directs it to role_web.
Its implementation tests co-occurrence, not an expression AST proving a join.

`check_traefik_api_router_contract` (line 2675) is triggered by declaration of
`<role>_role_traefik_enabled`, even when its value is false. Required suffixes:

```text
traefik_middleware_default_api
traefik_middleware_custom_api
traefik_api_enabled
traefik_api_endpoint
```

The default middleware declaration precedes custom. Legacy
`<role>_role_traefik_api_middleware` and `<role>_role_traefik_middleware_api`
declarations fail independently of that trigger.

`check_nested_traefik_adapter_contract` (line 2752) discovers forwarded
`<adapter>_role_web_subdomain` values from
`lookup('role_var', '_<adapter>_web_subdomain', role='<owner>')`. It requires
these owner-namespaced defaults and forwarding targets:

```text
traefik_sso_middleware
traefik_middleware_default
traefik_middleware_custom
traefik_middleware_default_api
traefik_middleware_custom_api
traefik_certresolver
traefik_enabled
traefik_api_enabled
traefik_api_endpoint
```

The Python implementation concatenates `.yml` task files and independently
searches for target names and lookup suffix strings; this does not prove the
right values are forwarded by the correct include task. Preserve the contract
while checking actual task associations in the rewrite.

`check_non_docker_traefik_renderer_contract` (line 2876) reads `.yml` tasks and
`.j2` templates. It requires `traefik_middleware_api`, `_traefik_api_enabled`,
and `_traefik_api_endpoint` when the role declares Traefik and the combined
source contains none of `create_docker_container.yml`, `deprecated`, or
`docker_labels_common`. These broad substring exemptions are implementation
heuristics, not proof of runtime rendering. They need explicit fixtures and
documented treatment in the new analysis.

### Ownership and helper interfaces

- `SVM_GITHUB_API_RESOURCE_PATH`: exactly
  `resources/tasks/git/github_api_request.yml` beneath the repository that
  contains the Python script. `check_svm_github_api_resource_usage` (line 946)
  allows direct global `svm` reads only at that resolved absolute path. A
  matching filename or suffix elsewhere is not exempt. Tests cover this.
- `GIT_CLONE_RESOURCE_PATH`: exactly
  `resources/tasks/git/clone_git_repo.yml` beneath the script's repository.
  `check_git_clone_resource_usage` (line 976) recognizes direct
  `ansible.builtin.git` actions and action/local_action forms in actual task
  lists, including nested block/rescue/always lists. It avoids arbitrary data
  mappings and block-scalar text. The standalone binary must derive canonical
  project/resource identity from its analysis context, not its install path.
- `check_docker_helper_var_prefix` (line 2839) recognizes the five
  `/docker/{create,remove,restart,start,stop}_docker_container.yml` helpers and
  rejects `_var_prefix` in favor of `var_prefix`. The old search examines eight
  following lines and runs during defaults linting; the policy itself is local
  to the include task and should work for a selected task file.
- `check_network_container_health_contract` (line 4051) requires
  `network_container_source` and `network_container_target` on direct includes
  of `network_container_health_status.yml`. The canonical implementation at
  `resources/tasks/docker/network_container_health_status.yml` may not depend
  on `_docker_vars`, `_instance_name`, or `_var_prefix`. Those two sides are
  file-local even though the old function scans the repository. Its search
  relies on `- name:` task anchors and literal same-line include syntax.
- `check_docker_vars_policy_contract` (line 3949) collects `default`, `omit`,
  and `required` suffix declarations across top-level shared Docker task YAML.
  It rejects mixed policy kinds, then permits `.get(...)`, `| default(...)`,
  and `is defined` fallback patterns only for suffixes whose sole policy is
  `omit`. The regex reads the policy key, not whether `omit` is actually true;
  intent is `omit=true`. It is line-based and misses some multiline/access
  variants. This is the one clear shared-resource context rule.
- `check_cloudflare_auth_contract` (line 4203) rejects
  `cloudflare.api`, `.email`, and `.scoped_token` references in defaults/tasks.
  It currently scans raw lines, including comment/string text; new semantic
  access detection must record intentional false-positive differences.
- `check_role_docker_state` (line 1761) rejects top-level names ending in
  `_role_docker_state`; changing container state belongs to shared helpers.

### Other policies

`check_docker_healthcheck_tests` (line 1521) requires exactly one explicit block
`test` list on each top-level `_docker_healthcheck` default. `NONE` has one
element, `CMD` has at least a nonempty executable after its marker, and
`CMD-SHELL` has exactly one nonempty command string after its marker. A folded
or literal scalar command is supported; null and collection-valued commands
are not, while a quoted string spelling `null` is valid. Scalar and flow-list
test representations fail the layout policy.

The preserved allowance is `# saltbox-lint allow cmd-shell` on the `test:` line.
It allows shell mode only; it does not bypass structural validation. Unknown,
malformed, misplaced, and unnecessary allowances fail. A valid allowance on an
invalid shape should not produce an additional misleading misplaced-allowance
finding. Directive-like text inside a quoted command is not a directive. These
three concerns share extraction but retain separate rule IDs.

`check_section_structure` (line 2285) recognizes exact three-line banners with
32-hash borders. The relative order is Basics, Settings, Postgres, Paths, Web,
DNS, Traefik, Docker, Dependencies. Unknown section titles do not participate.

`check_lookup_documentation` (line 2465) accepts exactly `# Skip docs` or
`# Do not edit or override using the inventory` on the preceding physical line
for owner-local computed `_lookup` defaults. Retain both accepted directives.

`check_role_var_empty_default` (line 2117) recognizes a specific repeated
`lookup(...) if (lookup(...) | length > 0) else ...` pattern, with `omit` or
another role_var lookup as fallback. Its hint is `default=...` and
`default_if_empty=true`; no semantic rewrite is approved as an automatic fix.

`check_ansible_tags` (line 1271) covers scalar/flow-list/block-list values and
requires `[a-z0-9]+(?:-[a-z0-9]+)*`. It rejects templating, aliases/anchors, empty
entries, and unquoted YAML non-string values such as booleans, numbers, dates,
and null. Quoted string spellings are treated separately. An AST-based rewrite
must recognize tag positions, not every mapping key spelled `tags`.

`check_static_imports` (line 1365) rejects import_tasks/import_role with optional
ansible.builtin prefixes, quoted keys, and action/local_action scalar forms.
The replacement hint is the corresponding include_tasks/include_role. Import
replacement changes behavior/tokens and is not an automatic formatting fix.

`check_role_directory_names` (line 3865) visits direct directories under `roles`
and `resources/roles` and requires `[a-z0-9]+(?:_[a-z0-9]+)*`.
`check_ansible_source_headers` (line 3896) requires an opening border of at least
20 hashes, a `---` within the first 20 lines, and nonempty Title, Author(s), HTTP
URL, and GNU General Public License v3.0 lines in that order before the document.
It does not prescribe a particular author's name. General role-authoring rules
and Sandbox-specific author guidance remain separate from this check.

## YAML/Jinja layout and safe-fix boundaries

### Required new conditional case

The user-supplied `examples.yaml` is a preserved collection of failing cases,
not a file the implementation may rewrite. Its first-line conditional is not
reported by the frozen Python engine. The accepted v1 **must diagnose and safely
fix a copy** into this shape:

```yaml
dockhand_role_docker_envs_dns_result_order: "{{ 'verbatim'
                                             if (dns_ipv4_enabled and dns_ipv6_enabled)
                                             else 'ipv6first'
                                                  if dns_ipv6_enabled
                                                  else omit }}"
```

The outer `if` and `else` begin at zero-based column 45, aligned with `{{`.
The nested else-value conditional begins at column 50. It is not sufficient to
reindent all `if`/`else` keywords to one common column. Maintain conditional
ownership, grouping/function/dictionary delimiter contexts, and branch anchors.
Distinguish conditional-expression keywords from quoted words and comprehension
filters; preserve associativity and token order. Parentheses remain unchanged.

### Existing formatting semantics

- `check_operator_alignment` (line 293): `|` and `+` align with the expression
  content after `{{ `, innermost parenthesis content, or a continuing else-value
  anchor. It only applies when an expression starts on a mapping definition
  line. Else context must end when its grouping closes.
- `check_ifelse_alignment` (line 3632): conditional keywords align with outer
  braces, innermost grouping/function content, or nested else-value anchors.
  Nested inline conditionals in a multiline else branch are rejected. The old
  loop only examines continuation lines, causing the approved first-if gap.
- `check_function_argument_alignment` (line 429): plain continuation arguments
  align with function content; it excludes operator/conditional/boolean/closer
  prefixes from this particular check.
- `check_dictionary_entry_alignment` (line 717): continuation dictionary keys
  align with the first key; if the opening line has no key, the first later key
  establishes its alignment.
- `check_lookup_argument_layout` (line 768): a single-line lookup remains valid.
  Once wrapped, its first argument stays beside `lookup(`; every later top-level
  argument starts on the immediately following aligned line. Nested calls and
  commas in strings/collections must not be treated as outer separators.
- `check_block_scalar_jinja_indentation` (line 508): only a pure Jinja output
  expression in the scalar gets structural brace/content/call indentation.
  `block_scalar_jinja_context` (line 3426) determines that scope. Mixed literal
  text must not receive pure-expression indentation rules.
- `check_jinja_closing_brace_placement` (line 905): outside pure block scalars,
  multiline `}}` shares the final expression token's line. This includes mixed
  scalars with several expressions, such as credentials and database URLs.
- `check_inline_conditional_length` (line 680): threshold is the complete
  physical source line's length, 160 characters. It finds unquoted if/else in
  an output expression. It is distinct from generic YAML line length.

`check_lookup_conditional_arguments` (line 860) is semantic policy, not layout:
`lookup(..., default='a' if flag else 'b')` fails, while an outer conditional
choosing between lookups is permitted. The local suite expects one finding for
a nested lookup conditional in an outer lookup, not redundant reports for each
enclosing call.

### Scanner hazards

`iter_jinja_tags` (line 2939) accounts for string quoting, escapes, mapping braces,
Jinja comments, raw/endraw blocks, YAML comments, and output/statement tags.
`find_jinja_variable_read` (line 3014) distinguishes global reads from attribute,
filter/test, keyword-argument, and binding positions; macro default expressions
still read globals. Keep these semantic distinctions in shared analysis.

The formatting-specific `iter_multiline_jinja_blocks` (line 3356) is a different
scanner and does not inherit all comment/raw protections. Parenthesis/dictionary
helpers reset quote state per line. The bare lookup search can find text outside
a real Jinja expression. Those are reasons to unify lexical analysis, not reasons
to preserve false positives or offer unsafe automatic edits.

A hash in YAML block-scalar content is literal template content, whereas a real
YAML comment is not templated. `{# ... #}`, `{% raw %}`, and `!unsafe` are separate
cases. Quoted `}}`, nested dictionary `}`, escaped quotes, YAML single-quote
doubling, anchors, explicit indentation indicators, folded scalars, and CRLF
all need source-preserving handling. Column shifts must not alter a Jinja string
or turn literal scalar content into YAML structure.

### Automatic-fix contract

Required safe formatting includes continuation indentation, wrapped lookup
argument whitespace, misplaced closing braces, and the approved outer/nested
conditional layout. Do not defer that specific conditional case. Other forms
whose ownership or preservation cannot be established remain diagnostic-only.

Only fix violations; already-valid formatting remains byte-for-byte unchanged.
For a candidate edit, preserve Jinja non-whitespace tokens **including exact
string-literal contents**, whitespace-control delimiters, comments, and literal
template segments outside expressions. Reparse YAML and preserve its structure,
styles/tags, and unaffected values. Token equivalence is a safety gate, not a
replacement for deriving correct formatting context. A whitespace-stripped
string comparison is insufficient because string whitespace is data.

Handle edits as coordinated expression/scalar changes to prevent overlaps.
Verify idempotence and retain diagnostics for unsupported/incomplete syntax.
Never evaluate Jinja or invoke Ansible to apply a fix. Header insertion, section
reordering, tag/variable renaming, healthcheck list conversion, semantic lookup
rewrites, directive insertion, and layer deletion alter non-whitespace tokens
and are outside safe formatting fixes.

## Coverage limits and validation priorities

The 47 local tests are concentrated in healthcheck/directive behavior, lookup
conditional arguments, closing-brace placement, and SVM ownership/scanner cases.
They do not provide representative positive/negative coverage for all 40 policy
IDs. They also predate an automatic-fix interface.

Explicit gaps to cover in the new fixtures:

- The mandatory first-if break, nested conditional ownership, grouped/call
  conditionals, valid layouts left unchanged, and multiple expressions per
  scalar; do not merely assert a golden output without token/YAML preservation.
- Each Docker network/hosts/env branch, role image companions, meaningful versus
  redundant empty layers, explicit target handling, and useful specialized hints.
- All Traefik declaration/forwarding/rendering branches, exact include-task
  associations, `.yaml` as well as `.yml`, and missing context.
- Shared docker_vars policy conflicts and multiline/subscript/get access forms;
  include callers without `name`, nested tasks, and YAML action variants.
- Resource exceptions only at their exact canonical identities, with near-name
  and matching-suffix negative fixtures; comments/string data are not live calls.
- Actual play/task/handler tag positions versus arbitrary mappings; defaults
  identity under nested paths; header and section behavior; unsupported syntax.
- File/whole-project finding equivalence, stdin/virtual-path equivalence,
  selected-file primary-location filtering, deterministic diagnostics, fix
  idempotence, and JSON/GitHub/text agreement.

Legacy discovery is uneven: semantic defaults checks run only for
`roles/*/defaults/main.yml`; task/Jinja checks cover several role/resource task
trees; shared inventory is only `inventories/group_vars/all.yml`; source headers
cover broader role defaults/tasks/handlers/vars YAML; Git/tag/import checks have
their own task/playbook discovery. See `main` (line 4259) and
`lint_shared_jinja`/`lint_inventory`/`lint_tasks`/`lint_defaults` (lines 3809-3857).
Broader classified YAML coverage is an intentional v1 expansion, not merely
renaming the legacy glob patterns.

Current defaults contracts compare declarations within the same source file.
Do not union every file below a role's defaults directory as if all were loaded
simultaneously. Role identity comes from the classified role path, not
`file.parent.parent.name`. Only adapters/renderers require role-content context;
helper-argument and network-health checks become file-local after normalization.
Repository policy analysis may read additional files while retaining the
accepted selected-file reporting boundary.

[legacy]: https://github.com/saltyorg/Saltbox/blob/a243b198eb32ffe39f6f85afc34e35d9632fe0b1/scripts/saltbox-linter.py
[saltbox-workflow]: https://github.com/saltyorg/Saltbox/blob/a243b198eb32ffe39f6f85afc34e35d9632fe0b1/.github/workflows/saltbox.yml
[sandbox-workflow]: https://github.com/saltyorg/Sandbox/blob/1d1c40e3e17b97afdd318e35b8663a0c9563dc20/.github/workflows/sandbox.yml
[ansible-usage]: https://docs.ansible.com/projects/lint/usage/
[ansible-rules]: https://docs.ansible.com/projects/lint/custom-rules/
[ansible-yaml]: https://docs.ansible.com/projects/lint/rules/yaml/
[ansible-ls]: https://docs.ansible.com/projects/vscode-ansible/als/
[yamllint]: https://yamllint.readthedocs.io/en/stable/quickstart.html
[ruff-cli]: https://docs.astral.sh/ruff/configuration/
[ruff-setup]: https://docs.astral.sh/ruff/editors/setup/
[ruff-action]: https://github.com/astral-sh/ruff-action/blob/main/action.yml
[actionlint]: https://github.com/rhysd/actionlint/blob/main/docs/usage.md
[golangci-start]: https://golangci-lint.run/docs/welcome/quick-start/
[golangci-cli]: https://golangci-lint.run/docs/configuration/cli/
[vscode-tasks]: https://code.visualstudio.com/docs/debugtest/tasks#_defining-a-problem-matcher
[vscode-diag]: https://code.visualstudio.com/api/language-extensions/programmatic-language-features#provide-diagnostics
[vscode-lsp]: https://code.visualstudio.com/api/language-extensions/language-server-extension-guide#why-language-server
[action-types]: https://docs.github.com/en/actions/concepts/workflows-and-actions/custom-actions
[gh-annotations]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#setting-an-error-message
[gh-sarif]: https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file

## Integration tool pins

Verified on 2026-09-10 against upstream release pages and `git ls-remote` tag
identities. `Makefile` installs exact Go module versions into versioned ignored
`bin/tools` directories; Go's module checksum verification applies. CI runs the
same Make targets. Optional actionlint external shell/Python analyzers are
explicitly disabled so host-dependent tool availability cannot alter this gate.
Bash scripts get syntax checks and execution tests against localhost downloads.

| Tool | Pin and primary source |
| --- | --- |
| golangci-lint | [v2.13.2](https://github.com/golangci/golangci-lint/releases/tag/v2.13.2) |
| actionlint | [v1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12) |
| GoReleaser | [v2.18.1](https://github.com/goreleaser/goreleaser/releases/tag/v2.18.1) |
| actions/checkout v7 | [`3d3c42e5aac5ba805825da76410c181273ba90b1`](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1) |
| actions/setup-go v7 | [`b7ad1dad31e06c5925ef5d2fc7ad053ef454303e`](https://github.com/actions/setup-go/tree/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e) |
| goreleaser/goreleaser-action v7 | [`f06c13b6b1a9625abc9e6e439d9c05a8f2190e94`](https://github.com/goreleaser/goreleaser-action/tree/f06c13b6b1a9625abc9e6e439d9c05a8f2190e94) |
| actions/setup-python v7 | [`5fda3b95a4ea91299a34e894583c3862153e4b97`](https://github.com/actions/setup-python/tree/5fda3b95a4ea91299a34e894583c3862153e4b97) |

GoReleaser's [archive configuration](https://goreleaser.com/customization/package/archives/)
is shared with the installer naming contract: `saltbox-lint_VERSION_linux_ARCH.tar.gz`
and `checksums.txt`. The CLI receives `main.version` through linker flags. Release
metadata is recorded in Go build information; local snapshots publish nothing.
The [GitHub runner annotation implementation](https://github.com/actions/runner/blob/main/src/Runner.Worker/ActionCommandManager.cs)
strips columns on multiline errors; the renderer therefore emits line ranges
without columns for multiline spans and keeps columns for single-line spans.
