# VS Code extension implementation record

Independent final review approved local code quality and integration.
The user clarified on 2026-09-13 that increased memory usage alone is not a
regression unless speed is materially affected; no memory leak was established.
The historical RSS-only blocking disposition below is superseded by that
criterion. Measurements remain unchanged, and this clarification does not claim
statistical speed equivalence. Large-file editor latency still misses the
separately dispositioned 500 ms target. Other native platforms, remote hosts and
publication remain pending.
Code approval does not grant performance acceptance or publication readiness.

Plan: [portable extension implementation](superpowers/plans/2026-09-12-vscode-extension.md).
Baseline: `ef533311fc48a5001d497d99e462f0968bbceb16`.

The latest local packages include the [active-project display update](#active-project-display-update-0ec7aa4).

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
- Use a narrow opt-in Windows editor-process Job Object seam at main entry.
  `SALTBOX_LINT_EDITOR_PROCESS=1` enables native kill-on-job-close containment;
  the seam is a no-op on Linux/macOS. Failure reports stderr and exits 2 before
  CLI/Git/input work; the OS closes successful job handles at process exit.
  The cost is that restricted or nested-job hosts fail closed and require native
  qualification or a revised supported containment mechanism.
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
recorded below. Final integration review is complete; performance acceptance and
external gates remain open. Nothing has been pushed or published. The retained
local review is `.superpowers/sdd/2026-09-12-vscode-extension/final-integration-review.md`.


## Historical 39d9740 local code and semantic qualification

The following record predates the intentional grouped-when correction. It is
historical evidence, not final-revision qualification; current results follow
at the end. Original artifacts are preserved in ignored `frozen-39d9740/`, with
a relocation manifest, without rewriting their original declarations.

Historical code/harness commit: `39d9740286b1660c0be3a7b664e6dae09a535270`.
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

## Historical 39d9740 frozen CLI performance evidence

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


### RSS review follow-up: qualification remains blocked

The existing-CLI memory acceptance gate is **blocked**. The implementation can
be reviewed locally, but the unresolved default-process RSS increases have not
received performance or publication acceptance. No specific production defect
or justified production fix has been identified.

The review requested exactly two alternating AB/BA pairs per Sandbox palette
using the original frozen binaries, environment, corpus and real PTY sink.
All eight diagnostic runs were retained and all four output/exit pairs matched.
An external observer sampled status every 20 ms and smaps_rollup every 60 ms:

| Palette / pair / binary | Kernel peak MiB | Anonymous MiB at sampled RSS peak | File-backed MiB at sampled RSS peak |
| --- | ---: | ---: | ---: |
| dark / 0 / A | 222.9 | 183.5 | 40.2 |
| dark / 0 / B | 225.2 | 178.2 | 40.4 |
| dark / 1 / B | 285.5 | 244.7 | 40.2 |
| dark / 1 / A | 256.7 | 217.0 | 40.2 |
| light / 0 / A | 262.4 | 215.6 | 40.1 |
| light / 0 / B | 261.9 | 219.4 | 40.2 |
| light / 1 / B | 232.6 | 192.3 | 40.0 |
| light / 1 / A | 214.2 | 174.8 | 40.2 |

The variable residency is predominantly anonymous, late in the process lifetime;
file-backed residency remains near 40 MiB and shared-memory residency is zero.
This is a location/category attribution, not proof of an allocation cause.
The observer consumed 45–68 ms CPU per run, including 27–46 ms reading proc data;
its startup and discrete intervals can miss short peaks, and page-table reads
can perturb the program. Kernel peak, status and smaps values are separate,
non-simultaneous observations and need not match exactly. These runs do not
replace the original formal memory or timing results.

One separately identified, matched A/B lifecycle probe then used Sandbox light,
where the original paired RSS signal was strongest. Identical instrumentation
was added only to isolated source copies, built with the same Go version, CGO
setting, trimpath, version and disabled VCS metadata. It sampled load, analysis,
renderer creation, joined workers, renderer closure and command return. One
explicit diagnostic-only collection followed closure, keeping project and
diagnostics alive to compare equivalent roots:

| Lifecycle measurement | Baseline A | Candidate B |
| --- | ---: | ---: |
| Heap allocation after renderer close, MiB | 321.73 | 293.21 |
| Total allocation through command render, MiB | 924.32 | 924.16 |
| Natural GC cycles through command render | 77 | 78 |
| Heap allocation after diagnostic collection, MiB | 12.88 | 12.92 |
| Goroutines after collection | 3 | 3 |

This instrumented pair's large closing heap is mostly transient/uncollected.
Sampled heap profiles primarily contain source/YAML data, runtime allocations,
read buffers and static initializers. Their sampled totals are not precise heap
comparisons; the table uses ReadMemStats. The probe changes GC timing, adds
logging/profiling allocations and keeps specified roots alive. It does not
explain the original default-process directional RSS shift or demonstrate
performance equivalence. No collection, tuning or instrumentation was added to
production. No further measurements were run to seek favorable values.

The original measurements remain authoritative. Final independent review and
controller/user adjudication of the open memory gate are still required; the
separately dispositioned 500 ms editor target does not waive this constraint.
The existing `39d9740` source and all eight VSIX identities remain unchanged.

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


## Historical policy-matched qualification: 2ea5ac4

This stage qualified `2ea5ac4771324b342d2257dec41c2e4b2e737c49`, including the
reviewed grouping correction `4bb7eea`. Explicitly grouped Cloudflare conditions
now remain intact. The original 39d9740 results above are retained as history;
the policy correction intentionally changes diagnostics and output volume.

For a meaningful new extension comparison, control A′ is an isolated checkout
of `ef533311fc48a5001d497d99e462f0968bbceb16` with **only** the reviewed production
changes to `lint/rules.go` and `lint/rules_when_list.go`. Its 653-file manifest,
exact patch and build identity are recorded. The original history, archive and
baseline binary were preserved. A′ has an explicitly recorded dirty marker;
it is not the untouched historical baseline. Compiler, architecture, CGO,
trimpath, version and linker flags match the final package; VCS metadata is
not silently disabled on one side.

A fresh small supervisor establishes readiness before the child clock starts,
then reports that actual child's wait4 CPU/RSS. Its startup/CPU costs are recorded
separately. Behavioral tests first reproduced the old launch-image floor, then
passed seven real-process checks, including failed-protocol partial output,
failed-attempt retention and owned-process cleanup. Unavailable measurements
remain null, never zero.

Before timing, declaration `c091d89de3f9687f82f2bb0d2c1f021f0e485f6d8a7615ef31fb698359d0cfe0`
and source/statistics addendum `8694ef7f86dc0b8cde021a01d200d17435a4a8a10622abfec24b61084e2e72e4`
bound all source/patch/binary/helper identities and descriptive statistics.
Exactly 160 attempts completed, with **80/80 exact stdout/stderr/exit pairs**,
zero measurement failures and every child peak above its supervisor high-water
mark (maximum 11,804 KiB). No attempt was dropped, retried or replaced. The
supervisor's median startup was 13.43 ms and CPU 13.48 ms, outside child timing.
This new fixed series was required by the real policy change, not by a desire
for more favorable results.

A′ is the policy-matched control and B the exact final packaged binary. Deltas
are B−A′; signs count positive/zero/negative pairs. Paired medians and ratios
need not equal differences or ratios of independent medians.

| Workload | Wall median s A′ → B | Paired wall Δ ms | Wall +/0/− | First output median s A′ → B | Paired CPU B/A |
| --- | ---: | ---: | --- | ---: | ---: |
| saltbox-dark | 3.6558 → 3.6653 | -7.00 | 4/0/6 | 0.2692 → 0.2728 | 1.004 |
| saltbox-light | 3.5013 → 3.4497 | -15.47 | 5/0/5 | 0.2830 → 0.2805 | 0.996 |
| saltbox-json | 0.2629 → 0.2647 | -0.56 | 4/0/6 | 0.2606 → 0.2621 | 1.002 |
| saltbox-stdin | 0.0227 → 0.0232 | +0.22 | 7/0/3 | 0.0220 → 0.0223 | 1.010 |
| sandbox-dark | 1.3150 → 1.3317 | -2.08 | 5/0/5 | 0.3316 → 0.3175 | 1.000 |
| sandbox-light | 1.2970 → 1.3114 | +24.82 | 8/0/2 | 0.3168 → 0.3098 | 1.012 |
| sandbox-json | 0.3155 → 0.3068 | -8.07 | 4/0/6 | 0.3132 → 0.3041 | 0.998 |
| sandbox-stdin | 0.0197 → 0.0212 | +0.20 | 7/0/3 | 0.0195 → 0.0207 | 1.029 |

| Workload | RSS median MiB A′ → B | Paired RSS Δ MiB | RSS +/0/− | Paired RSS Δ range MiB |
| --- | ---: | ---: | --- | ---: |
| saltbox-dark | 358.58 → 359.67 | +0.13 | 5/0/5 | -8.18…+16.99 |
| saltbox-light | 352.47 → 357.70 | +5.52 | 7/0/3 | -10.24…+11.26 |
| saltbox-json | 53.96 → 54.32 | +0.44 | 7/0/3 | -0.58…+2.29 |
| saltbox-stdin | 22.80 → 23.14 | +0.51 | 9/0/1 | -0.21…+0.86 |
| sandbox-dark | 250.26 → 254.07 | +5.71 | 9/0/1 | -63.40…+59.54 |
| sandbox-light | 226.85 → 226.07 | -0.90 | 5/0/5 | -48.08…+36.62 |
| sandbox-json | 50.88 → 52.69 | +0.95 | 7/0/3 | -4.03…+7.61 |
| sandbox-stdin | 21.15 → 21.30 | +0.28 | 7/0/3 | -1.06…+1.00 |

**Existing-CLI performance qualification remains open/blocked.** In particular,
Sandbox dark RSS increases +5.71 MiB in paired median with 9/1 signs; Saltbox
light RSS increases +5.52 MiB with 7/3 signs; Saltbox stdin RSS increases +0.51 MiB
with 9/1 signs. Sandbox light wall increases +24.82 ms with 8/2 signs and paired
CPU ratio 1.012. No specific code cause or justified production correction has
been identified. Output parity, overlapping ranges and small changes do not
establish performance equivalence or waive the constraint. No further adaptive
probes were run. Independent assessment retains this open acceptance gate.

The final snapshot quality gate and eight-package build passed. Both minimum
and current Linux SDKs passed all nine installed regression cases, including the
exact Cloudflare condition; its test first failed against the old 39d9740 package.
Native Linux x64/Alpine x64 package probes passed. Final corpus results remain
878 files: 161 ready, 714 unchanged, three explicitly skipped, 875 loader-equal,
zero semantic failures; controlled loader/Jinja checks passed. Unchanged large
formatter/editor timing fixtures were not rerun to seek better values: their
previous 500 ms target miss remains disclosed and separately dispositioned.

Final source archive SHA-256:
`e89894ea446074ca8044260820466314855f53db65cd83886a2e3cc4255eeafc`.
Final measured Linux binary SHA-256:
`5dd3648bef15793523d1e05c635ffbb7b9777f0935d5e7a3bafbd808452182c0`.
Control A′ binary SHA-256:
`9ba6ce2e662912e3aba58a9e859fce3a4acc3f532d4ca378d063f0c07348eb21`.
Independent integrity checks passed 756 exported source inputs, 17 published-file
checksums, all eight VSIXs and six CLI archives. An offline vendored Go rebuild
passed native probes; an offline npm rebuild reproduced runtime JavaScript
`3133ceb1ebc3e99f425541c65724ddcdf973e43c778255b816714cd6bd4876c6` byte-for-byte.

| Current VSIX target | SHA-256 |
| --- | --- |
| linux-x64 | `df56b651c35cb9a63da1e5fd595cf4a14eea795aeecaded4d3b2d762c67a84bc` |
| linux-arm64 | `ba3aefac93db64579e16c24a82a7ec3ebdb7426dc3cbf804b785ffa9fec0e869` |
| alpine-x64 | `0bab1dcfe8f493fc5074e80cbeb3a6517ce41cc9cf0fde3d5da919c02eda874e` |
| alpine-arm64 | `7f15d05d324f5dbdf7ceab675a45e997bcb119dd2a6fb852f8f630610e2b9929` |
| darwin-x64 | `d75c73af98bc9d391f5d332d65b41b6082f1cbcf00984d8b7e33edf57b3b4607` |
| darwin-arm64 | `ad700d71081b39997f81d3ff4fadab316d88ea43f10e873f580097280bd11ff2` |
| win32-x64 | `69700d6ce60f6c93286be664ce77b32aaa5914812b80393ad1ee0570841c7a3d` |
| win32-arm64 | `99409cb376c6ef0fc312a60bba47f4f7f1a691cc32ec678b676efec48200c88f` |

Raw current evidence is under ignored `task-6-final-policy/`, including source
identities, all attempts, paired-results.json, native/SDK/semantic logs and
integrity records. Local implementation review does not grant performance or
publication acceptance. Native Windows/macOS/ARM, remote placement, manual
upgrade, stable tagged qualification and publication gates remain external.

## Marker and save lifecycle update: 5099928

The marker-stage local snapshot packages identify clean code
`5099928d7a197ad52ba2f759b80771fda7b44a20`. Independent task and final integration
reviews approved the update with no unresolved findings. An empty regular `.saltbox-lint` file
opts a source root in; the root defaults to the workspace folder and honors
`saltboxLint.root`. Unmarked roots do not provide diagnostics, fixes or formatting.
Each marked root receives one startup saved-file scan. Saves recheck only the
saved file; watcher echoes are deduplicated and changed closed files are batched.
No dedicated Git pull/commit trigger or polling was added.

Last diagnostics remain visible while typing and during pending or failed
replacement checks. Source/version guards immediately revoke stale fix authority.
Manual workspace checks refresh clean open documents while preserving dirty
buffer ownership. Marker removal clears and cancels affected-root work. External
configured roots, overlapping watches and saved symlink aliases are covered.
Manual commands re-probe markers; initial watcher setup may require a manual
check or Reload Window to observe a newly created marker.

Marker-only local consumer commits are Saltbox `7a22a30c1` and Sandbox `377cb190`.
Their existing role changes were not staged or rewritten. Sandbox's offline
Ansible lint and existing CI Saltbox linter both passed. No roles were executed.

`make build` and `make snapshot` passed. All twelve minimum/current SDK runs
(1.100.0 and 1.137.0; normal, regressions, markers, save-scope, untrusted and
disabled) exited zero. Normal/marker/regression modes use the installed product;
save-scope runs the production component with production-owned watchers and the
actual installed CLI behind a recording proxy. Its eleven cases cover file-only
saves, retained diagnostics, stale results, selected batches and external roots.
Native Linux x64 and Alpine x64 package probes passed. Native Windows/macOS/ARM
and actual remote-host qualification remain pending.

Eight VSIXs and all seventeen distribution checksums were verified. Matching
source archive SHA-256:
`3b44bcfe40867eff6e3636d425cdbc471ddf87527ced0788e4403e967538a6a5`.
Previous `2ea5ac4` packages remain hash-verified in the ignored evidence archive.
Current commands, reports, reviews and hashes are retained under
`.superpowers/sdd/2026-09-13-marker-activation/`. SDK/container warnings and failed
development probes remain recorded separately from passing assertions. No
benchmark was rerun, no historical measurements were relabeled, and nothing was
pushed or published by this workflow.

## Active-project display update: 0ec7aa4

The latest local snapshots identify clean code
`0ec7aa427093007e11088c4e25d50e1ae534afe3`. The window-scoped
`saltboxLint.activeProjectOnly` setting defaults to true, as requested. Only this
extension's active-project findings and squiggles are published; false restores
all marked projects. Other extensions are unaffected. Startup without a file
context shows an overview; panels and non-file editors retain the last context.

Switching between already-open files or toggling the setting republishes cached
results without filesystem probes, CLI checks or authority-revision changes.
Background results continue updating while hidden. Related locations invalidate
in hidden caches and across saved-render races, and repaint cannot restore
obsolete closed-file findings or stale fix authority. Existing marker eligibility,
save-only checks, dirty-buffer retention and ownership behavior remain intact.

Native `problems.autoReveal` is not rewritten. An isolated VS Code 1.137 renderer
probe showed that auto-reveal can miss the first cached project-list replacement,
while subsequent within-project file switches reveal the active file. This was
an SDK-only probe, not product UI qualification. No custom sorting, pinning,
focus-stealing or private API workaround was added; the README records the limit.

Independent task and integration reviews approved the change. `make build` and
`make snapshot` passed. All sixteen installed-package host runs exited zero:
VS Code 1.100.0/1.137.0 each ran normal, regressions, markers, save-scope,
active-project, active-project-cache, untrusted and disabled modes. Active-project
tests the installed product; active-project-cache tests the production component
with the installed CLI and recording/read gates. Linux and Alpine x64 native
package probes passed; other native platforms and actual remote hosts remain
pending. Sixteen runs used isolated containers with 512 MiB shared memory.

All eight VSIX hashes and seventeen distribution checksums passed. Corresponding
source archive SHA-256:
`e42819f14885f53e405a2842720fe6e245ba62ac7f11c7d58de0fd201013cd20`.
Previous `5099928` packages were preserved with verified hashes. Current reports,
raw runs, UI observations and artifact identities are retained under
`.superpowers/sdd/2026-09-13-active-project/`. An earlier renderer exit 133 remains
unexplained; the shared-memory adjustment does not establish its cause. SDK/Git
noise and the foreign-code-action fixture correction remain recorded. No
benchmarks, consumer edits, user-setting changes or remote mutations were made.

## Automatic rule fixes — 2026-09-13

The later local packages identify code `1d52c2f` and add seven conservative rule
fixes through the existing CLI/editor authority. Full build, 878-file corpus
qualification, copy-only CLI writes, measured checking costs and all sixteen
installed-package runs are recorded in
[Automatic fix qualification](automatic-fix-results.md). That record supersedes
the preceding package identity for current local testing while preserving its
historical results.
