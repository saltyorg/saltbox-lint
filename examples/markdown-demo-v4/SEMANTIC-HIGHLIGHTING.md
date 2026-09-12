# Ansible highlighting boundary audit

Inspected 2026-09-11 against the installed Red Hat Ansible **26.8.2** extension
at `/root/.vscode-server/extensions/redhat.ansible-26.8.2`. This source audit
includes the controller's focused runtime probes below; it does not establish
universal runtime parity. The demo now composes TextMate with the frozen
semantic classifier and catalog described below.

**Filters need highlighting, but do not need an installed-filter catalog to
match this extension.** Its Jinja grammar recognizes filter/test syntax and
function calls lexically. Its semantic provider only adds classifications for
Ansible YAML mapping keys. Keep these two layers and their evidence separate.
[Jinja grammar][jinja], [semantic provider][semantic]

## Layer and feature matrix

| Feature | Owner in Ansible 26.8.2 | Classification and catalog dependency |
| --- | --- | --- |
| YAML strings, numbers, booleans, nulls, comments, punctuation, tags, anchors/aliases, block/flow syntax | YAML TextMate grammar | Lexical scopes; no Ansible inventory required. |
| Ansible keyword patterns | TextMate keyword injection | Initial lexical highlighting; semantic context can refine/override key styling. |
| `{{ ... }}`, `{% ... %}`, `{# ... #}`, whitespace-control markers, raw blocks | Jinja brace injection | Embedded Jinja scopes, comments/raw contents; no catalog. |
| Bare conditional expressions | Conditional injection | `when`, `changed_when`, `failed_when`, `check_mode`, `until`; quoted, unquoted, block scalar and block-list contexts. Source explicitly notes flow-collection limitations. |
| `value \| filter`, dotted/FQCN filters, `{% filter name %}` | Jinja expression grammar | `entity.name.function.filter.jinja`; arbitrary syntactically matching names, including unavailable plugins. |
| `value is test`, `is not namespace.collection.test` | Jinja expression grammar | `entity.name.function.test.jinja`; no test-name registry. |
| `lookup(...)`, `query(...)`, `q(...)`, `range(...)`, ordinary call names | Jinja expression grammar | Generic `entity.name.function.jinja` call rule, not special lookup recognition. A quoted lookup plugin name remains a string. |
| Variables, attributes, assignment parameters, operators, literals, brackets, strings/escapes, control words | Jinja expression grammar and quote-escape injections | Lexical scopes; no resolution of variable existence, types or plugin availability. |
| Task/play/block/role keyword keys | Semantic provider | `keyword`, no modifier; fixed context-specific keyword tables. |
| Resolved task module key | Semantic provider + documentation library | `class`, no modifier; depends on discoverable module files and resolution. |
| Recognized module argument key or alias | Semantic provider + parsed module options | `method`, no modifier; includes typed nested options. |
| Ordinary mapping keys reached by fallback | Semantic provider | `property.definition`; not a validated variable definition. |
| Module/option names, option values, inventory hosts, some variable suggestions | Completion provider | Separate editor feature; completion kinds and suggestion settings are not semantic token types or highlighting rules. |

Sources: extension [grammar registrations][package], [base YAML grammar][yamlgrammar],
[keyword injection][keywords], [Jinja grammar][jinja], [brace injection][braces],
[conditional injection][conditionals], [semantic provider][semantic],
[completion provider][completion].

## Complete semantic contract

The legend order is `method`, `class`, `keyword`, `property`. The only modifier
is `definition` (bit 0). There are no semantic tokens for filters, tests,
functions, variables in expressions, module values, strings, deprecation,
references or errors. These names describe the extension's styling contract,
not the usual programming-language meanings of “class” and “method”.
[Installed provider](/root/.vscode-server/extensions/redhat.ansible-26.8.2/packages/ansible-language-server/dist/providers/semanticTokenProvider.js)

The walker classifies scalar keys in this order: play, block, role, task,
ordinary mapping. Recognition uses AST ancestry and sibling keys, not simply
indentation or a global list of words. [Context helpers][yaml]

