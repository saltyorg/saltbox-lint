# Markdown demo v4

This standalone Go module renders the three-finding Saltbox Lint Markdown demo
with Glamour. Each fenced block is selected from an embedded complete source
fixture after Ansible TextMate tokenization and semantic classification.
Chroma supplies Glamour's formatter hook; its lexer is a plain pass-through.

The highlighter embeds the Ansible 26.8.2 grammars, authentic One Dark Pro and
One Light themes, and a generated catalog of the configured installed modules.
It runs Oniguruma through Wazero and Nuri v1.0.1 with the documented functional
compatibility patch and formatting-only changes in
[third_party/nuri/PATCHES.md](third_party/nuri/PATCHES.md).

Semantic classification follows the installed Ansible language server's YAML
key contract. Known modules receive `class`, documented options `method`,
contextual keywords `keyword`, and ordinary fallback keys `property.definition`.
The actual theme owns colors, through ordered semantic selectors and VS Code's
standard scope fallbacks. No source-word color table or contrast adjustment is
used. Original lexical scopes and source bytes are retained.

With VS Code's `configuredByTheme` baseline, One Dark Pro enables semantic
highlighting: modules are gold (`#E5C07B`), options blue (`#61AFEF`), and task
`when` keys purple (`#C678DD`). The pinned One Light does not enable semantics;
its displayed `when` keys retain lexical blue (`#4078F2`). Filters, tests and
custom Jinja calls retain their grammar colors in both themes.

Build and run from the repository root:

```sh
make -C examples/markdown-demo-v4 build
./bin/markdown-demo-v4 --theme auto
./bin/markdown-demo-v4 --theme dark
./bin/markdown-demo-v4 --theme light
```

`make build` regenerates the catalog through the installed managed Ansible
wrappers, runs `make check`, and builds with `CGO_ENABLED=0`. See
[catalog/README.md](catalog/README.md) for reproducible generation and its
provenance. The finished binary requires no Ansible, Node, Python, JavaScript,
source checkout, network or external process at runtime. To build from the
already frozen catalog, use:

```sh
CGO_ENABLED=0 go -C examples/markdown-demo-v4 build -o ../../bin/markdown-demo-v4 .
```

`--theme auto` sends one OSC 11 background query through `/dev/tty` when stdout
is a terminal. It falls back to dark after a bounded wait when unsupported.
Explicit themes and redirected output do not query. Standard input is never
read, so piped source remains untouched.

The fixtures keep reported locations `102:9`, `148:7`, and `10:1`, all three
findings, grouping, excerpts, blank lines and summary. Expected forms are
complete-source variants. Each block explicitly carries its logical role path
and empty metadata collection list. No metadata is discovered at runtime.

```text
c111ade95a01b6d35e369e574a696c460074840676bc7b984d0efbab536b98d2  testdata/roles/web/tasks/main.yml
e891bdca76e06d6b0f769c9f2a309e821959c23f06cae345f2deed2f5942e9c1  testdata/roles/web/defaults/main.yml
```

From this module directory, reproduce complete-source evidence:

```sh
go run ./cmd/token-evidence testdata/roles/web/tasks/main.yml one-dark-pro combined
go run ./cmd/token-evidence testdata/roles/web/tasks/main.yml one-light combined
go run ./cmd/token-evidence highlight/testdata/compatibility.yaml one-dark-pro lexical
make check
go test -race ./...
```

The default evidence mode remains `lexical`. Explicit `combined` emits
`sourcePath`, `semanticEnabled`, `semanticTokens` (half-open original byte
ranges), `lexical`, and `combined`. The public
`Highlighter.HighlightDocument(ctx, source, theme, DocumentOptions)` takes
`SourcePath` and explicit metadata `Collections`; `Highlight` remains raw
TextMate. The catalog is loaded once per highlighter. Consumers clip excerpts
only after complete-document composition.

The frozen catalog models one installed editor environment. Adjacent collection
discovery and arbitrary user semantic settings are outside this demo. Malformed
YAML returns an explicit parse error instead of upstream's recovered prefix
spans; the provider intentionally visits only the first YAML document. Eleven
catalog option-schema cases have documented JS-parser differences or an upstream
exception. See [SEMANTIC-HIGHLIGHTING.md](SEMANTIC-HIGHLIGHTING.md),
[catalog/README.md](catalog/README.md), and
[semantics/testdata/README.md](semantics/testdata/README.md) for measured coverage
and intentional limits. Terminal rendering cannot reproduce editor font families,
sizes or line heights.

`make check` checks all local and imported Go formatting without rewriting,
module tidiness, vet, module tests and the Nuri grammar regression. Asset and
dependency provenance live in [highlight/ASSETS.md](highlight/ASSETS.md) and
`third_party/nuri`; independent semantic theme fixtures are documented in
[highlight/testdata/README.md](highlight/testdata/README.md).
