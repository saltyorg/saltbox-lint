# Rule migration

## Migration catalog: all 40 policies into 29 rules

The original migration contains 29 policies. The standalone catalog now also
includes `section-spacing`, two scoped parentheses rules and `ansible-when-list`,
bringing the total to 33. The file-level `section-spacing` rule
requires a blank line between genuine three-line section banners and variables,
including custom titles. It safely inserts missing separators with `check --fix`
and preserves existing spacing and attached variable documentation.

The diagnostic-only additions are `ansible-when-list` (split root conjunctions
in structural `when` scalars or list items into ordered block-list items),
`ansible-when-parentheses` (group each nontrivial indivisible structural `when`
condition, including literal booleans) and
`jinja-redundant-conditional-parentheses` (omit a standalone output's whole
`if/else` result wrapper). Single variable reads, including standalone `lookup`,
`query` and `q` calls, may remain ungrouped; other Ansible condition fields and
generic boolean outputs gain no grouping
requirement. Consumed conditional results retain their needed parentheses.
Root conjunctions receive only the list diagnostic; each suggested item obeys
the parentheses convention. Conjunctions beneath other operators, calls or
conditional results remain intact. Hints preserve decoded literal contents
with YAML scalar quoting and never offer automatic edits.
See [the scoped conventions](boolean-grouping-research.md) for examples,
source observations and exclusions. Historical acceptance results describe
their recorded rule snapshots; these additions do not revise those results.

This table records the accepted migration design. Runtime rule metadata in `lint.Rules()` is the
authority for the implemented catalog. File scope includes source
contents plus role/resource identity derived from its path. Role scope requires
additional role files; repository scope requires shared-resource context.

| New rule | Existing IDs | Scope and retained intent |
| --- | --- | --- |
| `jinja-layout` | `operator-alignment`, `ifelse-alignment`, `function-argument-alignment`, `dictionary-entry-alignment`, `lookup-argument-layout`, `block-jinja-indentation`, `jinja-closing-brace-placement` | File: shared indentation/layout model, specific hints for the affected construct; includes the approved first-line conditional correction. |
| `jinja-conditional-length` | `inline-conditional-length` | File: preserve the 160-character threshold for inline conditionals. |
| `role-variable-prefix` | `variable-prefix` | File: role defaults containing `_role_` use the owning role prefix. |
| `docker-aggregate-contract` | `docker-layer-composition`, `docker-network-formula`, `docker-envs-custom-usage`, `docker-hosts-formula` | File: explicit companion access and default/custom ordering, with specialized network/hosts/environment contracts. |
| `role-web-contract` | `role-web-contract`, `direct-web-host-composition` | File: canonical endpoint host/URL interface and prohibition on repeated component joining. |
| `docker-image-contract` | `docker-image-composition` | File: image repository/tag companions and explicit role_var access. |
| `role-lookup-target` | `role-lookup-target` | File: both role_var and role_web require an explicit role target. |
| `defaults-sections` | `section-structure` | File: canonical major sections are unique and relatively ordered. |
| `computed-default-documentation` | `lookup-documentation` | File: a supported documentation exclusion immediately precedes computed `_lookup` defaults. |
| `docker-empty-layers` | `redundant-docker-layers` | File: redundant empty companion declarations, preserving network and extra-source exceptions. |
| `traefik-api-contract` | `traefik-api-router-contract` | File: complete API defaults, declaration order, valid literal endpoint rules, and no legacy API middleware names. |
| `traefik-adapter-contract` | `nested-traefik-adapter-contract` | Role: discover namespaced web adapters and validate declaration and forwarding. |
| `docker-helper-arguments` | `docker-helper-prefix-argument` | File after task normalization: lifecycle helpers accept `var_prefix`. |
| `traefik-renderer-contract` | `non-docker-traefik-renderer-contract` | Role: a non-Docker renderer consumes the API interface. |
| `role-var-empty-default` | `role-var-empty-default` | File: repeated empty-value fallback conditionals use `default_if_empty`. |
| `docker-vars-policy` | `docker-vars-policy` | Repository/shared Docker resources: consistent suffix policies and permitted sparse access. |
| `network-health-contract` | `network-container-health-contract` | File after task normalization: callers pass source/target; the shared resource does not read caller-local Docker facts. |
| `cloudflare-auth-contract` | `cloudflare-auth-contract` | File: use normalized Cloudflare authentication. |
| `lookup-conditional-argument` | `lookup-conditional-argument` | File: resolve conditionals outside lookup arguments. |
| `docker-healthcheck-shape` | `docker-healthcheck-test-layout` | File: valid marker-specific block-list shapes. |
| `docker-healthcheck-mode` | `docker-healthcheck-command-mode` | File: CMD preference with explicit CMD-SHELL allowance. |
| `lint-directive` | `saltbox-lint-directive` | File: known syntax, allowance, placement, and necessity. |
| `svm-github-api-resource` | `svm-github-api-resource` | File with exact resource identity: direct SVM access belongs to its canonical fallback resource. |
| `git-clone-resource` | `git-clone-resource` | File with exact resource identity: direct Git actions belong to the clone resource. |
| `ansible-tag-name` | `ansible-tag-name` | File: literal lowercase kebab-case tags. |
| `ansible-static-import` | `static-task-import`, `static-role-import` | File: both import kinds name their corresponding include replacement. |
| `role-docker-state` | `role-docker-state` | File: shared Docker helpers own container state. |
| `role-directory-name` | `role-directory-name` | Role path: snake_case directory names. |
| `ansible-source-header` | `ansible-source-header` | File: ordered standard role YAML header. |

