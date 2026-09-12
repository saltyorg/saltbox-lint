# Audit follow-up implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement and independently review each task. Steps use checkbox syntax for tracking.

**Goal:** Fix all six findings in the audit of 79cdf3c: action argument normalization, repeated fix expansion, repeated role/resource analysis, missing lexical oracle regeneration, installation documentation, and lone-CR display.

**Architecture:** Project policy remains in lint rules. Shared source-preserving argument normalization feeds those rules; analysis facts have invocation-local ownership; fix validation shares source analysis. Independent development oracles remain separate from production Go behavior.

**Tech Stack:** Go 1.27.1, Cobra, goccy/go-yaml and independent yaml.v3 semantics, patched Nuri/TextMate, explicit Node 24.20.0 oracle tooling.

**Spec:** The six findings and remediation directions in the preceding audit, approved by the user's instruction “Fix the findings.” This plan records implementation details; no further permission is needed for local work.

## Global Constraints

- Work sequentially in /opt/git/saltbox-lint. Preserve unrelated work, examples.yaml and archived demos. No branch switching, remote mutation, consumer edits or role execution.
- Keep Go 1.27.1 and runtime dependencies. Node stays outside normal Go gates and runtime.
- Preserve policy, original source positions, selected-primary filtering, related-location ownership, conservative fix authority, and already-valid source bytes.
- Keep public lint Source and Node values mutable between invocations; no persistent or process-global analysis cache.
- Preserve existing Go entrypoints and machine contracts except the explicitly approved JSON fix representation decision. Do not conflate previews with fixes.
- Use focused RED/GREEN regressions for behavior changes. Performance evidence uses deterministic outputs and before/after benchmarks, not flaky timing assertions.
- Each implementer owns one task, writes its report and makes focused local Conventional Commits. Never spawn agents from an implementer or reviewer. The controller coordinates reviews and final gates.

## Task 1: Normalize scalar action arguments

**Files:** lint/tasks.go and a focused lint/task_arguments.go if needed; lint/tasks_test.go and lint/rules_traefik_test.go for regressions. lint/jinja.go, lint/scalars.go, lint/rules_defaults.go and lint/model.go may carry the narrow projected-node provenance needed by existing expression consumers. Update docs/rule-authoring.md only if the normalization contract needs explanation.

**Interfaces:** Keep Task.argument(key) returning a source-preserving *Node. Populate arguments from scalar action/local_action tails and inline module strings in action mappings; preserve mapping and task args behavior. Keep raw free-form command data available. Reuse scalarPositions/mapSpan for original-source mapping.

- [ ] Add a regression where equivalent `include_role: {name: nginx}` and `action: include_role name=nginx`, with nginx_role_web_subdomain forwarding but incomplete contract, produce the same two adapter policy findings. Check hand-authored spans for mapped scalar values.
- [ ] Cover local_action, builtin-qualified names, quoted values with spaces/escapes, Jinja values, folded action strings, action mapping module tails, explicit args precedence, malformed/ambiguous tails and literal payloads. Reference installed Ansible parsing/mod_args.py and splitter.py read-only to establish precedence and token rules; do not execute roles or templates.
- [ ] Implement a small shared argument projection, with correct original byte spans and conservative refusal where lossless mapping is unavailable. Do not use strings.Fields or shell parsing to split quoted/Jinja argument values. Unknown or malformed tails must not fabricate values.
- [ ] Preserve include_tasks file extraction, command free-form behavior, nested task ownership and all existing normalized-action contracts. Add genuine behavior tests for the affected policies and precise scalar spans, not parser helper internals alone.
- [ ] Ensure projected content/labels scalar Nodes supply their own expressions through declaration queries, retaining original source mapping and excluding sibling argument expressions. This is part of correct argument normalization; Task 2 consumes the finished contract. Preserve existing foreign/shared-node query semantics.
- [ ] Run focused tests through RED/GREEN, then go test ./lint ./yamlindex. Self-review, commit exact paths as fix(lint): normalize scalar action arguments, and write the task report.

