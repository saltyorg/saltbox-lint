# Embedded source assets

Every imported source is embedded; runtime highlighting performs no file,
network, Node, CGO, or external process calls. Source files are tokenized in full
before consumers select excerpt lines. No precomputed token files are read by
the runtime highlighter.

- Ansible extension **26.8.2**, installed as `redhat.ansible-26.8.2`.
  All eight grammar contributions from `ansible-package.json` are imported.
  `cmd/import-assets` uses the Go `importer` package to decode plist trees and
  copy JSON trees without restricting grammar fields. Manifest `injectTo` is
  added to the registered grammar data. `ansible-sha256.json` records original
  source and converted grammar SHA256 hashes. Run `go run ./cmd/import-assets`
  from the module root to repeat this import from that exact installation.
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
all embedded asset hashes. Nuri/Oniguruma/wazero notices and base-module hashes
live in `../third_party/nuri`.

Theme normalization merges duplicate selectors by last-defined **property**,
including an explicitly empty `fontStyle`. Specific scopes and parent selectors
are retained. Nuri contrast adjustment is explicitly disabled. The adapter never
assigns colors by source words.

The external-injection bridge rejects conflicting selectors instead of silently
dropping one. It supports the pinned manifest and its selector/include forms;
it is not a claim of compatibility with arbitrary future extension grammars.
Runtime tokenization errors and degradation diagnostics are returned as errors.
The sole language entry point is the embedded Ansible grammar.