| Context | Recognition and traversal |
| --- | --- |
| Play | Mapping in the root sequence with a play-exclusive key: one present in play keywords and absent from task/role/block keywords. Keyword keys get `keyword`; other keys get `property.definition`; descend into values. The helper's optional role-task URI guard is not supplied by this semantic caller. |
| Block | Mapping in a sequence with a sibling `block` key. Block-table keys get `keyword`; other keys get `property.definition`; descend into values. |
| Role | Mapping in a sequence whose containing mapping key is `roles`. Role-table keys get `keyword`; other keys, including `role` itself in this table, get `property.definition`; descend into values. |
| Task | Mapping in the root sequence, or in a sequence under `tasks`, `pre_tasks`, `post_tasks`, `handlers`, `block`, `rescue`, `always`, excluding the contexts above. Task-table keys and every `with_` prefix get `keyword`. Other keys are module candidates. |
| Ordinary mapping | Recursively mark scalar mapping keys `property.definition`. No contextual module lookup occurs once the fallback recursively owns a subtree. A root mapping therefore does not gain task semantics just because a key resembles a module. |

The context tables are maintained separately; they are not interchangeable.
Their exact complete source is [utils/ansible.ts][ansible]. Shared names include
`name`, `vars`, `become`, `tags`, `collections` and execution controls. Play-only
controls include `hosts`, gathering settings and task/role sections; block
adds `block`/`rescue`/`always`; task adds action/args, loop, retry, result and
handler controls. The `with_` prefix rule does not validate a lookup plugin.

Important traversal details from the [installed provider](/root/.vscode-server/extensions/redhat.ansible-26.8.2/packages/ansible-language-server/dist/providers/semanticTokenProvider.js):

- A task keyword ends traversal of that pair. Task `vars`, `environment`,
  `loop_control`, `module_defaults`, `action` and `local_action` therefore do not
  recursively receive semantic tokens. `args` is the sole special case.
- For `args`, find the first resolvable sibling key that is not a task keyword;
  apply that module's option schema if the value is a map. Modules named only
  inside `action` or `local_action` values are not found this way.
- A resolved module key receives `class` even when useful option documentation
  is absent. Only mapping-form module values enter argument processing.
  Free-form argument strings receive no semantic subdivision.
- Option lookup is exact and case-sensitive. Canonical option names and aliases
  point to the same parsed option. Known keys receive `method`. Recurse into a
  mapping only for documented `type: dict`, or into mapping items in a sequence
  for `type: list`; the walker does not additionally require `elements: dict`.
- Unknown option keys themselves receive **no semantic token**. Their values
  still enter ordinary recursive fallback, so nested mapping keys may receive
  `property.definition`. The same fallback handles values of recognized options
  whose type/value does not select typed recursion. Preserve this distinction
  when checking compatibility.
- An unresolved module candidate and its descendant mapping keys enter ordinary
  fallback. Unknown does not mean invalid, and it is not an error color.
- No scalar value is styled by this provider. Non-scalar keys and YAML aliases
  are not resolved into semantic symbol references.

## Where module and argument knowledge comes from

The documentation library discovers Python module files in configured
`module_locations` and `collections_paths`, alongside collection doc fragments
and runtime routing YAML. A sibling `collections/ansible_collections/...`
directory next to the document gets an additional lookup before the global
library. Collection module scanning includes nested directories, excludes
underscore-prefixed files and symlink module files. Execution-environment
configuration can first fetch documentation into the environment's configured
paths. No filter/test/lookup catalog is consumed by this library.
[Library][docs], [finder][finder], [adjacent collections][pac]

For a name containing at least three dot-separated components, use that name
as the candidate. Short names try `ansible.builtin.<name>`, then collections
from document metadata, then inline task/block/play `collections` declarations.
The inline collector walks the task and containing block chain to its parent
play and deduplicates declarations. Metadata looks for `meta/main.yml` derived
from a `tasks` path component. This is the extension's lookup algorithm; do not
silently substitute assumed Ansible runtime precedence. [Library][docs],
[context helpers][yaml], [metadata library][metadata]

