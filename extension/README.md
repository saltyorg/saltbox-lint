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

## Development

Use Node 24.20.0 and the repository's Go toolchain. Dependencies are exact pins in
`package-lock.json`; there are no runtime Node dependencies.

```sh
cd extension
npm ci
npm run build
npm test
npm run format:check
npm run stage:binary
npm run stage:test-fixture
VSCODE_EXECUTABLE_PATH=/path/to/code npm run test:host
```

`build` type-checks and bundles the extension and real-host tests with esbuild,
leaving `vscode` external. `stage:binary` builds the native CLI into ignored
`bin/saltbox-lint[.exe]`; `stage:test-fixture` builds a test-only operational-failure
executable that must never ship. `test:host` creates isolated local Git fixtures
and launches the development extension with `@vscode/test-electron`. Providing
`VSCODE_EXECUTABLE_PATH` uses an existing SDK; otherwise the test tool downloads
the pinned 1.137.0 SDK (or the explicitly supplied `VSCODE_VERSION`). SDK downloads
are development-only. Linux GUI tests require Xvfb and Electron dependencies.

For restricted-workspace acceptance, set `SALTBOX_TEST_UNTRUSTED=1` and provide
`VSCODE_EXECUTABLE_PATH`. This case launches the SDK directly because test-electron
unconditionally disables workspace trust. Test settings are written only to a
fresh temporary test profile.

The host suite uses the bundled native CLI for diagnostics, quick fixes, Fix All,
Unicode/CRLF formatting, undo/redo, multi-root, ignored files and document
lifecycle. A separate test executable covers malformed responses and formatting
cancellation. Pure tests cover wire validation, coordinate indexing, queue
ownership, bounds and actual subprocess tree cleanup on POSIX. Windows job tests
live in the repository root and require native Windows execution.

VSIX staging, binary/SDK platform matrices, license inventory and packaged-VSIX
acceptance are separate release tooling. This development harness does not install
or test a packaged VSIX.

Run the lifecycle regression host separately with
`SALTBOX_TEST_REGRESSIONS=1 VSCODE_EXECUTABLE_PATH=/path/to/code npm run test:host`
(on Windows, set those environment variables in PowerShell before invoking npm).
This suite exercises document/root isolation, pending operations, multiple tabs,
retained closed models, dirty symlink workspaces, root removal, and retained
quick-fix commands across report replacement. CI acceptance should run both host
modes at the minimum and current supported SDK versions. Initial regression
fixtures are created before the editor launches; the tested edits, saves, tab
changes, workspace changes and root configuration changes happen in the host.
