# Embedded source assets

Every imported source is embedded; runtime highlighting performs no file,
network, Node, CGO, or external process calls. Semantic classification retains the complete source; lexical display scans only
the required stateful prefix and can reuse immutable document checkpoints after
validated original-byte edits. No precomputed token files are read by the runtime
highlighter.

- Ansible extension **26.8.2**, installed as `redhat.ansible-26.8.2`.
  All eight grammar contributions from `ansible-package.json` are imported.
  `tools/import-grammars` uses the Go `highlight/importer` package to decode plist trees and
  copy JSON trees without restricting grammar fields. Manifest `injectTo` is
  added to the registered grammar data. `ansible-sha256.json` records original
  source and converted grammar SHA256 hashes. From the module root, run
  `go run ./tools/import-grammars -extension /path/to/redhat.ansible-26.8.2 -out /path/to/assets`.
  The full extension manifest is hash-pinned. All grammars and an existing
  aggregate manifest are parsed before output changes; both hash manifests are
  updated consistently and unrelated assets are preserved. The output directory
  may be new or a copy of these assets. Source-validation failures leave prior
  output untouched; an output I/O failure can leave a partial publication, which
  can be repaired by rerunning the command.
- **One Dark Pro 3.20.2**, exact installed
  `zhuangtongfa.material-theme-3.20.2/themes/OneDark-Pro.json`, MIT.
- **Atom One Light 2.3.0**, authentic `akamud/vscode-theme-onelight`
  `themes/OneLight.json` at commit
  `5866e900db932d580e978a58db42f65cde07998b`, MIT. The pinned raw upstream URL
  is in `assets/one-light-source.txt`; `one-light-package.json` preserves the
  publisher and version. This is the actual light theme, not a recolored dark
  theme.
- The Ansible grammar's upstream YAML source is `textmate/yaml.tmbundle`
  commit `e54ceae3b719506dba7e481a77cea4a8b576ae46`; its README contains the
  permissive license, copied to `assets/licenses/yaml-tmbundle-README.mdown`.
- The Jinja grammar is derived from `samuelcolvin/jinjahtml-vscode` commit
  `b8fe444cbd838afb4962bb2446e67c85e0443675`, with its license copied locally.

`assets/licenses` contains the source licenses. `assets/SHA256SUMS.json` records
all embedded asset hashes. `go test ./highlight -run TestEmbeddedAssetIntegrity`
checks every asset offline, reporting changed, missing or unlisted asset paths.
Independent style and semantic reproduction instructions and source pins live in
[`tools/oracles`](../tools/oracles/README.md); those explicit development tools
require Node, while normal Go gates remain Node-free.
Nuri/Oniguruma/wazero notices and base-module hashes
live in `../third_party/nuri`.

Theme normalization merges duplicate selectors by last-defined **property**,
including an explicitly empty `fontStyle`. Specific scopes and parent selectors
are retained. Nuri contrast adjustment is explicitly disabled. The adapter never
assigns colors by source words.

Complete-document evidence honors each imported theme's configured
`semanticHighlighting` value. Human display enables the shared Ansible semantic
categories for both supported themes; when One Light has no semantic override,
its authentic TextMate rules supply the class, method, keyword, and property
fallback styles. This renderer policy does not alter imported theme bytes or
their recorded hashes.

The external-injection bridge rejects conflicting selectors instead of silently
dropping one. It supports the pinned manifest and its selector/include forms;
it is not a claim of compatibility with arbitrary future extension grammars.
Runtime tokenization errors and degradation diagnostics are returned as errors.
The sole language entry point is the embedded Ansible grammar.
