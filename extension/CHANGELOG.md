# Changelog

## 0.2.4 (2026-10-19)

- Add `exclude_paths` to `.saltbox-lint` for source-root-relative files and folders.
- Apply configuration and Git exclusions to directory scans, tracked files,
  explicit CLI targets and editor buffers, including fixes and formatting.
- Omit excluded declarations from cross-file context and explain excluded
  sources without parsing them. Refresh checks when saved policy changes.
- Accept an empty successful workspace report when all sources are excluded.

## 0.2.3 (2026-10-18)

Versions 0.2.1 and 0.2.2 were not published after release qualification failed.

- Preserve formatting when a delayed deletion notification refers to an already
  verified, unchanged root marker. Keep revocation for actual marker removal,
  replacement and rewrites.
- Join native groups separately from lifetime sockets in guardian crash tests.
  Retain the group-disappearance assertions and existing deadlines.
- Wait for the current root owner and marker probe before reporting readiness,
  including probes that replace pending work. Preserve edited-model rejection.
- Terminate the owned child before sweeping its descendants after native exit.
  Preserve denied signals and require the existing group-closure proof.
- Stop roles without defaults declarations from claiming variable namespaces.
  Continue checking duplicate declarations across defaults, vars and inventories.
- Add directional `namespace_sharing` permissions in `.saltbox-lint`, preserving
  empty marker files and refreshing checks when saved configuration changes.
- Add `# saltbox-lint ignore RULE_ID` for individual YAML findings. Keep other
  rules active and decline automatic edits that would rewrite an ignored line.

## 0.2.0 (2026-10-17)

- Add optional checks while typing with `saltboxLint.checkOnType`, disabled by default.
- Add definition, hover, completion, references and static impact inspection for
  supported `role_var` and `role_web` lookups.
- Add offline rule help, expected-format examples and source freshness status in
  the editor, plus CLI registry JSON and source explanations.
- Add changed-file checks with `--changed-since`, static reference inspection,
  check statistics and validated role scaffolding with preview before creation.
- Add SARIF output for code scanning, including related source locations.
- Add bounded, read-only Jinja template checking and navigation with explicit
  partial-coverage reasons for unsupported syntax and configuration.
- Reject empty Docker port declarations and duplicate variable declarations
  across defaults, vars and inventories. Exclude tasks and user `localhost.yml`
  overrides, and accept owning-role prefixes when namespaces overlap safely.
- Forbid `role_var` lookups in Paths defaults and detect foreign role namespaces.
- Improve large YAML mapping parsing, Unicode/CRLF source positions, alias
  ownership, stale-result handling and joined process cleanup.
- Expand validation to six native source targets and installed packages at both
  configured editor versions, with Alpine CLI probes and vulnerability checks.
- Publish all eight qualified VSIX packages to Marketplace after GitHub source
  publication, using Azure workload identity federation.

## 0.1.0 (2026-09-20)

Published as [v0.1.0](https://github.com/saltyorg/saltbox-lint/releases/tag/v0.1.0)
at commit `e2716109d86c56863c6182d1659f97f379622a3b`.

- Require a `.saltbox-lint` source-root marker for editor diagnostics, fixes and formatting.
- Check Saltbox and Sandbox YAML on open/save or through document/workspace commands.
- Scan marked roots at startup, scope save/watch checks to changed files, and retain
  displayed diagnostics while editing or awaiting replacement results.
- Show cached diagnostics for the active project by default, with an option to
  show all marked projects; preserve background checks and panel focus context.
- Apply verified quick fixes, document Fix All and canonical Format Document edits
  with undo/redo and snapshot validation.
- Run a bundled native CLI beside trusted workspace files, including remote hosts.
- Provide eight platform-specific packages with matching corresponding source.

The GitHub release includes six CLI archives and eight VSIX packages. GitHub
publication does not establish Marketplace availability. Subsequent commits
require their own complete CI validation.
