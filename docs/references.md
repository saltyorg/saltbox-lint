# Role reference inspection

`references` is available in source builds and remains unreleased. It reads YAML
and local context without executing lookups, templates, modules or playbooks.
It never writes source files. Templates remain raw context and cannot be selected.

```sh
saltbox-lint references roles/example/tasks/main.yml --root .
saltbox-lint references roles/example/defaults roles/example/tasks --root . --format json
saltbox-lint references - --root . --stdin-filename roles/example/tasks/main.yml --format json < editor-buffer.yml
```

With no paths, the command selects the current directory using the same YAML
admission and Git ignore rules as `check`. Explicit YAML files override directory
admission. Root and stdin filenames resolve from the working directory. Only
selected sources emit references. Extra context supplies candidates and dependency
observations. Exit status is 0 for a generated query, including unresolved reads,
and 2 for usage, loading or reporting failures.

## What resolution means

A resolved reference locates one declaration candidate for each requested suffix.
An ambiguous reference locates multiple candidates for at least one suffix.
Candidates describe source declarations, not evaluated values, runtime
availability or Ansible variable precedence. The query returns all matching
supported declarations instead of choosing a variable layer.

The `saltbox-role-lookups-v1` contract models the short `role_var` and `role_web`
plugins inspected at Saltbox commit
`0d1d205cad3e79440829b8727f8904e1c2b67b52`. Their source hashes are:

- `lookup_plugins/role_var.py`: `94b3522ab7ecff357b6526d785c5bd8eba58d3ac835e6e030f29fe8ab3ab634c`
- `lookup_plugins/role_web.py`: `b77ec4d83a85dd5c06621e1fd3f58600fbe75bb7ec5d9cb886d1c63912119173`

For `role_var`, the primary key is a runtime alias plus the suffix. With an
explicit role, the alias comes from `<role>_name`, falling back to the role name.
Without an explicit role, `role_name` and `traefik_role_var` are runtime inputs.
The fallback key is `<role>_role<suffix>`, except `_name`, which uses `<role>_name`.
Both keys admit dash-to-underscore variants. The index retains literal possible
aliases and their declaration locations. Dynamic aliases remain explicit
uncertainty. It does not evaluate alias expressions.

The plugin reads Ansible's live variable map. Literal null declarations remain visible with a runtime-skip reason. Null values are skipped, defaults
can supply missing values, and `default_if_empty` can return a default for an
empty result. Default expressions evaluate before the lookup. The query does not
model those evaluations, JSON conversion, execution order or variable precedence.
`default_supplied` records keyword presence only.

`role_web` defaults its endpoint to `web` and delegates the suffixes
`_<endpoint>_subdomain` and `_<endpoint>_domain` to `role_var`. The query returns
both component declarations and never computes a hostname or URL. A dynamic or
invalid endpoint has no definitive resolution.

## Indexed sources and limits

The bounded local search includes `roles/<target>` and
`resources/roles/<target>`, plus the owning role. It observes their conventional
defaults, vars, tasks, handlers and raw template directories. It also observes
`group_vars`, `host_vars`, `inventory`, `inventories`, root `vars.yml`/`vars.yaml`
and root `inventory.yml`/`inventory.yaml`, including absent paths. Reads and
hashes stay inside the canonical source root; escaped sources are rejected.
Git administrative controls retain their independent ownership and are not
exported as source facts.

Declarations include top-level role defaults and vars, conventional inventory
variable mappings, root variable mappings, root YAML inventory group/host vars,
applicable task-local vars, and mapping-form `set_fact` values in the primary source or its owning/target roles. Unindexed role metadata cannot change primary resolution. Task vars belong
to their exact task or enclosing block. `set_fact` declarations remain possible
sources because the query does not model execution order. Inventory declarations
remain possible sources because host/group applicability is unmodeled. Scalar
`set_fact`, `include_vars`, role callers, arbitrary inventories, external
collections and dynamically loaded values remain runtime providers outside the
index. YAML aliases retain their original representation and are not expanded.

The scanner reuses YAML/Jinja lexical reads and Ansible task-argument decoding.
Comments, string literals and unsafe values do not become runtime reads.
`lookup`, `query` and `q` calls with short plugin names are inspected. These global aliases were verified read-only in installed Ansible 2.21.2, whose `_internal/_templating/_jinja_bits.py` has SHA256 `cb5dd15e88c596d8549e39b522a79091d202bdb18b087dfaf3dd3e457b848ca7`.
A scalar binding one of those callees makes its calls dynamic. This conservative
rule also declines calls before a later binding; it does not evaluate lexical
branches. Unpacking, repeated keyword arguments and unsupported positional
shapes stay dynamic. Collection-qualified plugin names have an unavailable
external contract. Implicit role names use the owning role only as a possible
local declaration target and retain the runtime-role reason.

Absence from defaults or even the full local index cannot prove that a runtime
value is undefined. Missing local roles, caller variables, inventory-only values,
external roles and incomplete context therefore produce explicit unresolved
reasons. This milestone adds no default lint diagnostics. Existing explicit-role,
web-contract and Traefik policies retain their ownership. There are no rename,
lookup rewrite, template write or fix operations.

