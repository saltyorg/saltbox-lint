# Read-only template checks

Directory checks (including the default `.`), `--changed-since`, explicit paths
and opened editor documents check templates without changing any source bytes.
Conventional `roles/<role>/templates/`, `resources/roles/<role>/templates/`,
`resources/templates/` and `.j2` paths are recognized, including files with no
extension. Narrowing the source root inside a template directory or opening a
canonical alias never grants write eligibility. Role context outside a narrowed
root remains unavailable.

```sh
saltbox-lint check .
saltbox-lint check --root . roles/example/templates/config
saltbox-lint explain --root . roles/example/templates/config
```

Directory discovery admits every template candidate through the same loader
admission as a named template target, so classification, role context, findings
and their order are identical. Configured `exclude_paths` and Git ignore rules
apply to template candidates exactly as to YAML candidates. A root narrowed
inside a template directory treats every discovered file as a template. A
template-spelled directory target that aliases a YAML directory remains
unselected, so its YAML files never become writable through that spelling.
`explain` reports `directory_would_select: true` for a template that directory
discovery selects.

`--changed-since` selects a changed template itself, and selects existing
templates whose recorded dependencies changed. A template depends on its owning
role context: defaults, vars, tasks, handlers and other templates of that role,
plus the project configuration. Changing an owning task file therefore reselects
the role's templates, while changes in an unrelated role do not.

Editor requests keep canonical response paths even when a `.j2` or conventional
template spelling aliases YAML. `check`, `explain` and `query` accept
`--stdin-source-filename PATH` beside `--stdin-filename` to retain that original
spelling for snapshot classification. The loader requires an existing spelling
that resolves to the same in-root owner. Missing, retargeted or escaping aliases
fail instead of falling back to YAML policies. This option never grants writes.
Workspace scans publish diagnostics for closed templates. Closed template
watcher events, including roots narrowed inside a template directory, select
that template for a read-only saved check, as for a closed YAML source. They
also remain context changes for their dependents.

| Capability | YAML | Selected or opened template |
|---|---|---|
| Check and rule help | Yes | Bounded static checks |
| Definition, hover, references and impact | Static source candidates | Supported static role reads |
| Completion edits | Supported literal arguments | Unavailable |
| Fix All, `check --fix` and formatting | Verified YAML edits | Unavailable |
| Rename, rendering and execution | Unavailable | Unavailable |

Source writes require the disk identity acquired by the loader's opened read.
Every selected source is checked again before a fix batch, including sources
that need no change. Changed file or parent identities, retargeted aliases and
changed template ownership refuse the batch. Each replacement rechecks its own
owner and original bytes. Replacement is atomic per file; this is not an atomic
snapshot or a transaction across concurrent filesystem changes.

The scanner distinguishes literal output, quoted tag strings, comments, raw
blocks, expression tags and statement tags. It checks provable delimiter,
bracket, nesting, branch and ending errors. Supported block structure includes
`if`/`elif`/`else`, `for`/`else`, `block`, `macro`, `call`, capture `set`, `filter`,
`with` and `autoescape`. Whitespace trim markers retain their exact bytes.
Literal indentation, headers, blank lines, wrapping and final newlines receive
no style diagnostics.

The `#jinja2:` header accepts plain nonempty quoted strings for the six variable,
block and comment delimiters, and Python `True`/`False` values for `trim_blocks`,
`lstrip_blocks` and `keep_trailing_newline`. Prefix-overlapping delimiters,
unknown or repeated options, escaped delimiter literals, malformed values and
active line-statement/comment prefixes return `template-partial-coverage` with
an explicit reason. The scanner does not fall back to default delimiters after
an unsupported header. `None` line prefixes keep ordinary tag scanning.

Variable and block endings that start with a letter, digit, non-ASCII byte, or
one of `_ . = * /` also receive partial coverage. Such endings can occur inside
identifier, number or operator tokens. Bare `+`/`-` endings and those signs
followed by a digit are also unsupported because they can split an exponent.
Their full custom-delimiter precedence is outside the bounded scanner.
For example, an ending of `api` never splits
`traefik_middleware_api` into a false read or missing-consumption finding.
Comment endings do not lex expression tokens and retain their literal behavior.

