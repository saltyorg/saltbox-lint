# VS Code extension implementation record

Local implementation and qualification are recorded below. Large-file editor
latency misses the 500 ms target; other native platforms, remote hosts, publication
and final independent integration review remain pending.

Plan: [portable extension implementation](superpowers/plans/2026-09-12-vscode-extension.md).
Baseline: `ef533311fc48a5001d497d99e462f0968bbceb16`.

## Reviewed stages

- Portable CLI: `9095823`, corrected by `2d66fd7`. Independent review clean.
  Linux quality gate and six CGO-free cross-builds passed. Darwin/Windows native
  execution remains a qualification gate.
- Canonical formatter: prerequisite `6b95b0f`, implementation `f5f69e8`, corrections
  `3d7660b`. Independent review clean. Full quality gate passed. Consumer-loader
  and Linux editor qualification are recorded in the final results below.
- Read-only edit endpoint: `499f076`. Functional/code-quality review approved;
  `make build` passed. Two process/coverage dispositions below are explicit
  exceptions to the strict task brief, not a claim of perfect compliance.

## Process deviation and coverage disposition

Task 3 authored tests first but did not observe a behavioral failure before
writing production implementation. A later command-registration-removal mutation
proved the tests detect a missing endpoint; it does not establish initial TDD.
The implementer confirmed the sequence, and the user was informed. Existing
functional validation and independent review stand separately. Remaining workers
must record and report their failing-test checkpoint before production edits.

The public endpoint test exercises the real combined fix families, which cannot
naturally produce conflicting proposals. Conflict rejection is covered by
`TestPlanFixesRejectsConflictsAndSemanticEdits` and
`TestPlanFixesEquivalentProposalsKeepSourceOwnership`; the endpoint delegates
directly to that planner. The editor adapter must additionally reject conflicting
wire edits. No production injection seam is added solely to manufacture an
otherwise unreachable endpoint conflict.

## Controller decisions

- Continue sequential work in the existing primary checkout, preserving the
  established integration workflow. A different checkout preference would require
  reversible local commit relocation.
- Retain ignored per-task evidence across interruptions. The cost is local disk
  usage; no other plan's evidence is removed.
- Darwin stdin has one active reader during a command; caller descriptor state
  and subsequent reuse remain protected. Competing external reads would require
  a stronger transport boundary.
- The Darwin PTY test uses the existing libSystem-backed ioctl wrapper with a
  pinned, ABI-sized output buffer. This avoids a new test-only FFI dependency;
  native qualification still must verify the helper.
- Repair exact overlapping whitespace in YAML token origins needed for valid
  tagged block mappings. Direct/public regressions and frozen-corpus output parity
  protect against coordinate regressions.
- Skip a final flow collection when its trailing blank gap cannot survive closing
  delimiter removal while retaining final-newline state. Do not relocate gaps or
  synthesize trailing spaces. That narrow case needs a manual newline/gap adjustment
  or a future explicit policy change.
- Retain the independently reviewed CLI implementation with the disclosed TDD
  deviation. Replaying code cannot change its actual history; the cost is the
  missing pre-implementation failing-test feedback for that stage.
- Accept conflict testing at the planner and editor wire boundaries, plus the
  public endpoint's real verified union. The cost is no synthetic conflicting-rule
  endpoint fixture; source-level delegation and shared error handling are reviewed.

## Evidence and remaining work

Ignored artifacts are under `.superpowers/sdd/2026-09-12-vscode-extension/`:
task briefs/reports/reviews, baseline binary/source, frozen consumer snapshots,
hash manifests, output comparisons and qualification-environment notes.

Eight frozen Saltbox/Sandbox JSON, dark/light human and diff outputs match the
baseline byte-for-byte after portability and source-index changes. Development
formatter scaling observations are not formal performance qualification.

The subsequent editor, packaging, source and local qualification stages are
recorded below. Final integration review and external gates remain open. Nothing
has been pushed or published.


## Final local code and semantic qualification

