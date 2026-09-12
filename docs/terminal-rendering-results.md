# Terminal rendering implementation and research results

Implementation record for the [approved 2026-09-12 plan](superpowers/plans/2026-09-12-terminal-rendering.md).
Tasks 1–6 are implemented and independently reviewed. Checkpoint adoption
includes the reviewed edit-boundary correction and renewed paired measurements.
Final build/snapshot, terminal, source-preservation and standalone acceptance
passed. The preserved-baseline breadth supplement is complete; all planned
implementation and delivery work is complete.

## Readable code comparisons and spacing before fix guidance

**Implemented (Task 1).** Both 100-column caps are removed. Human findings and
rule help use the full destination width, with an 80-column fallback; `--diff`
detects stderr independently from its stdout patch. Explicit `HumanOptions.Width`
is uncapped. No line-length policy or new CLI flag was added.

Source rows wrap at whitespace when possible and otherwise at grapheme boundaries.
Continuation rows have blank line-number cells and `↪`, retaining comparison
`+`/`-` markers. Narrow layouts move location metadata onto a separate row.
Every changed and diagnostically marked line appears; unchanged gaps are labeled,
with two context lines per comparison hunk and one around marked excerpts.
Source bytes, indentation, safe control escaping and byte-span caret ownership
are preserved. A blank line separates code from fix guidance and explanations.

Regression evidence covers the actual `roles/yyq/tasks/main.yml:35:9`
`ansible-when-parentheses` finding at 40/80/100/160/240 columns. At 160/240 the
complete current and suggested conditions each fit one source row. Fixtures
also cover Unicode, tabs, controls, CRLF/EOF, number-width transitions, large
changes, full-row endpoint carets and very narrow gutters. A two-cell grapheme
remains indivisible even if a one-column terminal cannot contain it.

Large findings stream in UTF-8/ANSI-safe fragments capped at 64 KiB, flushing at
each finding boundary. Four queued fragments per file and four-file lookahead
per worker cap queued payload at 8 MiB with eight workers. This excludes active
rendering, source analysis and grammar resources. Cancellation, writer errors,
ordering and worker join-before-close have dedicated regression coverage.
Evidence: `task-1-report.md`, `report/wrapping_test.go`, `report/endpoint_test.go`
and the fragment/streaming suites.

## Clearer transitions between files

**Implemented (Task 1).** File paths are framed above and below with full-width
heavy rules and extra transition spacing. Findings within a file retain a light
divider; file boundaries avoid stacked redundant dividers. The Saltbox Lint
banner remains native. Tests cover multiple findings/files, shared proposals,
related locations, all color profiles and narrow widths.

## Performance research and selective implementation

Results below are observations on frozen local workloads, not general hardware
or terminal guarantees. Adoption comparisons use seven alternating, fresh-process
pairs with all trials retained and no outcome filtering. Full colored figures
refer to Saltbox at 160 columns; targeted benchmarks state their narrower scope.
The preserved local evidence is in the dated 2026-09-12 implementation directory
under `.superpowers/sdd/`; named JSON/report files below live there and contain
trial-level hashes and resource/latency measurements.

Task 1 intentionally changed presentation. Task 3 then established a new One
Light semantic-quality baseline. Later optimization comparisons preserve decoded
text, positions, RGB and font styles; Task 4 intentionally changes ANSI bytes.
Early manifests covered only 194 selected diagnostic/demo inputs, so they are
not proof that all loaded context bytes stayed fixed. The final Task 5 and
Task 6 comparisons additionally freeze all 471 loaded Saltbox and 450 loaded
Sandbox sources. These are linter-selected/context counts, not every YAML file
in those repositories.

### Initial loading and parsing concurrency

**Implemented (Task 2).** One sorted Git candidate index replaces repeated
sorting and directory-wide scans. Bounded read/parse batches serve Git and
ordinary directory discovery; the coordinator publishes deterministic results
and preserves selected/context barriers and error order. Rule evaluation stays
sequential after project construction. Expression-free scalars skip unnecessary
source mapping, and declaration membership is filtered before expression scans.
Private disk-read buffers avoid one copy while public parsing and stdin retain
caller isolation. No global analysis cache was introduced.

