# Saltbox Lint

A standalone Go linter for Saltbox and Sandbox YAML/Jinja policy. One engine
supplies 29 documented rules, selected-file checks, conservative formatting
fixes, VS Code tasks, and GitHub annotations. It does not execute Ansible,
Python, templates, or lookups. Licensed under [GPLv3](LICENSE).

## Install

Linux amd64 and arm64 are supported, including WSL and Linux Remote SSH hosts.
Release archives contain `saltbox-lint`, this README, and the license. Choose an
exact published stable tag, download its matching architecture archive and
`checksums.txt`, verify the archive's exact checksum entry, then put the binary
on your PATH. Archive names are `saltbox-lint_VERSION_linux_ARCH.tar.gz`, with
VERSION excluding the leading `v`. The [Action](action.yml) automates that
installation on Linux X64/ARM64 runners without sudo.

With Go 1.27.1 or newer, installation from the module root is also supported:

```sh
go install github.com/saltyorg/saltbox-lint@v0.1.0
```

`v0.1.0` is illustrative; substitute a published version. This documentation
and its examples do not assert that a release has been published. Source builds
without release linker flags report `dev`; `go version -m` shows Go module/build
metadata. For a local checkout, run `make build` and use `bin/saltbox-lint`.

## Commands

```sh
saltbox-lint check .
saltbox-lint check roles/example/defaults/main.yml
saltbox-lint check --root . --format concise -- 'roles/example/tasks/file name.yml'
saltbox-lint check --format json -- roles/example resources/tasks
saltbox-lint check --diff -- roles/example/defaults/main.yml
saltbox-lint check --fix -- roles/example/defaults/main.yml
saltbox-lint check - --stdin-filename roles/example/defaults/main.yml < saved-buffer.yml
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

## Output and fixes

`--format human` is the default: locations, excerpts, hints, related context.
`--format concise` emits one primary finding per line:

```text
path:line:column: error [rule-id] message
```

Concise paths are source-root-relative, positions one-based, columns UTF-16 for
VS Code; embedded CR/LF become visible escapes. Human columns count Unicode code
points. Clean concise output is empty. JSON always emits one object with a
`diagnostics` array, including an empty array for clean input. Each diagnostic
contains `path`, `rule_id`, `severity`, `message`, `range` and `span`, and optional
`expected`, `related`, `fix`. Range lines/columns are one-based code points with
a half-open end; span offsets are half-open UTF-8 bytes in the original source.
Fix edits refer to that original source, too. Structured stdout contains no
progress/status text.

`--format github` emits escaped workflow-command annotations and, when
`GITHUB_STEP_SUMMARY` is set, appends a Markdown summary. Multiline annotations
use line ranges; single-line annotations also include columns. Summary appends
are bounded to 100 findings/64 KiB and explicitly count omitted findings.
Annotations and JSON still represent the full diagnostic set. File identity and
cross-repository summary environment details are in [migration guidance](docs/rule-migration.md).

Only explicit `check --fix` writes source files. Safe whitespace edits preserve
YAML structure, comments, scalar styles/tags, exact Jinja string contents and
non-whitespace tokens. Already-valid formatting stays byte-for-byte unchanged.
Unsupported or uncertain edits remain diagnostics. Tag renames, source headers,
lookup semantics, section moves and healthcheck conversion require manual edits.
`examples.yaml` is the preserved failing-example collection: test fixes on copies.

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
No extension or language server is required; no consumer configuration is
installed automatically.

## Contribute and package

Prerequisites: Go from `go.mod`, GNU make, Git, bash and Linux Action
utilities above. `make tools` installs pinned developer tools under ignored
`bin/tools`; Go's build/module caches can also be populated. `make check` checks
formatting without rewriting files, verifies module tidiness with `go mod tidy
-diff`, runs vet, standard golangci-lint checks, race tests (including Action and
editor integrations), Bash syntax checks, actionlint for workflows/examples,
and GoReleaser configuration validation. CI uses the same gates.

`make build` completes `make check` before building `bin/saltbox-lint` with
CGO disabled. `make snapshot` completes the same gate and creates local Linux
amd64/arm64 archives plus `checksums.txt` in ignored `dist/`. It publishes nothing.
`make build VERSION=1.2.3` injects an explicit local version. The release workflow
publishes through GoReleaser only when an exact stable version tag is explicitly
pushed in a future authorized release. Defining this workflow is not a release.

See [rule authoring](docs/rule-authoring.md), [the 40-to-29 migration mapping](docs/rule-migration.md),
[primary-source research](docs/research.md), and [contributor instructions](AGENTS.md).