Final code/harness commit: `39d9740286b1660c0be3a7b664e6dae09a535270`.
Runtime correction `124fbbf` preserves diagnostics owned by an unaffected nested
workspace when an overlapping parent scan is invalidated. A real-host component
regression failed before the change; the same test passed afterward. Separate
actual installed-product parent-save tests pass at both supported Linux SDKs.
The earlier component RED/GREEN used production code bundled in the test controller;
it was not an export from the then-installed older product.

`make build` and `make snapshot` passed from clean final code. The source and
packages identify this commit; this later documentation record does not relabel
the previous Task 5 `a14fa9b` artifacts or imply those contained the final fixes.

The exact packaged CLI qualified all **878 frozen consumer YAML files**:
**161 ready, 714 unchanged, three skipped, zero semantic failures**. All 875
non-skipped results were idempotent and equal through actual AnsibleLoader types,
ordered values and non-location tags. The formatter also checks both Go YAML
parsers, comments and protected scalar syntax. Controlled fixtures preserve
anchors/aliases/merges, unsafe tags, scalar types, literals and Jinja tokens;
six controlled renders match. Consumer expressions, lookups and roles were never
executed. Python 3.12.14, Ansible-core 2.21.2, Jinja 3.1.6 and PyYAML 6.0.3 were pinned.

The skipped inputs remain explicit unsupported coverage: Saltbox's
`.github/workflows/saltbox-os.yml` and `.github/workflows/saltbox.yml` contain
unsupported workflow/Jinja layout; `roles/nzbget/defaults/main.yml` contains
multiline scalars inside flow collections. No consumer or scratch file was edited.

## Frozen CLI performance evidence

A is the original `ef533311fc48a5001d497d99e462f0968bbceb16` binary; B is the
actual extracted `39d9740` VSIX binary. Before measurement, the declaration fixed
binary/source/corpus hashes, tools, host, environment, destinations and ten
alternating AB/BA pairs per workload. Dark/light full human output used real
160×48 PTYs and truecolor; JSON/stdin used pipes. Default runtime concurrency was
preserved. Every stdout/stderr/exit comparison matched: **80/80 exact pairs**.
All samples, including outliers and first requests, remain retained.

Medians below are descriptive, not equivalence or universal speed claims.
The paired ratio is a median of pair ratios, so it need not match the ratio of
independent medians. CPU is user plus system; RSS is the original child-launch
measurement (see its floor and separate correction below).

| Workload | Wall s A → B | First output s A → B | CPU s A → B | Peak RSS MiB A → B | Median paired wall change |
| --- | ---: | ---: | ---: | ---: | ---: |
| saltbox-dark | 3.783 → 3.826 | 0.273 → 0.275 | 15.166 → 15.435 | 361.8 → 360.4 | +1.9% |
| saltbox-light | 3.457 → 3.360 | 0.271 → 0.268 | 14.908 → 14.334 | 359.0 → 354.9 | +1.0% |
| saltbox-json | 0.289 → 0.284 | 0.286 → 0.281 | 0.700 → 0.699 | 59.2 → 59.2 | -1.2% |
| saltbox-stdin | 0.027 → 0.028 | 0.026 → 0.027 | 0.041 → 0.043 | 59.2 → 59.2 | +6.1% |
| sandbox-dark | 1.196 → 1.200 | 0.291 → 0.298 | 4.183 → 4.188 | 241.2 → 282.0 | +0.6% |
| sandbox-light | 1.190 → 1.179 | 0.300 → 0.289 | 4.145 → 4.139 | 230.0 → 244.9 | -0.3% |
| sandbox-json | 0.306 → 0.308 | 0.304 → 0.306 | 0.694 → 0.696 | 59.2 → 59.2 | -0.6% |
| sandbox-stdin | 0.018 → 0.019 | 0.018 → 0.018 | 0.024 → 0.024 | 59.2 → 59.2 | -0.4% |