Routing is module-only. The first candidate with a route can redirect to a
direct module-map entry; it is not an arbitrary redirect-chain resolver.
Routes and canonical modules can share the resulting documentation. Routing
deprecation/tombstone data does not produce semantic modifiers. Redirect names
with tombstones are omitted from the offered module-name set, but semantic
lookup itself does not apply an explicit tombstone rejection. The adjacent
collection helper's routing lookup requires exactly three components, whereas
the main library supports longer dotted module paths. [Library][docs],
[adjacent collections][pac], [documentation parser][parser]

Documentation is extracted lazily from Python triple-quoted assignments,
parsed as YAML and merged with `extends_documentation_fragment` definitions.
Only documentation with a string `module` field produces a processed module
schema. Options retain types, nested suboptions, aliases, choices and defaults;
only the first three affect semantic argument classification. This is static
documentation interpretation, not Python execution or module argument-spec
validation. Missing/broken fragments or nonstandard documentation can reduce
recognition. [Documentation parser][parser]

## Completion, failure and rendering limits

Completion separately offers keywords, modules, redirects, options/aliases,
choices/defaults/booleans, hosts and limited variables. It can use schema
completion before Ansible-specific completion. Its Jinja variable branch is
playbook-only and checks the literal spaced bracket forms `{{ ` and ` }}`;
its variables come from surrounding `vars`, play `vars_prompt`, and a limited
`vars_files` reader. There is no filter/test/lookup completion catalog in the
inspected provider. Highlighting coverage must not be inferred from completion
coverage or vice versa. [Completion][completion], [completion helpers][completionutils],
[context helpers][yaml]

Despite its name, the provider's `parseAllDocuments` helper returns one
`parseDocument` result with source tokens retained. Multi-document YAML is
therefore a parity limitation, confirmed by the probe below. The walker does not reject a parsed
document because it has YAML errors. Token ranges use original scalar ranges,
including quoting, and push one token length from the starting position; there
is no special multiline-key splitting. An exception escaping the provider is
caught by the server's semantic handler, which logs it and returns empty
tokens. Missing documents/workspace contexts also return empty tokens.
[Context helpers][yaml], [server handler][server]

VS Code applies semantic highlighting over TextMate when enabled by the
editor/theme. Semantic styles come from theme semantic selectors or standard
semantic-to-TextMate fallback scopes. Thus token parity alone is not color
parity: enablement, theme matching and range composition also matter. The
extension registers no custom semantic scope mapping. The embedded One Dark
Pro theme declares semantic highlighting; the embedded One Light asset lacks
that declaration. Under VS Code's default `configuredByTheme` setting this
enables overlays for the former and leaves them disabled for the latter;
explicit editor/language settings can override that decision. Compose semantic
styles property by property with lexical styles rather than replacing an
entire token's styling unconditionally. Effective configuration must be stated
when comparing colors. [VS Code semantic highlighting guide][vscode],
[extension manifest][package], [demo theme assets](highlight/assets/themes)

## Implemented demo boundary

The runtime retains the imported grammar and complete-file tokenization as its
base. `semantics.Classify` uses one yaml.v3 AST pipeline with goccy lexemes to
return the four categories and original byte ranges. `catalog.Load` loads the
embedded generated snapshot once per highlighter; it separates module existence
from available options and preserves aliases, nested types and routing. No
filter/test/lookup inventory is used.

`highlight.HighlightDocument` retains independent lexical and semantic evidence
and composes only defined semantic style properties. Ordered theme JSON rules
use type/modifier/language specificity with later equal-score wins per property.
Explicit fontStyle resets all four flags, while missing properties inherit the
lexical token's styles and background. Standard class and method fallback probes
are ordered alternatives; keyword and property each have one probe. The probes
are independent TextMate scope stacks. There are no invented type supertypes or
source-word color rules. The current themes match the pinned source-executed
VS Code style oracle: dark enabled, light disabled under configuredByTheme.

