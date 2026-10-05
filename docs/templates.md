# Read-only template checks

Explicit paths and opened editor documents can check templates without changing
any source bytes. Conventional `roles/<role>/templates/`,
`resources/roles/<role>/templates/`, `resources/templates/` and `.j2` paths are
recognized, including files with no extension. Narrowing the source root inside
a template directory or opening a canonical alias never grants write eligibility.
Role context outside a narrowed root remains unavailable. Default directory and
`--changed-since` selection retain their existing YAML primary discovery.

```sh
saltbox-lint check --root . roles/example/templates/config
saltbox-lint explain --root . roles/example/templates/config
```

| Capability | YAML | Explicit or opened template |
|---|---|---|
| Check and rule help | Yes | Bounded static checks |
| Definition, hover, references and impact | Static source candidates | Supported static role reads |
| Completion edits | Supported literal arguments | Unavailable |
| Fix All, `check --fix` and formatting | Verified YAML edits | Unavailable |
| Rename, rendering and execution | Unavailable | Unavailable |

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

An owning template task with any explicit variable, block or comment delimiter
argument receives partial coverage, including arguments equal to the defaults.
The scanner does not combine task overrides with header options. Conflicting
owners, dynamic template task sources, unknown arguments and invalid owning
task YAML also prevent delimiter, reference and renderer-consumption claims.
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

Expression and statement argument validation uses a bounded static subset.
Unsupported collections, arithmetic, imports, extension tags and other grammar
receive partial coverage rather than fabricated syntax errors. Unknown extension
grammar stops further scanning and disables block and reference claims. Limits are 16 MiB per source, 512
tokens per tag, 32,768 total tokens, 4,096 tags, 64 KiB of lexed tag content,
128 findings, a 4 KiB configuration header and 128 bracket/block levels. These checks are not a full Jinja
parser and do not establish rendered output or runtime validity.

Static `role_var` and `role_web` inspection reuses the YAML declaration resolver.
Dynamic calls, lexical callee bindings, missing local context and runtime
providers remain unresolved. A supported selected template can own an existing
Traefik renderer finding when a task names it statically. Selecting both the task
and template reports that violation once at the template. YAML-only selections
retain their existing contract ownership.

Both `format --mode canonical` and `format --mode lint-fixes` return a skipped
plan with no template edits. `check --fix` rejects every selection containing a
template before writing any YAML, regardless of selection order. Read-only
`check --diff` can show YAML fixes beside templates and never emits a template
change. No template diagnostic carries a fix ID.