The reductions merge repeated knowledge: seven formatting checks, four aggregate
checks, two web checks, and two static-import checks. Do not merge healthcheck
shape with shell permission, empty-layer removal with aggregate composition,
or Traefik declarations with forwarding/rendering merely because they share
analysis. SVM, Git, and Cloudflare represent different ownership policies.

## Intentional coverage differences

The Go engine normalizes YAML task actions and Jinja expressions before rule
evaluation. YAML comments, quoted template text, raw blocks, `!unsafe` scalars,
variable bindings, and unrelated nested object attributes are distinguished from
live reads. Exact project/resource identities replace exemptions based on the
old Python script's installation location. `.yaml` and nested classified role
sources participate alongside `.yml`; explicitly selected generic YAML also
receives applicable rules. These are deliberate improvements over regex and
legacy discovery gaps, not exemptions to obtain a clean corpus.

Defaults companion contracts stay in the same file. Role rules read required
role content; shared Docker policy reads required resource context. Findings
are always filtered by their primary selected source. Malformed selected YAML
is a `yaml-syntax` diagnostic; missing/load/report failures are operational
errors. Unsupported or incomplete template syntax remains visible instead of
being treated as a clean expression.

The first-line conditional captured in `lint/testdata/jinja/first-if.bad.yaml`
is deliberately diagnosed and safely fixable even though the frozen Python
implementation misses it. This committed fixture is independent of the user's
optional local `examples.yaml`. Corrections
must preserve outer and nested else-branch ownership, Jinja tokens/string
contents, YAML structure/styles, and idempotence. Semantic policies remain
manual corrections; source headers, tags, lookup semantics and healthcheck lists
are not rewritten by formatting fixes.

The [matched Saltbox/Sandbox acceptance](acceptance.md) records four intentional
Saltbox findings and a clean Sandbox result at frozen revisions. This mapping
does not claim every current consumer file passes.

## Traefik API endpoint literals

`traefik-api-contract` validates owning role defaults named
`<role>_role_traefik_api_endpoint` or
`<role>_role_<namespace>_traefik_api_endpoint`, even without an enablement
field. An empty string remains valid. Replace bare paths such as `"/api"`
with rules such as ``"PathPrefix(`/api`)"``. Non-string static defaults are
invalid. Diagnostics point to the value and never offer an automatic fix.

