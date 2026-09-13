# Automatic fix qualification — 2026-09-13

The qualified code is `1d52c2f77bfdcd33b7ec884d7f64647702d531a3`, following
independent task reviews and corrections for valid nested-expression layout and
ambiguous header-comment association. Seven additional rules offer conservative
fixes through `check --fix`, shared JSON v2 fixes, and the existing VS Code quick
fix/Fix All actions. Eligibility is documented in the [README](../README.md).

Defaults-section reordering remains manual: Ansible retains mapping iteration
order, so moving declarations cannot meet the preservation contract. Unsupported
syntax, unknown boolean operands and ambiguous source/comment boundaries retain
their diagnostics. No consumer roles were edited or executed, no runtime Python
or Ansible dependency was added, and extension scheduling was not changed.

## Semantic and write verification

- Frozen Saltbox and Sandbox inputs contain 878 YAML files. The final packaged
  Linux binary returned 133 ready plans and 745 unchanged results. Every changed
  file passed ordered Ansible-loader data/tag and Jinja syntax-tree comparisons;
  every repeated fix request was unchanged. Corpus expressions were not executed.
- The corpus exposes fixes for 292 `ansible-when-parentheses`, 54
  `ansible-when-list`, one long conditional, one redundant conditional grouping,
  and one existing section-spacing finding. The 122 remaining when-list and 21
  remaining when-parentheses findings stay manual. The other newly supported
  rules are exercised by committed fixtures and controlled qualification.
- All 11 controlled cases passed using Ansible 2.21.2 and Jinja 3.1.6, including
  66 evaluations. A separate 90-case conditional probe admitted 42 rewrites and
  preserved values/error classes across 546 evaluations with undefined, null,
  boolean, numeric, string, list and mapping inputs. These use controlled values,
  never consumer lookups or tasks.
- Real `check --fix` calls changed 82 Saltbox and 51 Sandbox files on disposable
  copies, byte-for-byte matching the read-only editor plans. A second write pass
  changed nothing. Exit 1 remained expected because manual diagnostics remain.
- Both real consumer repositories retained their initial tracked-diff hashes,
  and all frozen-manifest source files still matched the originals.

## Measured checking cost

Alternating baseline/candidate runs retained all samples: 40 for the original
full-corpus checks and 100 for the selected-file/already-fixed supplement. The
baseline is the prior `0ec7aa4` packaged binary; intervening changes before this
feature were documentation only. Diagnostic output stayed equivalent: exact
concise bytes, or JSON diagnostics after excluding the new `fix_id` references.

| Workload | Baseline median | Updated median | Added time |
|---|---:|---:|---:|
| Saltbox full corpus | 263.27 ms | 345.97 ms | 82.70 ms |
| Sandbox full corpus | 280.46 ms | 308.24 ms | 27.79 ms |
| Saltbox already-fixed copy | 268.24 ms | 310.93 ms | 42.68 ms |
| Sandbox already-fixed copy | 284.26 ms | 296.63 ms | 12.37 ms |
| Saltbox selected file, most fix findings | 26.15 ms | 30.27 ms | 4.12 ms |
| Sandbox selected file, most fix findings | 19.57 ms | 21.30 ms | 1.73 ms |
| Selected Cloudflare source | 20.36 ms | 20.68 ms | 0.32 ms |

The selected-file measurements exercise stdin JSON checks, including process
launch and output capture; they do not measure whole-editor latency. The two
highest-finding files are `roles/nvidia/tasks/main.yml` and
`roles/koel/tasks/main.yml`. The Cloudflare source is
`resources/roles/dns/tasks/cloudflare/subtasks/add_dns_record.yml`.

Fix validation adds measurable work. Full checks remain startup/manual work;
saves still check the saved file. Already-fixed copies retain 143 unsupported
condition findings and still require eligibility decisions. These observations
do not establish statistical speed equivalence, and no RSS conclusion is made.

## Build and installed packages

`make build` passed on the qualified revision, including race tests and the
extension/release gates. The existing local package command then built six native
CLI targets, eight VSIX targets and matching source without repeating unchanged
test suites. All 17 distribution checksums passed. Native Linux x64 and Alpine
x64 package probes passed.

All 16 installed-package runs exited zero: VS Code 1.100.0 and 1.137.0 each ran
normal, regressions, markers, save-scope, active-project, active-project-cache,
untrusted and disabled modes. Normal-mode tests exercise the installed product's
mixed healthcheck/documentation/expression fixes, Fix All, undo/redo, stale
rejection and grouped Cloudflare preservation. Save-scope and active-project-cache
use production components with the installed CLI; trust/disabled modes verify
non-activation. Each run used an isolated profile/container with 512 MiB shared
memory. The concise assertion record contains 126 PASS groups; raw SDK/DBus/chat
noise remains preserved separately.

Corresponding source archive SHA-256:
`1edc61fb1f7909667e9ca60b396153fedf34a650b84bca25393aabd7623a4099`.
Linux packaged binary SHA-256:
`b036fc39c5fbdf8c15ac1390232876500c8595e48a527cfe98f0970eee1a981e`.
The artifact identity precedes this documentation-only closure.

Evidence, declarations, raw samples, reviews and intermediate packages are
retained under `.superpowers/sdd/2026-09-13-safe-rule-fixes/`. In particular,
`qualification.json` binds artifact hashes and final evidence, and
`installed-assertions.json` summarizes host results without discarding raw logs.

Windows/macOS/ARM native execution and actual remote-host qualification remain
pending; cross-building is not native execution. No push, publication, tag,
release, remote workflow, user-setting or publisher mutation was performed.
