# VS Code extension implementation record

Implementation is in progress. This document is not a publication or native
platform qualification claim.

Plan: [portable extension implementation](superpowers/plans/2026-09-12-vscode-extension.md).
Baseline: `ef533311fc48a5001d497d99e462f0968bbceb16`.

## Reviewed stages

- Portable CLI: `9095823`, corrected by `2d66fd7`. Independent review clean.
  Linux quality gate and six CGO-free cross-builds passed. Darwin/Windows native
  execution remains a qualification gate.
- Canonical formatter: prerequisite `6b95b0f`, implementation `f5f69e8`, corrections
  `3d7660b`. Independent review clean. Full quality gate passed. Consumer-loader
  and end-to-end editor qualification remain outstanding.
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

Editor integration, packaging, source/licensing inventory, native CI, actual
consumer-loader qualification, formal performance measurements and final
integration review are still required. Nothing has been pushed or published.
