# Saltbox Lint for VS Code

Saltbox and Sandbox YAML diagnostics, verified fixes, and document formatting.
Requires VS Code 1.100 or newer and Git for repository-aware checks. The bundled
CLI runs beside workspace files, including Remote SSH, WSL, and Dev Containers.
Untrusted and virtual workspaces are unsupported.

Create an empty regular file named `.saltbox-lint` in each source root to opt
that root in. The source root is the workspace folder by default, or the path
selected by `saltboxLint.root`. Marker contents are ignored; a directory or
symlink with that name does not opt in. The same requirement applies on native
and remote workspace hosts. The extension never creates markers automatically.

When adding the first marker to an already open workspace, run **Developer:
Reload Window** if the extension has not activated yet. For an override outside
the workspace, run **Saltbox Lint: Check Document** or **Check Workspace** once
to activate the extension and its marker watchers; the workspace activation
search cannot see an external marker. The same command/reload fallback applies
if a marker is created immediately while root configuration and its watchers
are being set up. Manual commands refresh marker eligibility before acting.

Open or save a marked workspace `.yml` / `.yaml` document in YAML or Ansible language
mode to check it. Editing keeps the last displayed findings visible, while
outdated fixes and formatting requests are invalidated immediately. Findings
update when the saved-file check completes, or after an explicit Check Document;
a failed check reports its error and retains the last findings. Typing does not
start checks. Commands are available from the Command Palette:

- **Saltbox Lint: Check Document** checks the current buffer, including unsaved edits.
- **Saltbox Lint: Check Workspace (Saved Files)** checks each marked source root on disk.
  Clean open documents are rechecked too; dirty buffers retain their displayed
  findings until saved or explicitly checked, including opened ignored files.
- **Saltbox Lint: Fix All in Document** requests verified conservative lint fixes.

Each marked root also receives one saved-workspace scan on startup or first
enablement. Saving a file rechecks only that file, preserving other documents'
findings and actions. Watcher echoes are coalesced. File changes from a checkout,
pull or other disk operation recheck the changed files; closed files use bounded
selected-path batches without opening editor tabs. There is no separate Git-pull
trigger or Git polling. Startup and background failures go to the Output channel.

Quick fixes say “this file” because a shared proposal may fix several findings
in the document. Fixes are checked against the current document before applying.
They use VS Code edits and preserve undo/redo. **Format Document With… → Saltbox
Lint** requests canonical formatting from the read-only CLI endpoint. The
extension never selects a default formatter or enables format-on-save. Configure
VS Code's own formatter preferences when desired; other YAML extensions can
remain installed.

`Saltbox Lint: Root` (`saltboxLint.root`) is a folder-scoped source-root override,
absolute or relative to its workspace folder. Empty uses that folder. Each root
has independent source identities and its own marker requirement, including
nested workspace folders. Unmarked roots provide no diagnostics, quick fixes
or formatter, and manual commands do no work for them. Removing or renaming
the marker clears that root's diagnostics, cancels pending work and withdraws its
providers. Re-adding it starts fresh checks once the extension is loaded. Symlink
paths retain their originating editor buffer while the CLI receives canonical
disk paths. Files outside the selected
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