## Task 2: Own role and resource facts per analysis invocation

**Files:** lint/engine.go, lint/model.go if a private field is needed, lint/rules_traefik.go, lint/rules_docker_policy.go, a focused lint/analysis.go and corresponding tests/benchmarks.

**Interfaces:** Keep Analyze(project, rules) and Rule.Check compatible. Establish a private per-invocation analysis context, preferably attached to a shallow Project copy used for evaluation. Do not mutate/cache the caller's Project. Direct Rule.Check calls retain a correct uncached fallback. Cache facts by source/role identity, not rendered diagnostics.

- [ ] Capture parse-once before benchmarks for increasing role source counts and shared Docker resource counts, exercising the real Analyze entrypoint with relevant rules.
- [ ] Test repeated Analyze after public source/node mutation, selected/full equivalence, invalid context, distinct roles, duplicate/shared nodes and concurrent independent Analyze calls. Retain current deterministic ordering and diagnostic identity.
- [ ] Index role membership once, compute renderer facts once per role and Docker policies once per invocation. Reuse RuntimeExpressions per source when deriving task conditions. Preserve independent policy evaluators and existing selected-primary filtering.
- [ ] Run focused tests, after benchmarks with matching inputs, and go test -race ./lint. Report measurements without unsupported production-latency claims. Self-review and commit exact paths as fix(lint): share role and resource analysis.

## Task 3: Bound fix planning and report expansion

**Files:** lint/fixes.go, lint/jinja_layout.go only if proposal production needs adjustment, report/report.go, report/json.go, report/comparison.go and renderer lifecycle code as required, focused lint/report tests and benchmarks, README.md for JSON documentation when applicable.

**Interfaces:** Keep PlanFixes returning the same verified Change bytes. Preserve all diagnostic identities and human proposal deduplication. The user explicitly chose shared fixes and diagnostic references in JSON. Keep exported Go report types compatible; use dedicated JSON wire types if needed.

- [ ] Capture the real 10/20/40 malformed-expression case `vN: "{{ a\n | f }}"` and verify diagnostic/fix ownership. Baseline JSON serializes 100/400/1600 edit records, with 15570/55340/207480 bytes.
- [ ] Deduplicate shared proposals before expanding edits, using content correctness as well as identity where necessary. Preserve conflict detection, source selection, insertion ordering and independently allocated equivalent fixes.
- [ ] Build whitespace-validation context once per original source/candidate verification and reuse section-gap and expression knowledge across edits. Keep YAML/Jinja token checks and uncertain-edit refusal unchanged.
- [ ] Avoid allocating repeated transformed edits for human/concise/GitHub output. JSON schema version 2 is one object with `schema_version: 2`, `diagnostics: []` and `fixes: []`. Preserve all existing diagnostic fields except inline `fix`, replaced by optional `fix_id`. Each shared fix has `id`, `path`, `message` and `edits` (existing range/span/text edit shape). Assign deterministic `fix-1`, `fix-2`, ... IDs in first diagnostic occurrence order. Deduplicate exact path/message/ordered-edit content, including distinct allocations; different files or edits never share a fix. Clean output has both arrays empty. Unfixable findings have no fix_id; manual Preview never creates one. No legacy format flag or unrelated CLI change.
- [ ] Memoize repeated human proposal conversion/prefix work where shared Fix records would otherwise be expanded again. Release payload-bearing memo entries through the existing file/job releaseDisplayData boundary; preserve lightweight proposal-reference identity and manual preview behavior. Cover noncontiguous ordering and cleanup without restoring completed-file retention.
- [ ] Document the v1 inline-fix to v2 reference migration in README.md. Test referential integrity, first-occurrence ordering, content/identity deduplication, different-file distinction, clean output, original byte/range positions, omission of manual previews and writer errors. The 10/20/40 case must now contain 10/20/40 edit records total, while all findings remain present and PlanFixes produces unchanged bytes.
- [ ] Add meaningful scaling benchmarks and exact output/PlanFixes parity, conflict, idempotence, mutation and cancellation/error regressions. Run focused RED/GREEN, then go test -race ./lint ./report ./cmd. Self-review, commit exact paths as fix(lint): bound shared fix processing, and record the chosen JSON behavior.