## JSON schema version 1

The query has its own `schema_version: 1`. Default `check` JSON remains version 2.
All arrays have deterministic order and are present when empty.

| Field | Meaning |
| --- | --- |
| `contract` | `saltbox-role-lookups-v1`, the pinned declaration-inspection contract |
| `root` | Canonical source root |
| `sources` | Selected sources, kinds and parse observations |
| `loaded_context` | Additional sources, kinds and parse observations, including raw templates |
| `references` | Source-owned reads ordered by path and original byte span |
| `dependencies` | Shared analysis schema version 1 with primary hashes, files, directory membership, negative observations and generation |

Each reference contains `location`, `owning_role`, `owning_role_path`,
`lookup_kind`, `target`, `target_kind`, `suffixes`, `state`, `reasons`,
`candidates`, `alias_declarations`, `spelling_candidates` and `default_supplied`.
Locations contain a relative path, half-open UTF-8 byte `span.start`/`span.end`,
one-based Unicode code point line/column, and exact source `text`.

Candidates contain the requested suffix, constructed lookup name, lookup layer
and declaration. Layers are `fallback`, `possible-primary` and their `-underscore`
variants. Declarations retain their name, owning role/path, provenance, key/value
locations and contiguous preceding or inline documentation comments. Provenance
is `defaults`, `vars`, `inventory`, `task-vars` or `set-fact`. Alias declarations
retain both literal and dynamic source representations. Spelling candidates are
nearby declared names, capped at 256 bytes per comparison. They are suggestions
and never resolution evidence or lint findings.

The states are:

| State | Meaning |
| --- | --- |
| `resolved` | Exactly one indexed declaration candidate per suffix |
| `ambiguous` | Multiple indexed declaration candidates for a suffix |
| `dynamic` | Target, suffix, endpoint, callee binding or argument shape prevents definitive inspection |
| `unavailable` | No candidate for a requested suffix, invalid or unavailable local context, or an external contract |
| `proven-missing` | Reserved for a future closed required-target contract; never emitted by this milestone |

Reasons distinguish runtime precedence/providers, runtime aliases, implicit role
names, dynamic targets/suffixes/endpoints, local callee bindings, unsupported
arguments, external contracts, invalid context, inventory scope and `set_fact`
execution. Dependency completeness means the recorded observations were retained;
it does not mean Ansible's runtime variable universe is closed. Clean and
unresolved queries retain dependencies so later changes can invalidate them.

## Editor query endpoint

`query` is an unreleased read-only endpoint for one exact YAML buffer. It reuses
this declaration index and resolver. Supply an operation, a filename and a UTF-8
byte offset through the current snapshot. Offsets inside encoded characters or
between CR and LF are rejected. The snapshot is limited to 16 MiB.

```sh
saltbox-lint query --root . --stdin-filename roles/example/tasks/main.yml --operation definition --offset 120 - < editor-buffer.yml
```

Operations are `definition`, `completion`, `hover` and `references`. Full admitted
project discovery supplies role-name completion and static reads across roles.
The current source overrides its saved bytes. Explicit source selection can
inspect an ignored primary; directory discovery still excludes ignored peers.
All reads retain the original reference scanner's lexical admission and contract.
Exit status is 0 for generated results, including `none`, `dynamic`, `ambiguous`
and `unavailable`, and 2 for usage, loading or reporting failure.

Query schema version 1 is separate from reference-report schema version 1 and
from default check schema version 2. The response contains:

| Field | Meaning |
| --- | --- |
| `root`, `path`, `source_sha256` | Canonical source identity and exact snapshot hash |
| `operation`, `offset` | Echoed request operation and validated byte offset |
| `state`, `reasons` | Declaration resolution evidence, or `none` outside a recognized read/declaration |
| `origin` | Optional original lookup or declaration-key location |
| `target_hashes` | SHA-256 hashes of source snapshots for every returned target |
| `locations` | Original source locations with `declaration` or statically recognized `read` kind |
| `declarations` | Every applicable declaration candidate, comments and literal source representation |
| `completions` | Literal labels, descriptive details and replacement location/text, preserving quotes |
| `dependencies` | Analysis schema 1 collapsed to the primary owner with all observed sources, negative context and discovery controls |
| `coverage` | `complete: false` and explicit reasons that runtime impact remains incomplete |

Locations use the same original half-open UTF-8 spans, code point line/column and
exact source text as reference inspection. Consumers must validate echoed
identity, all target hashes, boundaries and current ownership before presenting
results. A completion location covers only the active literal's contents.
Completion declines dynamic calls, unsupported argument shapes, qualified
external contracts and uncertain escaped/folded source representations.

References can start on a recognized read or a declaration key. They return reads
whose candidate sets include the declaration candidates at that location, rather
than asserting which candidate Ansible will use. Coverage reasons explicitly
retain templates, runtime providers, ignored discovery and dynamic reads.
The VS Code adapter observes dependencies and target bytes before accepting a
fresh response, and omits dirty target buffers. It provides a read-only impact
view without declaration values. There is no persistent server or answer cache.