The post-presentation baseline → final Task 2 full dark report measured:

| Median | Before | After |
|---|---:|---:|
| Total | 5.560 s | 4.190 s |
| First output | 1.623 s | .331 s |
| First finding | 2.170 s | .911 s |
| CPU | 19.152 s | 16.026 s |
| Peak RSS | 365,924 KiB | 366,528 KiB |

Output remained exactly 4,846,799 bytes with identical decoded cells. Isolated
Git batching reduced median load .0839 → .0366 seconds while increasing CPU
.731 → .789 seconds and peak RSS 49,228 → 52,036 KiB. Non-Git batching also
trades resources for latency. Owned buffers have deterministic allocation
savings, with no claimed latency win. Later candidates in a batch can finish
before its earliest ordered error is returned; all readers join first.
Root-identity reuse and deduplicating public parse diagnostics were left
unchanged because their compatibility contracts were not independently optimized.
Evidence: `loading-dark.json`, `task-2-report.md` and its per-candidate results.

### Reuse analysis instead of parsing suggestions repeatedly

**Implemented shared indexing and prepared semantics (Task 5); whole-parser
consolidation researched and deferred.** Immutable `yamlindex` snapshots retain
original scalar ranges before goccy parsing can mutate linked tokens. Preview
validation shares that index with semantic classification only for exactly
matching source bytes. Each renderer retains one prepared original semantic
document; suggested variants are ephemeral. Existing APIs remain wrappers and
suggestions gain no fix authority.

An actual common-tree prototype disagreed on duplicate keys, unknown aliases,
a malformed later document and `%YAML 1.2`. The lint and yaml.v3 semantic parsers
therefore remain independently authoritative. Its faster compatible-fixture
microbenchmark does not justify weakening those acceptance/error contracts.

Seven-pair targeted medians: legacy → indexed classification 3.299 → 2.367 ms,
with about 116 KB more transient allocation. Reusing an already constructed
index reduced classification 2.442 → 1.309 ms, 2,173,172 → 851,696 B/op and
25,605 → 11,081 allocations/op. That second measurement excludes index
construction; complete-report measurements include its cost.

The final complete-input comparison, Task 4 final → Task 5 prepared, measured:

| Palette | Total | CPU | Peak RSS | First finding |
|---|---:|---:|---:|---:|
| Dark | 4.425 → 4.053 s | 17.375 → 16.420 s | 361,928 → 367,368 KiB | .994 → .935 s |
| Light | 3.889 → 3.630 s | 15.875 → 15.350 s | 363,388 → 363,712 KiB | .896 → .917 s |

First output stayed near .350 seconds dark and .340 seconds light; the light
first-finding median is later. No universal startup improvement is claimed.
Output bytes and decoded cells remain exact. Evidence: `shared-final-dark.json`,
`shared-final-light.json`, `task5-index-micro.json`, `task5-shared-micro.json` and
`task-5-report.md`. The scalar-index differential sweep also preserved results
across 2,775 Saltbox and 2,541 Sandbox YAML inputs.

### Preserve semantic display quality and avoid redundant fallback work

**Implemented (Task 3); light semantic skipping rejected.** Human display now
uses the same Ansible module, argument, keyword and property categories in both
themes, through their own semantic rules and TextMate fallback palettes.
Imported themes remain unchanged. Complete evidence APIs still report each
theme's configured semantic enablement honestly; One Light's evidence flag
remains false even though human display explicitly applies semantic categories.

The required light-quality correction increased full-report median total
3.498 → 3.983 seconds and CPU 15.376 → 16.390 seconds. Text remains exact while
foreground styles intentionally change against category/color oracles. The
corresponding dark comparison was within variation, with exact styles and text.
These figures are quality costs, not an optimization claim.

For malformed YAML, the display API now returns its successful lexical result
when semantic classification fails, avoiding a second grammar request. Seven
paired equivalent-output targeted trials reduced 98.081 → 53.422 microseconds,
30,690 → 21,473 B/op and 288 → 205 allocations/op. Cancellation remains an error.
Evidence: `semantics-dark.json`, `semantics-light.json`, `malformed-pairs.json`
and `task-3-report.md`.

