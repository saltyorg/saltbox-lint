# Saltbox Lint

A standalone Go linter for Saltbox and Sandbox YAML/Jinja policy. One engine
supplies the documented rule registry, selected-file checks, conservative
formatting fixes, VS Code tasks, and GitHub annotations. It does not execute
Ansible, Python, templates, or lookups. Licensed under [GPLv3](LICENSE).

## Install

Linux amd64 and arm64 are supported, including WSL and Linux Remote SSH hosts.
Release archives contain `saltbox-lint`, this README, the project license, and
the applicable third-party notices and licenses. Choose an
exact published stable tag, download its matching architecture archive and
`checksums.txt`, verify the archive's exact checksum entry, then put the binary
on your PATH. Archive names are `saltbox-lint_VERSION_linux_ARCH.tar.gz`, with
VERSION excluding the leading `v`. The [Action](action.yml) automates that
installation on Linux X64/ARM64 runners without sudo.

With Go 1.27.1 or newer, installation from a complete local checkout is also
supported. The checkout must include the repository's `third_party/nuri`
replacement, and the command must run from the module root:

```sh
git clone https://github.com/saltyorg/saltbox-lint.git
cd saltbox-lint
go install .
```

Source builds without release linker flags report `dev`; `go version -m` shows
Go module/build metadata. For the checked local build path, run `make build`
and use `bin/saltbox-lint`.

## Commands

```sh
saltbox-lint check .
saltbox-lint check roles/example/defaults/main.yml
saltbox-lint check --root . --format concise -- 'roles/example/tasks/file name.yml'
saltbox-lint check --format human > findings.txt
saltbox-lint check --format json -- roles/example resources/tasks
saltbox-lint check --diff -- roles/example/defaults/main.yml
saltbox-lint check --fix -- roles/example/defaults/main.yml
saltbox-lint check - --stdin-filename roles/example/defaults/main.yml < saved-buffer.yml
saltbox-lint format --root . --stdin-filename roles/example/defaults/main.yml - < editor-buffer.yml
saltbox-lint format --mode lint-fixes --root . --stdin-filename roles/example/tasks/main.yml - < editor-buffer.yml
saltbox-lint rules
saltbox-lint rules ansible-static-import
saltbox-lint --version
```

`check` defaults to `.`. Directory checks discover conventional role defaults,
tasks, handlers and vars, shared tasks, inventory variables and playbooks;
explicit YAML files also receive applicable generic rules. Git discovery uses
tracked and nonignored untracked files; explicitly selected files override
ignores. Working-tree contents are read, including local edits. The root is
inferred from the first target's nearest Saltbox/Sandbox project marker or Git
root; `--root` selects it explicitly. All targets belong to one root. Relative
targets resolve from the working directory. Selected files may require extra
context, but only primary findings in selected files are reported.

`-` reads stdin and requires `--stdin-filename`; it can accompany other targets
and overlays that filename without writing it. Input may be empty. `--fix` and
`--diff` reject stdin and cannot be combined. `--diff` prints a verified unified
patch on stdout and all original findings on stderr; human/concise output is
supported for those diagnostics. JSON/GitHub cannot be combined with `--diff`.
Diff hunks intentionally contain whole changed files and are valid for
`git apply`. A file without a supported safe fix can have findings with no patch.

Exit status is **0** for clean input (including successful fixes leaving no
findings), **1** for lint or YAML parse findings, and **2** for usage, loading,
writing or reporting failures. The Action preserves those statuses.

`format` is a read-only editor endpoint. It requires exactly one `-` input and
`--stdin-filename PATH`; `--root` has the same identity and context meaning as
`check`. The default `--mode canonical` formats only the supplied YAML snapshot
and does not scan the repository or invoke Git. `--mode lint-fixes` loads the
snapshot's required repository context, runs the normal analysis, and returns
the nonconflicting source-edit union verified by the existing conservative fix
planner. Neither mode writes a source file.

Every successful invocation writes one compact JSON object with this schema:

```json
{
  "schema_version": 1,
  "path": "roles/example/defaults/main.yml",
  "source_sha256": "b763a98d390ddd84e68a0e80ebd8b77bfde05227cf893e6b8589b0ecc2e2c8a4",
  "status": "ready",
  "edits": [
    {
      "range": {
        "start": {"line": 1, "column": 1},
        "end": {"line": 1, "column": 1}
      },
      "span": {"start": 0, "end": 0},
      "text": "replacement"
    }
  ]
}
```

