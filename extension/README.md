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
- **Saltbox Lint: Check Workspace** checks each marked source root on disk.
  Clean open documents are rechecked too; dirty buffers retain their displayed
  findings until saved or explicitly checked, including opened ignored files.
- **Saltbox Lint: Fix All in Document** requests verified conservative lint fixes.

Each marked root also receives one saved-workspace scan on startup or first
enablement. Saving or changing a YAML file rechecks that file and any selected
primaries whose analysis depends on it. Changes to owning-role defaults, tasks,
handlers, vars and templates, and shared Docker resources, refresh affected
findings. Template directories are observed regardless of file extension;
templates are read only. Creation, deletion, rename and atomic replacement also
refresh dependencies, including previously clean results and missing templates.
Unrelated roles and source roots retain their findings and actions. Watcher echoes
are coalesced. In-root Git ignore controls trigger a fresh membership scan;
Git tracking metadata, global excludes or Git configuration outside the source root
require Check
Workspace. Closed files use bounded
selected-path batches without opening editor tabs. There is no separate Git-pull
trigger or Git polling. Dirty dependent buffers retain their displayed findings
and lose stale actions until saved or explicitly checked. The Output channel
identifies stale context and reports startup/background failures.

Saved files with invalid UTF-8 retain their raw-byte analysis dependencies and
saved-scan coverage, but editor diagnostics are skipped because byte offsets cannot
be mapped safely to editor text. The Output channel identifies these files. The
CLI still reports their parse findings. Stable unsupported bytes do not trigger
retries, and a later valid UTF-8 edit restores normal diagnostics. Other selected
files continue to publish their findings.
Clean open buffers use the raw saved-file check for these unsupported bytes.
Dirty buffers continue to check their current text, including explicit unsaved edits.

By default, **Saltbox Lint: Active Project Only** (`saltboxLint.activeProjectOnly`)
shows this extension's Problems entries and squiggles for the active file's
project. Any file type selects its project, including a README. An unmarked
workspace folder hides Saltbox Lint findings. Before selecting a file, the view
shows all marked projects; focusing a panel or a non-file editor then retains
the last file's project. Turn the setting off at window/workspace level to show
all marked projects.

Switching files or this setting only republishes cached findings. Startup and
background checks still cover all marked projects, and other extensions' findings
are unaffected. VS Code controls Problems scrolling through its native
`problems.autoReveal` setting. After switching projects, the refreshed list may
not scroll to the active file immediately; switching files within that project
uses VS Code's usual auto-reveal behavior. The extension does not pin files,
change Problems sorting, move focus, or rewrite your VS Code settings.

Quick fixes say "this file" because a shared proposal may fix several findings
in the document. Fixes are checked against the current document before applying.
They use VS Code edits and preserve undo/redo. Eligible fixes include conservative
Jinja/condition rewrites, flow healthcheck lists, missing computed-default
`# Skip docs` comments and complete source-header repairs. Healthcheck scalar
values and shell allowances are retained; incomplete headers, ambiguous source
forms and defaults-section ordering require manual edits. Mixed corrections use
one verified plan shared with CLI `check --fix`, and stale actions are refused. **Format Document With… → Saltbox
Lint** requests canonical formatting from the read-only CLI endpoint. The
extension never selects a default formatter or enables format-on-save. Configure
VS Code's own formatter preferences when desired; other YAML extensions can
remain installed.

`Saltbox Lint: Root` (`saltboxLint.root`) is a folder-scoped source-root override,
absolute or relative to its workspace folder. Empty uses that folder. Each root
has independent source identities and its own marker requirement, including
nested workspace folders. Unmarked roots provide no diagnostics, quick fixes
or formatter, and check/fix commands do no work for them. Help and status remain available. Removing or renaming
the marker clears that root's diagnostics, cancels pending work and withdraws its
providers. Re-adding it starts fresh checks once the extension is loaded. Symlink
paths retain their originating editor buffer while the CLI receives canonical
disk paths. Files outside the selected
source root are rejected.

Operational errors and skipped-format reasons appear in the **Saltbox Lint**
Output channel. Manual operation failures also show a notification. There are no
runtime downloads, telemetry, Python/Ansible execution, or persistent server.

## Role lookup navigation

