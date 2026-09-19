# Audit findings remediation results

The four findings from the 2026-09-19 audit are resolved. Product qualification
covers `629814b652e57371b26b388f36a2b0a950bdf32c`; this results document is a
subsequent documentation-only addition. The approved implementation plan is
[here](superpowers/plans/2026-09-19-audit-findings.md).

## Changes

| Finding | Result | Commits |
| --- | --- | --- |
| Dropped editor checks | Lint retains coalesced lightweight requests, builds snapshots only during execution, and rejects obsolete versions/owners. Formatter queue bounds remain unchanged. | `a15b608` |
| Web-contract false positives | Detection requires scalar string composition and preserves independent mapping, sequence, collection, conditional and tuple boundaries. Exact dot separators and ordinary grouped concatenation are covered. No automatic semantic fix was introduced. | `013fc03`, `9c5dfb7`, `629814b` |
| Missed uppercase YAML events | Watchers cover every case variant of `.yml` and `.yaml`, preserving selected-file refresh and unrelated diagnostics. | `514889b` |
| Invalid Git patch paths | Byte-oriented quoting emits Git-compatible octal escapes; real Git application tests preserve exact filenames and contents. | `6bedd99` |

Each task received a fresh implementer and independent specification/code-quality
review. The final integration review found an additional tuple boundary case and
a documentation-table gap; both were corrected, regression-tested where
applicable, and independently re-reviewed. No product findings remain open.

## Validation

`make check` passed on the qualified product revision, including extension
checks/tests, release tests, formatting, Go module/vet/lint checks, race suites,
Bash/workflow checks and GoReleaser configuration validation.

Tests failed before each behavioral correction and passed afterward. Queue unit
tests retain all 40/100 requests with maximum concurrency one. Editor tests cover
40 open documents at activation/root refresh, positive lazy-snapshot execution,
and cancellation after edits, version drift, closure, root removal and disposal.
Real external filesystem events cover uppercase/mixed-case YAML creation,
changes, rename and deletion. Rule fixtures preserve both valid independent
values and invalid genuine composition. Git application tests cover ordinary
names, spaces, NBSP, Unicode/non-BMP, quotes, backslashes and supported controls,
plus CRLF, empty contents and missing final newlines. Filename cases invalid on
Windows remain covered by portable encoder tests.

Eight isolated Linux x64 host runs passed using the newly built local VSIX and
its CLI. Normal/regression modes exercise the installed extension; queue and
save-scope modes exercise production components with the installed CLI and the
existing recording fixture.

| VS Code | Normal | Regressions | Queue | Save scope |
| --- | ---: | ---: | ---: | ---: |
| 1.100.0 | 16 | 10 | 8 | 12 |
| 1.137.0 | 16 | 10 | 8 | 12 |

Numbers are passing assertion groups: 92 in total, with every run exiting zero.
Tests used isolated containers/profiles and 512 MiB shared memory. Raw logs retain
SDK/container unsupported-option, DBus, Git-extension and deprecation noise; that
output is not represented as pristine. Earlier development failures are retained
separately, including an Electron launch SIGSEGV, a display-startup problem, and
an initially invalid test observer that was replaced and proven with a positive
control. Those attempts are not passing evidence.

## Consumer and package evidence

Read-only corpus validation passed without changing consumer files:

| Corpus | Selected files | Findings | Source manifest SHA-256 |
| --- | ---: | ---: | --- |
| Saltbox | 431 | 0 | `05b6fb04c72967e0a128c7aeeac1de5cc190769e36443c33be20ddd1aba618b7` |
| Sandbox | 414 | 105 | `2f73e604e56753294bd6d00c2077690d3041830e6401c391552069909df89275` |

All selected-file and sampled stdin equivalence checks passed. Both complete JSON
reports from the packaged CLI are byte-identical to the pre-change baseline.
Saltbox's existing local edits were retained. `examples.yaml` was not modified.

Local snapshot packaging produced six native CLI archives, eight platform VSIXs,
and matching source; all 17 checksum entries passed. Cross-building is not native
execution: runtime qualification here is Linux x64 only, not macOS, Windows, ARM,
musl, or a remote editor host.

- Source archive SHA-256: `8eb6f1bc5a84d57e6fd564060ed9beec77adeb8b5575d7e4107645a1e236eb43`.
- Linux x64 VSIX SHA-256: `f556e37217f658a319c84915a6e6c9da7f745bd7e1fbd295d6e8d905eee3daf6`.

Task/review reports, RED/GREEN evidence, raw host logs, comparison JSON and
`qualification.json` are retained locally under the ignored directory
`bin/audit-evidence/2026-09-19-four-findings/`. No pushes, tags, releases,
publication, remote workflows, or consumer-repository changes were performed.