Every demo excerpt retains its complete source and logical URI/path context,
with explicit empty metadata collections. APIs can supply collection metadata
but never discover it from a path. The frozen snapshot covers 8,691 installed
modules, including Saltbox custom modules, with the measured schema boundary in
[catalog/README.md](catalog/README.md). Document-adjacent collections, another
installed environment and user semantic overrides are not inferred.

Portable fixtures match the real initialized provider on all 25 valid compact
cases (104 spans), both demo sources (116 + 7 spans), and decorated scalar keys.
The malformed compact case intentionally returns an explicit Go parse error and
zero spans where JS YAML recovered three prefix spans. The first-document-only
behavior remains upstream-compatible. Combined output additionally preserves
UTF-8 boundaries, quoted keys, CRLF offsets, lexical scopes and backgrounds.
Independent style fixtures exercise selector ordering, language/modifier
specificity, fallback alternatives, property inheritance and fontStyle resets.
See [semantic fixtures](semantics/testdata/README.md) and
[style fixtures](highlight/testdata/README.md).

## Focused runtime evidence

The controller ran the actual installed `doSemanticTokens` implementation with
a controlled module resolver backed by real `ansible-doc` metadata for
`ansible.builtin.debug`, `port_assignment` and
`community.docker.docker_container`. The final mixed fixture produced **62
semantic tokens and 10 module lookups**. Documented `networks` list members
`name`/`ipv4_address` and `healthcheck` dict members `test`/`interval` received
`method`; invented option keys did not. The companion TextMate oracle classified
`default`, `custom_filter`, `ansible.builtin.default`, and
`not_a_real_filter` as filters, `defined`/`custom_test` as tests, and
`lookup`/`query`/`custom_function` as functions, all with One Dark Pro foreground
`#61AFEF`. None of those Jinja names received semantic tokens.

The separate multi-document fixture emitted `class` for `debug` on line 2 and
`method` for `msg` on line 3, with **no tokens for the second document** on lines
5–6. These probes verify the actual classification walker with supplied module
documentation; they do not verify the full filesystem, collection-precedence,
execution-environment or redirect resolver. A fixture that supplies a list for
a documented dict deliberately exercises fallback, not typed list support.

Local evidence (ignored research artifacts, not portable committed fixtures):

- [Provider runner](../../.superpowers/sdd/demo-v4/semantic-provider-probe.mjs)
- [Mixed YAML fixture](../../.superpowers/sdd/demo-v4/semantic-probe.yml)
- [Provider results](../../.superpowers/sdd/demo-v4/semantic-provider-result.json)
- [TextMate results](../../.superpowers/sdd/demo-v4/semantic-probe-textmate.json)
- [Multi-document fixture](../../.superpowers/sdd/demo-v4/semantic-multidoc.yml)
- [Multi-document results](../../.superpowers/sdd/demo-v4/semantic-multidoc-result.json)

[semantic]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/providers/semanticTokenProvider.ts
[yaml]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/utils/yaml.ts
[ansible]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/utils/ansible.ts
[docs]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/services/docsLibrary.ts
[finder]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/utils/docsFinder.ts
[parser]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/utils/docsParser.ts
[pac]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/services/docsLibraryUtilsForPAC.ts
[metadata]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/services/metadataLibrary.ts
[completion]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/providers/completionProvider.ts
[completionutils]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/providers/completionProviderUtils.ts
[server]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/packages/ansible-language-server/src/ansibleLanguageService.ts
[package]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/package.json
[yamlgrammar]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/syntaxes/external/YAML.tmLanguage
[jinja]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/syntaxes/external/jinja.tmLanguage.json
[keywords]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/syntaxes/ansible/keywords.tmLanguage.plist
[braces]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/syntaxes/ansible/jinja-braces.tmLanguage.plist
[conditionals]: https://github.com/ansible/vscode-ansible/blob/v26.8.2/syntaxes/ansible/jinja-conditionals.tmLanguage.plist
[vscode]: https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide
