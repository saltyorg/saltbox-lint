# Independent highlighting oracles

These development tools execute pinned upstream JavaScript/TypeScript, independently
of the production Go highlighter. Normal Go tests, `make check`, builds and runtime
use frozen fixtures and assets; they do not invoke Node, download packages, or need
an editor extension or an Ansible installation.

## Reproduce frozen evidence offline

Use **Node 24.20.0** (the runner checks this exact version). No `npm install` is
needed: the complete executable dependency closure is checked in and hash-locked
by `manifest.json`. The only external module used by that closure is Node's
`node:module`. Native TypeScript stripping emits an experimental warning; the
commands below suppress that specific warning.

From the repository root, supply explicit source, asset/fixture and output paths:

```bash
node --disable-warning=ExperimentalWarning tools/oracles/style.mjs \
  --sources "$PWD/tools/oracles/sources" --assets "$PWD/highlight/assets" \
  --out /tmp/saltbox-style-oracle
node tools/oracles/semantic.mjs \
  --sources "$PWD/tools/oracles/sources" --fixtures "$PWD/highlight/semantics/testdata" \
  --out /tmp/saltbox-semantic-oracle
node --test tools/oracles/oracles.test.mjs
```

The test copies the complete tool directory plus assets and semantic fixtures to a
fresh temporary directory, runs both copied tools from there, compares the output
with the unchanged frozen fixtures, and checks that changed upstream source bytes
are rejected before output is created. All source/dependency/input SHA256 pins
are validated before upstream code executes. No default controller-home paths or
network access are used. Outputs are never implicitly written to tracked fixtures.

| Runner | Reproduced family | Comparison |
| --- | --- | --- |
| `style.mjs` | `highlight/testdata/upstream-semantic-style-cases.json` (8 cases) | Complete JSON |
| `style.mjs` | `highlight/testdata/semantic-fallback-colors.json` (both themes) | Complete JSON |
| `semantic.mjs` | `highlight/semantics/testdata/upstream-semantic-cases.json` (26 cases) | Complete JSON, including malformed YAML provider recovery |
| `semantic.mjs` | `demo-tasks-semantic-oracle.json`, `demo-defaults-semantic-oracle.json`, `decorated-scalar-keys-oracle.json` | Complete `tokens` arrays |

The three standalone semantic captures retain historical discovery messages,
module roots and resolutions. Portable regeneration deliberately reports its own
method and captured-input provenance; it does not claim to rediscover 8,691 modules
or reproduce the historical machine metadata. Coordinates, text, token types and
modifiers compare without normalization. The Go classifier's documented malformed
YAML policy difference is unaffected.

The preexisting lexical `oracle-dark.json` / `oracle-light.json` snapshots (VS Code
TextMate 9.3.2 + Oniguruma 1.7.0) and `tokens-dark.json` / `tokens-light.json` are
unchanged. Their generator is **not** recovered by these style/semantic tools.

## Provenance and scope

- `style.mjs` is recovered from the original local `theme-scope-oracle.mjs`.
  `sources/vscode` contains byte-identical upstream files at VS Code commit
  `88e44fa0e00b08f7758b4f6d05632e4fd5e4df6f`. Paths and hashes are in the manifest.
  The harness extracts and executes the original scope matcher, selector parser,
  scope resolver and token style methods. As in the original harness, it supplies
  minimal registry/color adapters, uses uppercase hex output and strips TypeScript.
  It reads the actual production theme bytes, whose hashes are also pinned.
- `semantic.mjs` preserves the original `full-provider-oracle.mjs` document adapter
  and UTF-16 token decoding. `sources/ansible` is the unmodified seven-file bundle
  closure from the **Red Hat Ansible extension 26.8.2** language server `dist`.
  The provider SHA256 is
  `9f0d3c8a4323ce393dc3e41bc4b2293d5fc378b486c2d38e07c5904a86845ddb`.
  `manifest.json` locks every bundled file; this is the dependency lock, so no
  package-manager lock or installation is required.
- `sources/oracle-cases.json` and `sources/semantic-style-cases.json` are unchanged
  original local generator inputs, authored before the Go implementation.
  The original `.superpowers/sdd/demo-v4-semantics` evidence remains untouched.
- `sources/module-docs.json` captures **23 requested module names**, including
  negative and short-name resolutions, by running the original initialized
  `DocsLibrary.findModule` while executing those 26 cases and the three YAML
  inputs. It stores resolved option names, dict/list/scalar structure and nested
  options, not generated semantic tokens. Non-dict/list option types are collapsed
  to `scalar`, exactly as in the original `--schemas` harness; the provider only
  distinguishes dict and list. Captured source paths and hashes, original parser
  and harness hashes, configuration hashes and discovery roots are provenance
  records, never runtime input paths. No production Go catalog supplied this data.
  This input is sufficient for these fixed fixtures, not a replacement for general
  Ansible module/collection/role resolution. Uncaptured module names fail explicitly.
  New inputs need a new independent DocsLibrary capture and reviewed pins.

The style sources are Microsoft MIT-licensed. The Ansible bundle is Red Hat's
MIT-licensed extension distribution, including Microsoft language-server code
(MIT), Lodash/Underscore notices (MIT) and YAML (ISC). The relevant notices and full
licenses are in `licenses/`. Bundled chunks retain their upstream bytes, including
existing notices. Upstream sources:

- https://github.com/microsoft/vscode/tree/88e44fa0e00b08f7758b4f6d05632e4fd5e4df6f
- https://github.com/ansible/vscode-ansible/tree/v26.8.2
- https://github.com/microsoft/vscode-languageserver-node/tree/release/server/10.0.1
- https://github.com/lodash/lodash/tree/4.17.23
- https://github.com/eemeli/yaml/tree/v2.8.3

The module input contains factual option-name/type trees from the named Ansible
and Saltbox modules; it excludes documentation prose and module implementation.
Their exact source identities are preserved in the capture.