The positive differences are not hidden. Saltbox stdin's paired wall deltas span
−2.32 to +5.99 ms (seven slower, three faster); mean +1.43 ms, sample SD 2.88 ms.
Saltbox dark deltas span −217.43 to +217.71 ms (seven slower, three faster);
mean +41.86 ms, SD 121.62 ms. Ten pairs on this shared host do not establish
performance equivalence or rule out smaller regressions. Exploratory significance
checks are not an acceptance proof; there was no outcome-selected rerun.

The Sandbox full-human RSS median increases are **+40.8 MiB dark and +14.9 MiB
light**. Dark paired differences span −21.1 to +56.6 MiB, seven positive/three
negative; light spans −64.4 to +56.2 MiB, nine positive/one negative. The paired median RSS changes differ from differences of medians:
Saltbox dark −1.06 MiB (3 positive/7 negative), Saltbox light −2.14 MiB (4/6),
Sandbox dark +5.27 MiB (7/3), Sandbox light +25.24 MiB (9/1). The same
upper range does not prove no regression. Four separate trace-only diagnostic
runs showed 78–79 GC cycles and maximum post-GC live heaps of 188–189 MB baseline
versus 183–188 MB candidate. Renderer/highlighter code and targeted allocation
counts are unchanged, but these probes do not establish default-RSS equivalence
or fully attribute its observed shift. This memory result remains a qualification
limitation for review; no speculative GC tuning was applied.

The original `wait4` RSS includes the pre-exec launch image. Its 59.2 MiB floor
obscured small-command CLI peaks. A separately declared **RSS-only** supplement
used a fresh ~11 MiB supervisor, preserving the original latency series. Every
one of 180 child peaks exceeded that sample's recorded supervisor high-water
mark; all 40 baseline/candidate output/exit pairs matched. Corrected medians:

| Workload | Baseline MiB | Candidate MiB |
| --- | ---: | ---: |
| Saltbox JSON | 54.63 | 54.69 |
| Saltbox stdin | 23.02 | 22.98 |
| Sandbox JSON | 46.74 | 46.71 |
| Sandbox stdin | 21.23 | 21.21 |

Targeted ten-pair allocation results are unchanged: shared analysis 15,108
allocations/op, shared fix planning 5,864, fix records 13. Median times changed
1.035→1.054 ms, 415→425 μs and 8.35→8.41 μs respectively; raw spread is retained.
These microbenchmarks do not replace full command measurements.

## New formatter and real editor latency

Each declared fixture is at most 100 KiB; the large fixtures contain 3,000 edits.
CLI and each installed SDK have 20 samples per fixture, including the first.
Skipped inputs are separate from successful formatting.

| Fixture | Bytes | CLI status | CLI p95 ms | SDK 1.100 p95 ms | SDK 1.137 p95 ms |
| --- | ---: | --- | ---: | ---: | ---: |
| diagnostic-heavy | 76,890 | ready | 402.06 | 1463.12 | 1449.82 |
| flow-heavy | 55,890 | ready | 228.55 | 1265.84 | 1268.54 |
| Unicode | 33 | ready | 13.80 | 21.25 | 20.40 |
| canonical | 23 | unchanged | 16.26 | 19.96 | 22.58 |
| trailing flow gap | 13 | skipped | 15.63 | 20.75 | 20.91 |

**The 500 ms end-to-end target is not achieved for the two large fixtures.**
This is a tail-latency limitation, not only a first-request claim. First editor
requests are also retained: diagnostic-heavy 1566/1516 ms, flow-heavy 1251/1269 ms,
Unicode 872/957 ms (minimum/current SDK). The CLI target was met in this fixture
set; that does not imply the editor target passed.

Bounded phase measurements separated CLI, protocol/coordinate mapping, production
adapter, actual installed provider and application request. Heavy CLI/adapter
phases were 231–396 ms and protocol mapping 6–8 ms; SDK/provider and application
sometimes each added roughly one second. Actual SDK traces show queued edit
normalization; local SDK source has a one-second fallback. A test-only bounded
edit-grouping experiment did not remove that delay and was not adopted. No
whole-file edits, hidden warmups, dropped cold samples or proposed APIs were used.