### Reduce redundant terminal escape sequences

**Implemented (Task 4).** Adjacent safe text with identical effective styles
shares ANSI sequences, retaining ambient-style compatibility, RGB validation,
font flags, row/gutter resets and source-token ownership. Public raw-control
inputs retain their prior reset behavior. More complex cross-style delta
encoding remains deferred; the simpler measured implementation met the goal.

Corrected-final seven-pair results reduced dark output 4,846,799 → 1,608,982 bytes
and light output 4,791,187 → 1,557,617 bytes with identical decoded cells.
Normal-output total medians were 4.216 → 4.100 seconds dark and 3.901 → 3.900
seconds light; those do not establish a broad rendering speedup. A controlled
1 MiB/s sink improved total 6.204 → 4.428 seconds, with CPU 15.490 → 15.726
seconds and RSS 362,196 → 360,512 KiB. This demonstrates the output-volume
benefit without claiming an actual SSH/terminal benchmark.
Evidence: `ansi-final-dark.json`, `ansi-final-light.json`, `ansi-final-sink.json`
and `task-4-report.md`; earlier prototype numbers are superseded for adoption.

### Resume grammar scanning directly from checkpoints

**Implemented and adopted after review correction (Task 6).**
Immutable per-document raw tokens and complete grammar states resume at affected
lines after validated original-byte edits. Suffix reuse requires complete-state
convergence, exact grammar/resolver ownership, safety options and first-line
status. Invalid/stale edits fall back to full scanning; degradation/taint cannot
publish checkpoints. Full-source semantic context remains independent.

Line reuse and document checkpoints share a 64 MiB retained-data ceiling per
report (32 MiB each). Borrowed snapshots remain charged until their readers
finish; suggested variants remain ephemeral. This ceiling excludes total RSS.
Uncached grammar differential tests cover both palettes, multiline/capture/while
state, edits, Unicode, CRLF/EOF, cancellation, invalidation and ownership.
The reviewed implementation corrects invalid-edit, taint, conservative accounting
and newline-deletion boundary handling. Aligning both old/new suffix cursors at
physical line boundaries fixes dropped or incorrectly styled joined-line text.
Independent review is clean, including 32,123 edit comparisons against uncached
tokenization and actual Ansible display oracles in both palettes.

The corrected candidate's seven-pair targeted results are:

| Lexical workload | Time | Bytes/op | Allocations/op | Faster pairs |
|---|---:|---:|---:|---:|
| Repeated prefixes | 3.176 → 2.940 ms | 4,977,952 → 4,176,408 | 44,515 → 39,435 | 7/7 |
| Edited document | 2.209 → 1.216 ms | 1,655,946 → 1,406,720 | 14,824 → 13,144 | 6/7 |

Edited-document timing has high variance, including one slower pair. Repeatable
prefix gains and reduced allocations support adoption under the approved
any-repeatable-gain criterion. These benchmarks exclude semantic classification
and do not establish faster complete-report startup.

| Full report palette | Total | CPU | Peak RSS | First output | First finding |
|---|---:|---:|---:|---:|---:|
| Dark | 4.055 → 4.146 s | 16.519 → 17.254 s | 366,096 → 388,396 KiB | .357 → .383 s | .948 → 1.002 s |
| Light | 3.605 → 3.603 s | 15.421 → 15.475 s | 361,612 → 382,252 KiB | .338 → .338 s | .923 → .934 s |

These are separate before/after medians. Dark's within-pair total improves in
6/7 pairs with a median delta of −.240 seconds despite its higher candidate-side
median; variable trials make those two statistics differ. Light improves in
4/7 pairs with near-identical side medians. There is no reliable full-report
speedup or startup improvement claim. Peak RSS increases about 20–22 MiB.
Exact output bytes and decoded text/positions/RGB/fonts remain unchanged.