An owning template task with any explicit variable, block or comment delimiter
argument receives partial coverage, including arguments equal to the defaults.
The scanner does not combine task overrides with header options. Conflicting
owners, unknown arguments and invalid owning task YAML also prevent delimiter,
reference and renderer-consumption claims. A dynamic, `!unsafe` or unsupported
task source could render any template in its role, so it prevents these claims
only when that task carries delimiter arguments, applicable delimiter
`module_defaults` or arguments that cannot be read statically; otherwise every
template it might render uses the default grammar.
These reasons appear in `explain`, reference-source records and navigation
coverage. Task configuration is read before template tags can select cross-role
reference context. Unrelated tasks and ordinary task variables do not supply
delimiter arguments. Applicable task or block `module_defaults` with delimiter
options also prevent these claims. Dynamic defaults and action groups have
unknown applicability and receive partial coverage. Literal defaults for a known
unrelated module, and template defaults without delimiter options, retain the
ordinary scanner. No default values or group memberships are evaluated.
The configuration guard also treats `ansible.legacy.template`, including
`action` and `local_action`, as a possible owner without assigning builtin
module contracts to that namespace. Conventional role-relative source aliases
are compared through the source loader's root boundaries. Absolute paths, home
expansion, dot traversal and a `templates/` source prefix receive partial
coverage because their Ansible search behavior is outside this static subset.
An admitted leaf alias retains its selected diagnostic path and the canonical
template's in-root role context. An original conventional template spelling
remains read-only after directory aliases are resolved. Canonical editor
snapshots retain the original spelling's in-root role context and task
dependencies, including when both spellings name templates. Cross-role aliases
decline unsupported task configuration resolution. A narrowed root never reads
the canonical role's context outside that root.

Expression and statement argument validation uses a bounded static subset.
Template expressions accept Jinja arithmetic and concatenation (`+`, `-`, `~`,
`*`, `/`, `//`, `%`, `**` and unary `-`) with Jinja precedence; a leading `+`
remains outside the subset because Jinja reads `{{+` as a whitespace control.
List and dict literals, including empty and trailing-comma forms, are accepted
anywhere an expression is. Comprehensions, imports, extension tags and other
unsupported grammar receive partial coverage rather than fabricated syntax
errors. Unknown extension
grammar stops further scanning and disables block and reference claims. Limits are 16 MiB per source, 512
tokens per tag, 32,768 total tokens, 4,096 tags, 64 KiB of lexed tag content,
128 findings, a 4 KiB configuration header and 128 bracket/block levels. These checks are not a full Jinja
parser and do not establish rendered output or runtime validity.

Static `role_var` and `role_web` inspection reuses the YAML declaration resolver.
Dynamic calls, lexical callee bindings, missing local context and runtime
providers remain unresolved. A supported selected template can own an existing
Traefik renderer finding when a task names it statically. Selecting both the task
and template, as directory checks do, reports that violation once at the
template. YAML-only selections retain their existing contract ownership.
Selecting several aliases of the same admitted template reports its renderer
violation at the first selected path in lexical order. An unsaved template
buffer supplies that output's admitted aliases for the current invocation.
Equal file contents alone never establish ownership.

Both `format --mode canonical` and `format --mode lint-fixes` return a skipped
plan with no template edits. `check --fix` rejects every selection containing an
explicitly named template target (a file path or stdin) before writing any
YAML, regardless of selection order. Templates selected only by directory
discovery are checked and never written: `check --fix .` applies verified YAML
fixes and leaves every template byte unchanged. Those templates still take part
in the batch's identity and byte revalidation, so a template changed or
retargeted during the run refuses the whole batch. Template findings keep the
exit status at 1 after fixing. `--fix` cannot be combined with `--changed-since`.
Read-only `check --diff` can show YAML fixes beside templates and never emits a
template change. No template diagnostic carries a fix ID.
