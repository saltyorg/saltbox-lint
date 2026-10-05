# Contributing

Use Go from `go.mod`, Node from `extension/.node-version`, npm 11.19.0, GNU make,
Git and bash. `make tools` installs the pinned developer tools in ignored
`bin/tools`. `make check` is the non-mutating quality gate. It checks Go formatting
and module tidiness, runs vet, lint, race suites, extension build/unit/release
checks, actionlint, GoReleaser configuration checks, documentation links and
generated documentation freshness. Tool caches and ignored build artifacts may
be populated.

The extension's `npm run check` runs TypeScript and the pinned type-aware ESLint
gate. `npm run lint` checks promise handling and dangerous non-null assertion
patterns in `extension/src` and its TypeScript tests. The build invokes this
same gate locally and in every native CI job. Ordinary tests also exercise
POSIX/Windows path identities and temporary Git fixtures without an external
author identity. These checks supplement the native platform suites.

For live lint diagnostics in VS Code, install the official
[ESLint extension](https://github.com/microsoft/vscode-eslint) and run
`npm --prefix extension ci --ignore-scripts`. When opening the repository root,
set `eslint.workingDirectories` to `["./extension"]` in your editor settings.
Opening `extension/` directly uses its configuration automatically. The editor
uses the project's pinned ESLint and the same rules as `npm run lint`; the
command-line gates work without installing the editor extension.
ESLint 10.12.0 requires Node `^20.19.0 || ^22.13.0 || >=24`. If the editor's
embedded Node is older, set `eslint.runtime` to the absolute path of your Node
24.20.0 executable, or to `"node"` when that version is on the editor's PATH.
The ESLint extension's [runtime and working-directory settings](https://github.com/microsoft/vscode-eslint#settings-options)
control this development setup independently of the packaged Saltbox extension.

`make build` runs that gate before producing `bin/saltbox-lint`.
`make snapshot` also packages all native archives, VSIXs and source. See
[release validation](extension-release.md) and [rule authoring](rule-authoring.md).
Normal builds and runtime checks need no Python or Ansible installation.
`make catalog` explicitly refreshes the frozen catalog through the managed
Ansible wrappers; it does not execute consumer modules or roles.

## Preservation fuzzing

`go test ./lint ./format ./yamlindex -run '^Fuzz'` runs committed seeds without
mutation. The same seeds run in `make check`. They cover parsing, expression
spans, source coordinates, whitespace plans, authorized structural plans and
canonical formatting. Shared source examples live in
`lint/testdata/preservation`; minimized failures belong in the affected package's
`testdata/fuzz/<target>/` directory.

`make fuzz-check` is an opt-in qualification campaign. It runs those six targets
sequentially, with 10 seconds per target, two workers, `GOMAXPROCS=2`, and a
one-minute test timeout per invocation. Source targets limit inputs to 2 KiB and
a conservative lexical budget of 64 units, starting at one unit. Each newline,
opening delimiter, `-`, `:` and ASCII word start consumes a unit, including in
quotes and comments. This limits potential recursion in compact collections and
unary expressions without asserting a parser-specific semantic depth. The
structural target limits payloads to 16 bytes and generates bounded conditions
with independently specified expected bytes, including unsupported conditions.
The command executes no Ansible or Jinja code and reads no consumer repositories.

Run one full campaign before delivering parser or edit-preservation changes.
Before starting, record the commit, Go version, target names, seed paths and
SHA-256 hashes, durations and worker count in the external project task folder.
Retain each invocation's command, exit status, output and every failure. If a
property fails, retain the minimized input, reproduce it against the original
implementation, make a focused correction, and run all six targets against the
corrected commit with the same budgets. Record corrective campaigns separately;
an earlier failure remains part of the qualification record. Commit only seed
examples and minimized regressions, never transient fuzz caches or consumer
source dumps. Successful bounded campaigns supplement the required quality gate
and CI; they do not prove the absence of defects.

## Documentation maintenance

Run `make rules-update` after changing rule metadata. It writes only the
[generated rule reference](rules.md), using the public registry projection.
`make docs-check` verifies its freshness without rewriting it.

Run `make docs-update` after changing the packaging target map. It writes only
`docs/platforms.md`. `make docs-check` checks freshness without writing, runs
link-checker regressions and checks maintained public links offline. CI invokes
this gate through `make check`.

The maintained set includes the root README, extension README/changelog/privacy/
support pages, qualification and oracle instructions, highlighting asset/fixture
instructions, and every top-level Markdown guide in `docs/`. Archived prototype
READMEs, third-party documentation and agent instructions are outside this check.

The checker supports one-line inline Markdown links/images, reference links
with one-line definitions, and quoted HTML `href`/`src` attributes. Use angle
brackets or percent encoding for destinations with spaces or parentheses.
Fenced examples and inline-code examples are excluded. Anchor checking supports
ATX headings with GitHub-style lowercase letter/number/underscore/hyphen slugs,
space-to-hyphen conversion, duplicate-heading suffixes and explicit HTML `id`
attributes. Use these forms for maintained anchor targets; Setext headings and
complex embedded HTML heading syntax are outside this subset.

Relative paths resolve from their document; `/` paths resolve from the repository
root. Same-repository GitHub `blob/main` and `tree/main` URLs resolve to this
checkout too. External URLs, published-tag URLs and release/download pages are
outside the offline check. Verify those manually when adding or updating them.
The checker makes no requests to GitHub or other network services.

The README ships in standalone archives, and the extension README ships in
VSIXs. Link from those packaged documents to public repository guides; relative
links should target only files that accompany the document in its package.
Task plans, research and verification reports belong in the external project
documentation folder. Never link public guides to private working documents.