The validator follows Traefik **v3.7.0** HTTP matchers and its
`vulcand/predicate` **v1.3.0** Go expression grammar: matcher calls,
parentheses, `!`, `&&`, and `||`, with backtick or escaped double-quoted
string arguments. It checks supported matcher names, argument counts,
nonempty arguments, leading slashes for `Path`/`PathPrefix`, Go regular
expressions, ASCII hosts, and IP addresses/CIDRs for `ClientIP`.
`PathRegexp` does not require a leading slash; `Method` accepts custom methods.

This is static configuration validation, not request matching or template
evaluation. Actual Jinja output expressions and statements, including
lookups and interpolation inside a rule, are deferred without a template
whitelist. Literal-only Jinja expressions and raw statement wrappers are also
deferred. Aliases and unknown scalar tags are not resolved. For non-unsafe
strings, Jinja comments are removed before validating the remaining literal,
respecting explicit whitespace-control markers. A comment after a valid rule
therefore passes, while `/api` plus a comment still fails. Mentioning `lookup`
or template statements inside a comment cannot exempt an invalid literal.
`!unsafe` values are literal, even if they contain Jinja-looking text. Explicit core YAML tags
retain their effective scalar type. Source bytes remain unchanged.

The authority is Traefik's [`pkg/rules/parser.go`](https://github.com/traefik/traefik/blob/v3.7.0/pkg/rules/parser.go)
and [`pkg/muxer/http/matcher.go`](https://github.com/traefik/traefik/blob/v3.7.0/pkg/muxer/http/matcher.go),
with [`vulcand/predicate/parse.go`](https://github.com/vulcand/predicate/blob/v1.3.0/parse.go).

## Four consumer workflow migrations

The following files are complete *example wrappers* around the replacement
`saltbox-lint` job. Copy only that job into the named consumer workflow after
review. Preserve the consumer workflow's triggers, other jobs, and job `needs`.
The examples themselves use a manual trigger to avoid suggesting changes to
consumer trigger policy.

| Consumer workflow | Replacement job template | Details retained |
| --- | --- | --- |
| Saltbox `.github/workflows/saltbox.yml` | [saltbox.yml](../examples/github/saltbox.yml) | Python 3.14 and `python3 .github/scripts/test_saltbox_facts.py` remain before the linter. |
| Saltbox `.github/workflows/saltbox-os.yml` | [saltbox-os.yml](../examples/github/saltbox-os.yml) | Same independent facts test and job condition. |
| Sandbox `.github/workflows/sandbox.yml` | [sandbox.yml](../examples/github/sandbox.yml) | Checkout path `sandbox`, Action working directory `sandbox`, annotations `sandbox/roles/...`. |
| Sandbox `.github/workflows/sandbox-os.yml` | [sandbox-os.yml](../examples/github/sandbox-os.yml) | Same nested checkout and annotation identity. |

Replace `RELEASE_COMMIT_SHA` with the reviewed release Action's full commit SHA
and illustrative `v0.1.0` with its exact stable binary version. No release is
claimed to exist by these templates. Action code and binary version are two
separate pins. The auxiliary Saltbox checkout and Python setup disappear only
from Sandbox's custom-linter job; the separate ansible-lint job still needs its
own dependencies/checkouts. Saltbox's facts test still needs Python. These
examples have not been installed into either consumer repository.

Annotations resolve against `GITHUB_WORKSPACE`; summary links resolve against
the checked repository root and `GITHUB_REPOSITORY`/`GITHUB_SHA`. A workflow
checking its own nested Sandbox checkout already supplies those values. When
intentionally checking another repository, supply that repository name and its
checked commit SHA explicitly as step environment values; preserve the original
workspace so annotation paths still include the checkout prefix. If repository
or SHA is missing, summary links are omitted.

See [research and frozen reference sources](research.md) for provenance.