Evidence: `task6-adoption.json`, `checkpoints-reviewed-dark.json`,
`checkpoints-reviewed-light.json`, `task6-reviewed-prefix-micro.json`,
`task6-reviewed-edit-micro.json` and `task-6-report.md`. The corrected driver is
`measure-task6-reviewed` (SHA-256
`26d419e02546f9dbf7b30b4f506ba76484e75d9dee3b1a1dc7070b8e055fcbb1`).
All seven pairs and the complete 471/450 loaded-source manifest remain retained;
earlier prototype and pre-review-final trials are superseded for adoption.

## Final delivery verification

The final `make build` and snapshot gate passed in `final-build-snapshot.log`:
module/format checks, vet, zero golangci-lint issues, root and patched Nuri race
suites, shell/actionlint and GoReleaser validation, followed by the CGO-free
binary and both Linux architecture archives. `final-packaging.json` verifies
archive checksums and matching third-party notices. These are local snapshot
artifacts; no release was published.

The accepted `bin/saltbox-lint` SHA-256 is
`f5ff2330461464db3bb56f7f55ad1382c007a24380a4772ffde06b90195171ad`.
The archive verification describes the README and packaged inputs at that build
boundary.

- `final-contract_probe.log`: exact Saltbox/Sandbox diagnostics (471/106), JSON,
  concise, GitHub and 4,142-byte diff output; 269 protected demo/asset files unchanged.
- `final-fix_probe.log`: identical fix bytes on copies, idempotence and unchanged
  consumer source. `final-inputs.json` preserves complete 471/450 loaded-source
  identity and selection.
- `final-matrix.json`: 15 API cases across 40/80/100/160/240 columns and
  plain/dark/light output retain corrected decoded-cell oracles.
- `final-pty-{dark,light,auto}-{40,80,100,160,240}.json`: 15 actual-terminal cases
  cover width and palette behavior. `final-terminal_probe.log` verifies theme
  detection/fallback, stdin separation, stderr-only diff diagnostics and no
  query for redirected or machine/no-color output.
- `final-concurrency.json`: GOMAXPROCS 1/2/4/8 on both corpora produces exact
  output within each corpus. These are functional observations, not paired
  concurrency-adoption benchmarks.
- `final-offline_probe.log`: both palettes run from the standalone binary in a
  bare chroot with source fixtures and no external highlighting runtime.
- `final-interrupt_probe.log`: interrupt exits with status 2 and `context canceled`;
  the observed interrupt-to-exit interval is .195 seconds.

One actual full Saltbox terminal command (`final-terminal.json`, 160 columns,
auto theme) completed in 3.628 seconds, first output .354 seconds and first
finding .893 seconds. This is a single acceptance observation, not a benchmark
median or a comparative speed claim.

Independent integration source/adoption review is clean, and the final reviewer
verified the delivery gate and acceptance evidence. `final-acceptance.md` and
`final-review.md` retain the final delivery record. No consumer source or remote state was changed during implementation.

### Baseline breadth supplement

`baseline-breadth.json` retains 14 descriptive cases across both full corpora,
all output modes and dark output at GOMAXPROCS 1/2/4/8. These were collected
retrospectively using the frozen post-Task-1 binary, not originally before the
implementation. Each is a single observation rather than paired adoption
evidence; its original weaker light display was subsequently corrected.

`small-workload-pairs.json` retains seven fresh pairs each for selected-file and
stdin workloads, with exact decoded text/style cells. Separate before/after
medians from `small-workload-summary.json` are:

| Workload | Wall time | CPU | Peak RSS | Output bytes |
|---|---:|---:|---:|---:|
| Selected file | .269 → .275 s | .350 → .354 s | 112,532 → 112,272 KiB | 12,264 → 4,136 |
| Stdin | .243 → .250 s | .315 → .328 s | 110,164 → 111,436 KiB | 7,479 → 4,155 |

First-finding medians are .265 → .271 seconds selected and .230 → .237 seconds
stdin. Pair signs vary; there is no small-workload speed improvement claim.
The before/after complete input manifests (`breadth-inputs-before.json` and
`breadth-inputs-after.json`) both have SHA-256
`efb95423edf44743f5e1883bea6dd5dc249aa705a92d79ca39982b962a654d38`.
Synthetic non-Git loading retains its original seven-pair `nongit-json.json`
and `task2-nongit-manifest.json` evidence.
