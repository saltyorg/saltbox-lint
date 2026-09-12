# Independent highlighting oracles

These development tools execute pinned upstream JavaScript/TypeScript, independently
of the production Go highlighter. Normal Go tests, `make check`, builds and runtime
use frozen fixtures and assets; they do not invoke Node, download packages, or need
an editor extension or an Ansible installation.

## Reproduce frozen evidence offline

Use **Node 24.20.0** (the runner checks this exact version). No `npm install` is
needed: the complete executable dependency closure is checked in and hash-locked
by `manifest.json`. The lexical npm packages are vendored as their minimal published
files; the remaining runners use only Node built-ins. Native TypeScript stripping
emits an experimental warning; the commands below suppress that specific warning.

From the repository root, supply explicit source, asset/fixture and output paths:

```bash
node tools/oracles/lexical.mjs \
  --sources "$PWD/tools/oracles/sources" --assets "$PWD/highlight/assets" \
  --fixtures "$PWD/highlight/testdata" --out /tmp/saltbox-lexical-oracle
node --disable-warning=ExperimentalWarning tools/oracles/style.mjs \
  --sources "$PWD/tools/oracles/sources" --assets "$PWD/highlight/assets" \
  --out /tmp/saltbox-style-oracle
node tools/oracles/semantic.mjs \
  --sources "$PWD/tools/oracles/sources" --fixtures "$PWD/highlight/semantics/testdata" \
  --out /tmp/saltbox-semantic-oracle
node --test tools/oracles/oracles.test.mjs
```

The test copies the complete tool directory plus assets and fixtures to a fresh
temporary directory, runs all three copied tools from there, compares the output
with the unchanged frozen fixtures, and checks that changed upstream source bytes
are rejected before output is created. All source/dependency/input SHA256 pins
are validated before upstream code executes. No default controller-home paths or
network access are used. Outputs are never implicitly written to tracked fixtures.

| Runner | Reproduced family | Comparison |
| --- | --- | --- |
| `lexical.mjs` | `highlight/testdata/oracle-dark.json`, `oracle-light.json` (236 tokens each) | Complete JSON and byte-identical serialization |
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

The test copies the lexical dependency closure, assets and fixture to its temporary
directory. It also changes the fixture and one engine file independently and proves
that each mismatch is rejected before the requested output directory is created.

## Lexical evidence provenance

`lexical.mjs` generates the independent expectations in `oracle-dark.json` and
`oracle-light.json`. It executes the published **vscode-textmate 9.3.2** and
**vscode-oniguruma 1.7.0** engines against the original eight Ansible/Jinja
grammars, injection order, unmodified themes and `compatibility.yaml`. It reads the
injection list from the pinned Ansible extension manifest and preserves the
historical source label stored in the snapshots. The runner validates every engine,
license, grammar, theme and fixture byte before loading executable package code.

The checked-in `sources/vscode-textmate` and `sources/vscode-oniguruma` directories
are the minimal executable files from the published npm archives. Both packages
declare no runtime dependencies. Their package scripts are retained as upstream
metadata and are never run. `manifest.json` records the registry metadata URL,
archive URL, npm SHA512 integrity, independently verified archive SHA256 and every
retained file SHA256. The upstream MIT licenses and Oniguruma notices are in
`licenses/`.

| Package | Archive SHA256 |
| --- | --- |
| `vscode-textmate-9.3.2.tgz` | `f7c742b16d59600d77529b7a904af09b59dfddb0f046fc045340004ae2fc50e7` |
| `vscode-oniguruma-1.7.0.tgz` | `830c8de8fd475455d8c161ca3c1f5f3c935fad8327ee548dec38c8985097657f` |

To audit or reconstruct that closure, download and verify the archives before
extracting them:

```bash
oracle_vendor=$(mktemp -d)
curl --fail --location --silent --show-error \
  https://registry.npmjs.org/vscode-textmate/-/vscode-textmate-9.3.2.tgz \
  --output "$oracle_vendor/vscode-textmate-9.3.2.tgz"
curl --fail --location --silent --show-error \
  https://registry.npmjs.org/vscode-oniguruma/-/vscode-oniguruma-1.7.0.tgz \
  --output "$oracle_vendor/vscode-oniguruma-1.7.0.tgz"
(cd "$oracle_vendor" && printf '%s  %s\n' \
  f7c742b16d59600d77529b7a904af09b59dfddb0f046fc045340004ae2fc50e7 vscode-textmate-9.3.2.tgz \
  830c8de8fd475455d8c161ca3c1f5f3c935fad8327ee548dec38c8985097657f vscode-oniguruma-1.7.0.tgz \
  | sha256sum --check --strict)
mkdir "$oracle_vendor/textmate" "$oracle_vendor/oniguruma"
tar -xzf "$oracle_vendor/vscode-textmate-9.3.2.tgz" -C "$oracle_vendor/textmate"
tar -xzf "$oracle_vendor/vscode-oniguruma-1.7.0.tgz" -C "$oracle_vendor/oniguruma"
```

Retain only these archive paths:

```text
vscode-textmate: package.json, release/main.js, LICENSE.md
vscode-oniguruma: package.json, release/main.js, release/onig.wasm,
                  LICENSE.txt, NOTICES.txt
```

Verify the retained bytes against each package's `files` map and the lexical
`licenses` map in `manifest.json`; no `npm install`, lifecycle script or package
manager is involved. The normal runner is fully offline and never downloads these
archives.

`tokens-dark.json` and `tokens-light.json` are Nuri captures. They are compatibility
evidence from the archived Go implementation, never independent expectations. From
the repository root, reproduce them without running any archived Make target:

```bash
go -C examples/markdown-demo-v4 run ./cmd/token-evidence \
  highlight/testdata/compatibility.yaml one-dark-pro lexical > /tmp/tokens-dark.json
go -C examples/markdown-demo-v4 run ./cmd/token-evidence \
  highlight/testdata/compatibility.yaml one-light lexical > /tmp/tokens-light.json
cmp /tmp/tokens-dark.json highlight/testdata/tokens-dark.json
cmp /tmp/tokens-light.json highlight/testdata/tokens-light.json
```

The archived module owns its own copies of the input and assets. Those copies are
byte-identical to the root fixtures used by current Go compatibility tests.

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