`path` is the canonical root-relative slash identity and `source_sha256` hashes
the exact stdin bytes. Status is `ready`, `unchanged`, or `skipped`; `edits` is
always an array and is empty for the latter two statuses. A skipped response also
has a nonempty `reason`. Ranges are half-open, one-based Unicode code-point
positions matching check JSON, while spans are half-open UTF-8 byte offsets in
the exact submitted snapshot. Editor consumers must verify the schema, path and
hash, reject invalid or overlapping spans, and translate code-point positions to
zero-based UTF-16 positions against that same snapshot before creating editor
edits.

Canonical formatting uses two-space block indentation, retains empty `{}` and
`[]`, and normalizes structural spacing. It converts only simple quoted strings
to double quotes. Mixed quotes, escapes, and Jinja inner quote choices are
protected; for example, `message: 'He said "hello"'` remains unchanged. Line
endings and final-newline state are preserved. If a final flow collection has a
trailing blank gap but no final newline, canonical mode returns `skipped` with a
specific reason because removing the closing delimiter cannot preserve both the
gap location and EOF state. It never relocates that gap or adds trailing spaces.

Ready, unchanged, and skipped plans exit **0**. Invalid arguments, root/path
failures, cancellation, input failures, context loading failures, planner
failures, and JSON output failures are operational errors on stderr with exit
**2**. JSON stdout never contains ANSI styling or progress text.

## Output and fixes

`--format auto` is the default. It selects human output when the
diagnostic destination is a capable terminal, and concise output for pipes,
files, buffers, or `TERM=dumb`. In `--diff` mode the diagnostic destination is
stderr, independently of the patch on stdout. Explicit `--format human` keeps
the same layout when redirected, which is useful for readable exports.
Human output uses the full detected destination width, with an 80-column fallback
when detection is unavailable. Long source lines wrap visually without changing
the source or suggested edits.

The persistent `--color auto|always|never` flag controls human findings and
detailed rule help. `auto` styles capable terminals unless `NO_COLOR` has a
nonempty value. Explicit `always` and `never` override `NO_COLOR`. Color does
not select a format: concise, JSON, GitHub annotations, and diff patches remain
plain even with `--color always`.

The persistent `--theme auto|dark|light` flag selects One Dark Pro or One Light.
`auto` asks a colored terminal for its background once, with a short timeout and
a dark fallback. Explicit choices bypass detection. Detection uses the terminal
separately from source stdin; redirected output and `NO_COLOR` never trigger a
query.

`--format human` groups findings by file beneath the Saltbox Lint banner. Each
file heading has heavy rules above and below it; findings within a file use light
dividers. When a rule supplies an exact suggestion, it shows a comparison: `-`
is current source and `+` is suggested source, with original/suggested line numbers. Color
adds subtle removed/added backgrounds while preserving syntax colors. Identical
shared formatting proposals appear once, with references from later findings.
A suggestion is **not permission to apply it**: only findings marked **Fix
available** participate in `--fix`. Manual suggestions, such as tag renames and
lookup rewrites, remain manual. Where no exact suggestion is available,
the report retains the marked source excerpt and Expected guidance. Related
locations, every changed line, and every marked source line remain visible.
Comparisons show two unchanged context lines around each hunk and label gaps;
excerpts show one context line around marked spans. Wrapped rows use `↪` and
blank line-number cells, keeping the `+`/`-` marker. Whitespace and grapheme
boundaries are preserved, and fix guidance is separated from code by a blank
line. Human comparisons are presentation, not patches; use `check --diff` for
the safe formatting patch.

Source highlighting classifies semantic context from complete documents with a
frozen catalog that approximates the Ansible language server's module, argument,
and keyword classifications. Embedded Ansible/Jinja TextMate rules scan only
the stateful source prefix needed for displayed/context lines. Immutable
document checkpoints resume scanning after validated edits and reuse unchanged
lines only when the complete grammar state converges. Both themes display the
same Ansible semantic categories using their own theme rules and TextMate fallback palettes; the imported theme files
remain unchanged. Filters and tests remain owned by the Jinja grammar. Explicit
collections in the document and already loaded role metadata influence module
lookup. User editor customizations, language-server execution, and undiscovered
adjacent metadata are outside this renderer. Invalid YAML or unsupported
highlighting still renders its findings with lexical or plain source text.

Human file groups render through a bounded worker pool capped by available Go
parallelism, eight workers, and the number of affected files. The writer retains
diagnostic order while streaming the title, findings, and summary. Findings
stream in fragments of at most 64 KiB and flush at finding boundaries; at most
four queued fragments per scheduled file and four files per worker bound queued
payload to 8 MiB. Lexical line reuse and document checkpoints share a 64 MiB
retained-cache ceiling per report. These bounds exclude source/semantic
documents, active rendering and grammar resources; they are not total RSS limits.

