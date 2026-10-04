# Changelog

## Unreleased

- Await process-tree termination in cleanup tests before checking descendants.
- Isolate installed quick-fix tests from create-watcher rechecks.
- Centralize cached diagnostic lifecycle and rule structural-fix registration.
- Align local extension bundling and CI coverage across all release targets.
- Repair installation/adoption guides and check public links and platform docs.

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
