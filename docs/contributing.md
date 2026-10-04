# Contributing

Use Go from `go.mod`, Node from `extension/.node-version`, npm 11.19.0, GNU make,
Git and bash. `make tools` installs the pinned developer tools in ignored
`bin/tools`. `make check` is the non-mutating quality gate. It checks Go formatting
and module tidiness, runs vet, lint, race suites, extension build/unit/release
checks, actionlint, GoReleaser configuration checks, documentation links and
generated documentation freshness. Tool caches and ignored build artifacts may
be populated.

`make build` runs that gate before producing `bin/saltbox-lint`.
`make snapshot` also packages all native archives, VSIXs and source. See
[release validation](extension-release.md) and [rule authoring](rule-authoring.md).
Normal builds and runtime checks need no Python or Ansible installation.
`make catalog` explicitly refreshes the frozen catalog through the managed
Ansible wrappers; it does not execute consumer modules or roles.

## Documentation maintenance

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