## Task 4: Restore independent lexical oracle regeneration

**Files:** tools/oracles/lexical.mjs, explicit pinned dependency/input metadata and tests under tools/oracles; tools/oracles/README.md and highlight/testdata/README.md. Preserve production grammar/theme and frozen fixture bytes.

**Interfaces:** Follow existing explicit --sources/--assets/--fixtures/--out style as applicable. Regenerate oracle-dark.json, oracle-light.json, tokens-dark.json and tokens-light.json from actual pinned upstream engines, distinguishing independent upstream expectations from Nuri captures. Never generate independent expectations using production Go.

- [ ] Inspect all four fixture formats/provenance and tracked archived evidence read-only. Recover or reconstruct the minimal pinned vscode-textmate 9.3.2/vscode-oniguruma 1.7.0 lexical harness, original grammars/injections/themes/source inputs, and any Nuri capture command needed for non-independent token snapshots.
- [ ] Pin dependencies with verified source/integrity metadata and license notices. Keep executable dependency setup explicit and reproducible; prefer the existing offline, hash-locked tooling convention. Download only required published upstream packages when absent; no source repository or global credential changes.
- [ ] Add a test that runs from a fresh directory with documented inputs and reproduces complete expected token contents/scopes/colors/fonts. Test changed inputs/dependencies fail closed before output publication. Observe failing reproduction coverage before implementation.
- [ ] Implement the smallest runner and input validation needed for exact fixture reproduction; do not silently normalize discrepancies or overwrite frozen fixtures. If historical metadata is machine-specific, compare the full semantic payload and clearly document provenance differences.
- [ ] Run independent regeneration/tests with Node 24.20.0 and focused Go lexical compatibility tests. Document exact commands and dependency setup; no new normal Go/CI Node requirement. Self-review and commit exact paths as fix(tooling): restore lexical oracle regeneration.

## Task 5: Correct installation guidance and lone-CR display

**Files:** README.md; report/source.go and focused report/source or wrapping tests.

**Interfaces:** Preserve the local Nuri replace. Source line endings distinguish LF/CRLF from a lone final CR. No new public interface.

- [ ] Replace the unsupported versioned go install command with `go install .` from a local checkout, explaining checkout prerequisites and retaining make build as the checked build path. Correct the stale README rule count from 30 to the registry's 33 or avoid duplicating the count. Human prose earns no automated source-text test.
- [ ] Add RED regressions showing a final lone CR remains visible in human excerpts/comparisons and does not suppress the missing-LF marker. Include LF, CRLF, no-final-newline controls and unchanged original bytes.
- [ ] Strip CR only when paired with a discovered LF: `if newline >= 0 && contentEnd > start && data[contentEnd-1] == '\r'`. Keep control escaping and display positions consistent with the highlighter.
- [ ] Run focused report tests and actual CLI stdin probes for the four ending cases; inspect the documented install path against go help install. Self-review and commit the two concerns separately with fix(docs): correct source installation guidance and fix(report): preserve lone carriage returns.

## Final validation

- Run make build (includes make check), independent oracle regeneration tests, and the read-only Saltbox/Sandbox TestCorpus checks.
- Compare current corpus machine diagnostics and planned fix bytes against the pre-change baseline. Only the action-normalization bug may introduce justified findings on newly recognized syntax; explain any change.
- Confirm consumer and scratch source hashes unchanged, review all new commit subjects and final Git status.
- Run final independent integration review over the entire change and resolve its findings before delivery. Leave all requested work integrated locally; no remote actions.