Navigation is available in source builds and remains unreleased. In an eligible
marked YAML or Ansible document, Go to Definition returns every applicable local
declaration candidate for a literal `role_var` or `role_web` lookup. Hover shows
escaped declaration comments and the literal source representation. These are
source declarations; the extension does not evaluate runtime values or Ansible
variable precedence. Dynamic arguments and unavailable context provide no
fabricated locations.

Invoke completion inside a recognized quoted role argument or `role_var` suffix.
The chosen item replaces only that literal's contents, preserves its quotes, and
uses the editor's normal undo history. Escaped or folded tokens with uncertain
source mappings receive no completion edit. Definitions and hover continue to
inspect safely mapped reads using the shared Go resolver.

Find All References returns statically recognized local reads and labels its
incomplete search in the status bar.
**Saltbox Lint: Show Static Role Lookup Impact** opens a read-only view of read
locations and declaration candidates, with incomplete coverage reasons. The
search observes admitted project YAML and conventional context, including the
current unsaved source snapshot. Dynamic reads, ignored directory discovery,
external providers and templates prevent a complete runtime impact claim.
Declaration contents are not written to Output or the impact view.

Each navigation operation has bounded scheduling and process cancellation.
Requests use captured UTF-8 snapshots, target hashes and canonical root ownership.
Deleted, changed or dirty dependency targets decline locations; changed source,
context, markers and closed documents revoke pending work. Fresh requests avoid
retaining stale answers. Nested configured roots keep their own source authority.
Opened templates, including extensionless files in conventional template
directories, support checking, help, definition, hover and references. Completion
edits, rename, Fix All and formatting remain unavailable. Unsupported grammar
appears as partial coverage. See [template coverage](../docs/templates.md).

## Rule help and check status

Rule help and status are source-built, unreleased additions. They are not in the
published v0.1.0 extension.

**Saltbox Lint: Explain This Rule** reads the bundled CLI registry and offers
rule explanations and expected/violation examples offline. A diagnostic quick
fix can open its specific rule. Help opens an owned read-only document with
rendered Markdown available on hover; Markdown commands and HTML are disabled.
Metadata is cached for the executable and its observed version for this extension
session. Manual help requests refresh the version observation. Diagnostic codes
link to existing anchors in the generated public reference; parse diagnostics
without a registry page retain plain codes.

The status bar and **Saltbox Lint: Show Check Status** describe the active source
as eligible, checking, current, stale, disabled, missing-marker, or failed. Current
requires a buffer result matching the observed source, root and dependency
revisions. A saved workspace scan alone does not establish a current buffer
result. Retained findings can stay visible while the status is stale. Freshness
uses snapshot-at-read verification and visible events, rather than guaranteeing
an atomic filesystem snapshot through acceptance.

For an active extension in an unmarked root, status explains the existing
`.saltbox-lint` opt-in requirement and does not create the marker. Background
check failures remain in Output; manual failures also show notifications.

## Platforms and installation

Download a VSIX and `checksums.txt` from an
[exact published GitHub release](https://github.com/saltyorg/saltbox-lint/releases).
Verify its SHA-256 digest against the exact package filename before installation.
Use `sha256sum` on Linux, `shasum -a 256` on macOS, or `Get-FileHash -Algorithm SHA256`
on Windows. Choose the machine hosting the workspace extension, which may differ
from your desktop in Remote SSH, WSL or Dev Containers. The
[generated platform table](https://github.com/saltyorg/saltbox-lint/blob/main/docs/platforms.md)
lists all eight VSIX names and their bundled CLI targets. Each carries one native
executable. Alpine reuses the CGO-free Linux binary and receives packaged musl
probes; it does not run the full installed editor host suite.

A published GitHub VSIX does not imply Marketplace availability. No web or
virtual-workspace extension is provided. For standalone CLI installation, see
the [main guide](https://github.com/saltyorg/saltbox-lint/blob/main/README.md#install).

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
Run `npm ci --ignore-scripts`, `npm run build`, `npm test`,
`npm run test:release` and `npm run format:check` in this directory.
The build runs TypeScript and pinned type-aware ESLint checks. See the
[contributor guide](https://github.com/saltyorg/saltbox-lint/blob/main/docs/contributing.md)
for live ESLint diagnostics in VS Code. `make check` includes these quality
gates; `make snapshot` builds the eight local VSIXs and corresponding source.