`--format concise` emits one primary finding per line:

```text
path:line:column: error [rule-id] message
```

Concise paths are source-root-relative, positions one-based, columns UTF-16 for
VS Code; embedded CR/LF become visible escapes. Human columns count Unicode code
points. Clean concise output is empty. JSON schema version 2 always emits one
object with `schema_version: 2`, a `diagnostics` array and a shared `fixes` array.
Both arrays are empty for clean input. Each diagnostic contains `path`, `rule_id`,
`severity`, `message`, `range` and `span`, and optional `expected`, `related` and
`fix_id`. Range lines/columns are one-based code points with a half-open end;
span offsets are half-open UTF-8 bytes in the original source.

Each shared fix contains `id`, `path`, `message` and `edits`. Each edit retains
its original `range`, `span` and replacement `text`. Identical fixes for the same
path share one record, even when several findings refer to them. IDs are
`fix-1`, `fix-2`, and so on in first diagnostic occurrence order; they are local
to each report. Findings without an automatic fix omit `fix_id`. Manual previews
never create a fix record or reference. Structured stdout contains no
progress/status text.

To migrate a version 1 reader, replace access to `diagnostic.fix` with a lookup
of `diagnostic.fix_id` in the top-level `fixes` array, indexed by `id`. The shared
fix's `path` owns its edits. Keep processing every diagnostic, but process each
referenced fix once. There is no legacy-format flag; diagnostic fields and edit
positions otherwise retain their previous meaning.

`--format github` emits escaped workflow-command annotations and, when
`GITHUB_STEP_SUMMARY` is set, appends a Markdown summary. Multiline annotations
use line ranges; single-line annotations also include columns. Summary appends
are bounded to 100 findings/64 KiB and explicitly count omitted findings.
Annotations and JSON still represent the full diagnostic set. File identity and
cross-repository summary environment details are in [migration guidance](docs/rule-migration.md).

`saltbox-lint rules` keeps its compact one-rule-per-line listing.
`saltbox-lint rules RULE_ID` uses the same destination-aware width and color
settings as human findings, with readable plain details when redirected.

Only explicit `check --fix` writes source files. Safe whitespace edits preserve
YAML structure, comments, scalar styles/tags, exact Jinja string contents and
non-whitespace tokens. Already-valid formatting stays byte-for-byte unchanged.
The expression rules also support these verified corrections:

- `jinja-conditional-length` wraps violating inline conditionals, including forms
  without `else`, using the existing alignment policy and unchanged tokens.
- `ansible-when-parentheses` groups a complete parsed string condition. Fixes
  support undecorated, single-line plain or quoted scalars, including list items.
  Typed YAML booleans, anchors, tags and block conditions retain guidance only.
- `jinja-redundant-conditional-parentheses` removes complete outer result groups
  around standalone output conditionals with `else`. Tuples, call/filter/operator
  groups, nested branch groups, literal text and whitespace controls are preserved.
- `ansible-when-list` splits a standalone, undecorated plain `when` field only
  when every top-level conjunction operand is known to produce a boolean. It
  preserves operand order, short circuiting and explicit groups. Boolean literals,
  comparisons, negation and supported zero-argument built-in boolean tests can
  qualify. Unknown variables or lookup results used as operands, unknown tests,
  and results modified by filters or conditional expressions do not qualify.
  Existing list items, quoted/block scalars and inline comments retain guidance.

- `docker-healthcheck-shape` converts otherwise valid flow test lists in block
  healthcheck mappings to block lists. Scalar spellings, quotes, types, command
  markers, order and comments are preserved, including line-local shell allowances.
  Invalid cardinality, missing commands, nulls, collections, aliases, anchors,
  tags, multiline scalars and ambiguous comment/allowance placement remain manual.
- `computed-default-documentation` inserts `# Skip docs` immediately above an
  owner-local computed declaration at a safe block declaration boundary. Existing
  directives and all YAML data remain unchanged; generated inventory documentation
  intentionally excludes the computed value.
- `ansible-source-header` repairs borders, metadata order and the initial document
  marker only when complete existing Title, Author(s), URL and GPL metadata can
  form a header within 20 lines. Metadata values and associated comments are
  retained. Incomplete or ambiguous headers, multiple documents, BOMs and YAML
  directives remain manual. Without a marker after the metadata, ordinary trailing comments
  or blank lines are ambiguous and header repair is declined. Representation fixes
  require consistent LF or CRLF.