The controller explicitly retained 500 ms as the end-to-end target, with this
miss disclosed, and retained the blocking rule for confirmed existing-command
regressions. The observations above are not a declaration of performance
equivalence or an unconditional release-performance gate pass.

Both final installed SDKs passed 100 repeated formatting requests and 20 idle
checkpoints, with no installed CLI process retained after completion or tab close.
Extension-host heap first-checkpoint→final was 34.4→24.7 MiB (minimum) and
57.5→24.2 MiB (current); observed host RSS ranges were 153–170 and 194–247 MiB.
These samples include SDK/other host activity and do not prove absence of every
possible leak or attribute all memory to the extension. They exercise repeated
requests against one document, followed by closing tabs.

## Artifacts, native scope and remaining gates

All eight VSIXs and six CLI archives were regenerated from clean `39d9740`.
Independent checks verified 752 source inputs, 17 published-file checksums,
package shape, platform metadata, binary hashes, matching source and GPL bytes.
An offline vendored Go source rebuild passed real native CLI/WASM/format probes;
an offline npm source rebuild reproduced the packaged runtime JavaScript bytes.
Go executable bit-for-bit reproduction is not claimed because the source rebuild
omits VCS metadata. WASM source/build inputs are included; its bit-for-bit
reproduction remains unqualified.

Source archive SHA-256:
`19be91c77879319e5c5a08d70186570aa021f80753598daa6ae2bea05919ea7e`.
Runtime JavaScript SHA-256:
`3133ceb1ebc3e99f425541c65724ddcdf973e43c778255b816714cd6bd4876c6`.

| VSIX target | SHA-256 |
| --- | --- |
| linux-x64 | `4066150c2206749e8cf8b717201af93db50bfb5576a5d85821841aace7f5dec6` |
| linux-arm64 | `b0bcf9707419c11b8555b652d4e4d81d6ceace91cc5594e988dcfe502aca43f7` |
| alpine-x64 | `1f895ec58a0d31893fca7138a19631f57e1b1d0c14aa3cf3397b609c0b7785cd` |
| alpine-arm64 | `36c34756f61eda236209da090b072b69f4f2cbcbc1fbe832b55daf947acb9efd` |
| darwin-x64 | `3b26abaa1022a02e289073e2521c742f5d1933d067f0c83dc671d44b8fdadf2f` |
| darwin-arm64 | `05d291ab126e5fa830201a4b8208b62ced96853eb6f13cd12c644ea7bcb2fe2d` |
| win32-x64 | `33a49a27d6b721ee800677320a42e8b2d36aa3726bf289c9088b75269424e0e0` |
| win32-arm64 | `836c8e67ae0f7d5bbe8eeb6efe6237e3902c9baaed9c2a4b1063e6c71b4edc7a` |

Native Linux x64 and Alpine x64 passed actual package probes. Linux SDK 1.100.0
and 1.137.0 each passed normal, eight regression cases, untrusted and disabled
modes with actual CLI installation/listing/uninstallation and installed-product
identity assertions. Cross-building other targets is not native acceptance.

Earlier Task 5 failures remain part of the record: initial I1 code-action
readiness failed, and a separate SDK launch crashed before product activation.
The bounded initial-readiness helper is test-only. Post-mutation assertions were
not weakened. Final local passes do not erase those original failures or claim
to fix Electron startup behavior.

Still pending: independent final integration/performance disposition; native
Windows/macOS/ARM and Windows Job behavior; ARM musl; actual Remote SSH/WSL/Dev
Container placement; manual previous-version upgrade, disable/re-enable and
remote uninstall; stable tagged rebuild/qualification; publisher namespace,
account and agreements; current policy/rights/support checks; public matching
source availability; GitHub release and Marketplace upload/acceptance. Local
snapshots are not eligible for publication. No push, tag, release or remote
workflow mutation occurred.

Reproducible harnesses are in `tools/qualification` and `extension/test/host`.
Ignored raw evidence lives under `.superpowers/sdd/2026-09-12-vscode-extension/`,
including task-6-report.md, declarations, all raw samples, retained development
failures/prototypes, per-file semantic records, SDK logs and artifact manifests.
