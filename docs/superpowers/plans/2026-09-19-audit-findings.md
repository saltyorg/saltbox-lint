# Resolve all four audit findings

Approved in conversation on 2026-09-19; implementation uses superpowers:subagent-driven-development.

## Goal and constraints

Fix editor check loss, uppercase YAML refresh, web-contract false positives, and incompatible diff filenames. Use the user's selected lazy-coalescing queue policy: retain one lightweight request per file and construct its snapshot when execution begins.

Preserve existing CLI flags, JSON schemas, rule identifiers, selected-file behavior, and formatter safety checks. Work locally in /opt/git/saltbox-lint with sequential writes and focused fix(...) commits. No new dependencies, remote mutations, publication, or unrelated performance work. Consumer repositories and examples.yaml remain untouched. Follow AGENTS.md, the nine required coding principles, and the updated /opt/dev/go-skills/go/SKILL.md for Go work.

Each task requires a failing behavioral regression before production edits, targeted validation, self-review, a local commit, and independent specification/code-quality review. Report exact RED/GREEN commands and outputs to the task report. Do not dispatch agents from implementer/reviewer tasks.

## Task 1: Retain pending editor checks

Implement in extension/src/scheduler.ts and extension/src/editor.ts; extend existing unit and host regression harnesses. Add an explicit non-evicting mode to Scheduler and use it for the lint lane. Preserve the formatter lane's bounded behavior. Coalesce requests by existing document/workspace keys; keep one running lint process, existing priorities, FIFO within a priority, and latest-request replacement.

Move document snapshot construction inside the scheduled operation. Pending requests retain document identity, requested version, ownership and revision information, not copied YAML text or indexes. Register ownership when enqueueing. Before execution and publication validate document/root revisions and eligibility. Edits, closure, root removal and disposal cancel obsolete requests without rescheduling. Delaying snapshots must not turn a queued open/save check into checking a later unsaved version. Workspace and selected-file scans use the same non-evicting lint lane.

Tests: hold first operation, submit 40 and 100 distinct requests, prove every still-current request executes and max concurrency remains one. Cover supersession, priority/FIFO, cancellation/disposal, and lazy snapshot creation. Add a VS Code host regression proving >32 open documents receive diagnostics after activation/root refresh. Also demonstrate obsolete queued work cannot publish or run after root/document invalidation. Use test fixture synchronization rather than arbitrary sleeps when holding work. Preserve existing formatter eviction tests.

Run extension check/unit/format checks and focused Linux host regression against locally available editor SDK. Record exact commands and SDK. Controller runs final minimum/current host qualification. Commit fix(vscode): retain pending document checks.

## Task 2: Restrict web-contract detection to actual composition

Update lint/rules_web.go and focused tests/committed lint/testdata fixtures. Independent mapping fields and sequence elements must not contribute components to a shared match. Apply repeated-component detection to string-valued defaults. Recognize adjacent output expressions separated by a literal dot and direct Jinja concatenation with ~ or +. Require matching literal role/endpoint arguments. Do not infer composition from collection entries, conditional alternatives, or unrelated calls. Reuse existing token/owner analysis and avoid a second general Jinja parser.

Preserve endpoint-family checks, HTTPS host fallback, deterministic first-match reporting and diagnostic-only behavior. Document deliberately unsupported ambiguous forms instead of restoring broad co-occurrence matching. Top-level YAML mapping/sequence defaults are not replaced with a role_web string suggestion.

Tests: valid independent mapping fields, sequence entries, Jinja dict/list entries and conditional alternatives; invalid actual interpolation/concatenation including cross-role endpoints, nested grouping, multiple matches and deterministic ordering. Valid sources have no composition diagnostic or fix. Existing web rule tests remain green. Run targeted web-rule tests then Go test ./lint ./format ./yamlindex and record evidence. Commit fix(lint): restrict endpoint composition detection.

## Task 3: Watch every accepted YAML extension

Change the watcher in extension/src/roots.ts to **/*.{[yY][mM][lL],[yY][aA][mM][lL]}. Preserve existing event deduplication, selected-file refresh and root ownership. Add no new watched categories.

Add host regression(s), using real filesystem notifications on a case-sensitive host, for external create/change/rename/delete of uppercase/mixed-case YAML. Verify diagnostics refresh without manual check and unrelated files retain findings. Keep case variants in cross-platform tests where supported; Linux must exercise actual case-sensitive matching. Run extension unit/type/format checks plus focused host regression. Commit fix(vscode): watch mixed-case yaml extensions.

## Task 4: Emit Git-compatible diff paths

Replace Go quoting in report/diff.go with byte-oriented Git path quoting. Preserve ordinary ASCII paths. Quote paths containing spaces, control bytes, quote, backslash or non-ASCII bytes; escape quote/backslash and use three-digit octal byte escapes for bytes requiring encoding. Preserve patch data, CRLF/LF and missing-final-newline markers.

Test ordinary names, spaces, NBSP, Unicode including non-BMP, quote/backslash and supported controls. Generate patches, run git apply --check and apply in temporary repositories; compare resulting bytes. Platform-invalid filenames remain encoder tests and must not make Windows tests fail. Include zero/missing final newline and line-ending regressions. Run focused diff tests then go test ./report. Commit fix(report): quote diff paths for git.

## Final acceptance

After independent task reviews: run make check, the affected host regressions on existing minimum/current SDKs (1.100.0 / 1.137.0), and read-only corpus equivalence:

SALTBOX_LINT_SALTBOX_CORPUS=/srv/git/saltbox SALTBOX_LINT_SANDBOX_CORPUS=/opt/sandbox go test ./lint -run '^TestCorpus$' -count=1 -v

Compare corpus results with baseline Saltbox 431 files/0 findings, Sandbox 414 files/105 findings, recording changed source manifests and reasons for any diagnostic changes. Use existing local host infrastructure and report native platform limitations truthfully. No remote workflows. Independent final integration review covers all tasks. Retain durable validation/review results in docs, inspect new commit subjects, and finish in the requested checkout.
