# Saltbox Lint for VS Code

Saltbox and Sandbox YAML diagnostics, verified fixes, and document formatting.
Requires VS Code 1.100 or newer and Git for repository-aware checks. The bundled
CLI runs beside workspace files, including Remote SSH, WSL, and Dev Containers.
Untrusted and virtual workspaces are unsupported.

Open or save a workspace `.yml` / `.yaml` document in YAML or Ansible language
mode to check it. Editing clears stale findings; checking does not run on every
keystroke. Commands are available from the Command Palette:

- **Saltbox Lint: Check Document** checks the current buffer, including unsaved edits.
- **Saltbox Lint: Check Workspace (Saved Files)** checks each workspace root on disk.
  Open-buffer diagnostics remain separate, including explicitly opened ignored files.
- **Saltbox Lint: Fix All in Document** requests verified conservative lint fixes.

Quick fixes say “this file” because a shared proposal may fix several findings
in the document. Fixes are checked against the current document before applying.
They use VS Code edits and preserve undo/redo. **Format Document With… → Saltbox
Lint** requests canonical formatting from the read-only CLI endpoint. The
extension never selects a default formatter or enables format-on-save. Configure
VS Code's own formatter preferences when desired; other YAML extensions can
remain installed.

`Saltbox Lint: Root` (`saltboxLint.root`) is a folder-scoped source-root override,
absolute or relative to its workspace folder. Empty uses that folder. Each root
has independent source identities. Symlink paths retain their originating editor
buffer while the CLI receives canonical disk paths. Files outside the selected
source root are rejected.

Operational errors and skipped-format reasons appear in the **Saltbox Lint**
Output channel. Manual operation failures also show a notification. There are no
runtime downloads, telemetry, Python/Ansible execution, or persistent server.

## Platforms and installation

Install the VSIX matching the machine hosting your workspace extension:
Linux x64/ARM64, Alpine x64/ARM64, macOS Intel/Apple Silicon, or Windows x64/ARM64.
Each package carries one native executable. Alpine reuses the CGO-free Linux
binary; Alpine remote-host acceptance is a release gate. A local cross-built
package is not a claim that its target has completed native qualification.
No web/virtual-workspace extension is provided. See the release's qualification
record for tested environments; initial Marketplace publication remains pending.

Use **Extensions → Install from VSIX…** for a local package. VS Code controls
install/update/disable/uninstall. No administrator installation, runtime download,
Python, Ansible or persistent daemon is required. Git must be available on the
workspace host for repository-aware discovery.

## Privacy, support and licensing

See [Privacy](PRIVACY.md), [Support and security](SUPPORT.md), and
[Changelog](CHANGELOG.md). Saltbox Lint is GPL-3.0-only; redistribution and
modification are permitted under the included [GPL license](https://github.com/saltyorg/saltbox-lint/blob/main/LICENSE), without
warranty. Third-party components retain their own notices and license texts.
Every package includes `SOURCE.json` naming and hashing its exact corresponding
source archive. That archive includes modified Nuri, its WASM wrapper and matching
Oniguruma source, vendored Go dependencies and build instructions. It must be
available at no charge alongside the matching release binaries.

## Development

See the repository's [release and native testing guide](https://github.com/saltyorg/saltbox-lint/blob/main/docs/extension-release.md).
Use Node 24.20.0, npm 11.19.0 and the Go toolchain in `go.mod`.
Run `npm ci --ignore-scripts`, `npm run build`, `npm test`, and
`npm run format:check` in this directory. `make check` includes these quality
gates; `make snapshot` builds the eight local VSIXs and corresponding source.