Expression fixes use a bounded Jinja grammar: names, literals, direct reads,
subscriptions, calls, filters/tests, comparisons, boolean operators and
conditionals. Arithmetic, tuples, container literals and other unsupported syntax
remain manual. No Python or Ansible runtime dependency is required. Interacting
expression, representation, documentation and layout corrections share one source
edit plan; the planner,
read-only editor endpoint and disk writer rederive the exact authorized
transformation from the original bytes. A preview never authorizes a fix.

Unsupported or uncertain edits remain diagnostics. Tag renames and lookup
semantics require manual edits. `defaults-sections` remains diagnostic-only:
reordering declarations changes the mapping iteration order retained by Ansible.
Section comments are never relabeled over existing values to satisfy ordering.
`examples.yaml` is an optional, gitignored local scratch file for cases that
should fail. Check it explicitly when needed and test fixes on copies. Automated
tests use committed regression fixtures in `lint/testdata` and do not require it.

`section-spacing` requires at least one blank line between a three-line section
banner and its variables in defaults, vars, inventory variables and explicitly
selected generic YAML. Custom section titles follow the same spacing policy.
`--fix` inserts only missing separators, before attached documentation comments;
existing blank lines, comment contents and line endings remain unchanged.

## GitHub Action and VS Code

The [composite Action](action.yml) requires an exact stable `version` such as
`v0.1.0`, supports `working-directory` (default `.` relative to
`GITHUB_WORKSPACE`) and newline-separated literal `paths` (default `.`). Blank
lines are ignored and CRLF lists are supported; spaces and shell metacharacters
are literal. Newlines cannot occur inside one path. Paths cannot supply options
such as `--fix`; no arbitrary-argument input exists. Downloads are verified
against exactly one matching SHA-256 entry and checked for the requested binary
version. Unsupported platforms and installation failures exit 2. It needs bash,
curl, tar, awk and sha256sum, as provided by standard Linux GitHub runners.
See the [four consumer templates](docs/rule-migration.md#four-consumer-workflow-migrations)
for Action commit and binary version pins, Saltbox facts tests, and nested
Sandbox checkout handling.

To adopt [examples/vscode/tasks.json](examples/vscode/tasks.json), copy or merge
its tasks into `.vscode/tasks.json` in the chosen consumer workspace. Open the
repository root as the workspace folder and put `saltbox-lint` on that host's
PATH. Tasks cover the current saved file, workspace, and an explicitly named
current-file fix. Save before checking/fixing: tasks read disk, not unsaved
editor buffers. Files outside the workspace root are rejected. In WSL or Remote
SSH, open the repository with that VS Code remote connection and install the
Linux binary on the remote host. The process tasks pass literal argv and use an
explicit `--root` matching their problem matcher's workspace-relative paths.
They retain explicit `--format concise`; this stable editor contract never emits
ANSI styling, including when the inherited `--color always` flag is supplied.
No extension or language server is required; no consumer configuration is
installed automatically.

## Contribute and package

Prerequisites: Go from `go.mod`, GNU make, Git, bash and Linux Action
utilities above. `make tools` installs pinned developer tools under ignored
`bin/tools`; Go's build/module caches can also be populated. `make check` checks
formatting without rewriting files, verifies module tidiness with `go mod tidy
-diff`, runs vet, standard golangci-lint checks, race tests (including the patched
Nuri module, Action and editor integrations), Bash syntax checks, actionlint for
workflows/examples, and GoReleaser configuration validation. CI uses the same gates.

The production highlighter uses embedded Ansible/Jinja grammars, dark/light
themes, and a frozen Ansible module catalog. Normal checks and builds require no
Ansible or Python runtime. Maintainers can explicitly refresh the catalog with
`make catalog`, which uses the Saltbox-managed `ansible-doc` and
`ansible-galaxy` wrappers without running modules, roles, or playbooks.

`make build` completes `make check` before building `bin/saltbox-lint` with
CGO disabled. `make snapshot` completes the same gate and creates local Linux
amd64/arm64 archives plus `checksums.txt` in ignored `dist/`. It publishes nothing.
`make build VERSION=1.2.3` injects an explicit local version. The release workflow
publishes through GoReleaser only when an exact stable version tag is explicitly
pushed in a future authorized release. Defining this workflow is not a release.

See [rule authoring](docs/rule-authoring.md), [the 40-to-29 migration mapping](docs/rule-migration.md),
[primary-source research](docs/research.md), [terminal rendering results](docs/terminal-rendering-results.md),
and [contributor instructions](AGENTS.md).
