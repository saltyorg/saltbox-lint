# Terminal rendering implementation and research plan

Approved in conversation on 2026-09-12. Use fresh subagent implementers, tests before behavior changes, independent specification/code-quality reviews, and final integration review.

## Original implementation constraints

- Start from the current working tree, including existing uncommitted implementation. Preserve unrelated work, every demo, examples.yaml, consumer source bytes and existing diagnostic/fix authority. No commits, pushes, releases, role execution or consumer edits.
- CLI/API machine formats, diagnostics, source locations, Git-ignore/selection/root/symlink behavior, and automatic-fix bytes/idempotence stay compatible.
- Preserve real grammar scopes, RGB/font styles, honest evidence-theme metadata, cancellation, safe control handling and standalone CGO-free operation. No color substitution tables or out-of-context snippet parsing.
- Current worker policy is min(GOMAXPROCS,8,files), four-file lookahead per worker and four queued fragments per file. Streaming must remain ordered and workers join before closing the shared highlighter.
- More concurrency/resource use and deeper parser/document-session redesign are permitted for ANY repeatable gain beyond noise. No minimum percentage. Measure resource costs and reject latency regressions beyond noise. Prefer simpler alternatives when equivalent.
- Keep benchmarks isolated from other CPU-heavy work. Freeze input and binary hashes, use fresh processes, alternate baseline/candidate order, retain all trials, and use at least seven paired trials for adoption. Compare CPU/allocations/output bytes as well as total/first-report/first-finding latency and peak RSS.
- After presentation changes, freeze a new presentation baseline. Later optimization preserves decoded terminal text/styles/positions; ANSI compression may intentionally change escape bytes.
- Caches and output queues remain bounded per render; no mutable process-global parsed-source cache. Record implementation/defer outcomes for every performance candidate.

### Task 1: Complete, readable, bounded terminal presentation

Remove BOTH 100-column caps. Detect width once from the actual output destination (stderr for --diff diagnostics), use all detected columns, retain80-column fallback and honor HumanOptions.Width without a cap. No new flags or lint line-length policy.

Replace horizontal clipping with visual wrapping at available display width after gutters. Prefer whitespace boundaries, hard-break long tokens at grapheme boundaries, preserve all source characters and meaningful whitespace. Source numbers appear only on first visual row; continuations have blank number cells and ↪, retaining +/- markers. This is display-only: no source edits or reformatted proposals. If normal gutter leaves fewer than2 cells, put location information on a separate line. Preserve Unicode, tabs, indentation, control escaping, blank lines and EOF indicators; recalculate caret intersections against original byte spans for each visual row.

Show EVERY added/removed and diagnostically marked source line. Keep short unchanged context and explicit gap labels; remove the24-row middle omission for changes and the marked-span omission in excerpts. Keep2 context lines per diff hunk and1 around diagnostic excerpts.

Add one clear blank line before fix guidance and between code and following explanatory text. Frame each new file path with full-width heavy rules above/below and extra file-transition spacing; retain light within-file dividers, omit redundant stacked dividers, preserve native Saltbox Lint H1.

Introduce a private visual-row representation shared by comparisons/excerpts. Refactor unbounded complete-finding builders to stream fragments capped64KiB, cut at safe UTF-8/ANSI boundaries without inserting source newlines. Flush at finding boundaries even below the cap. Four fragments per scheduled file and up to32 scheduled files bound queued payload to8MiB. Large findings must stream without materializing an unbounded complete finding. Cancellation/write errors stop work and join workers; preserve ordering and close ownership.

TDD: real yyq:35:9 at40/80/100/160/240columns; full condition fits wide screens and wraps narrow; source reconstruction, continuation numbers/markers, RGB/fonts, caret mapping; long tokens/combining/emoji/tabs/CRLF/EOF; 9→10/99→100/999→1000; very narrow gutters; large changes without hidden changed lines; framed file boundaries/shared proposals/related locations;64KiB fragment bound, early output, cancellation/blocked sends/writer errors, zero findings and all color profiles. Use committed regression fixtures, consumers read-only. Report Task1 APIs/checks and freeze.

### Task 2: Establish fresh baseline and optimize loading/parsing

After Task1 review, baseline representative full Saltbox/Sandbox, yyq and small selected-file/stdin/synthetic-large workloads across dark/light/plain/machine modes and useful1/2/4/8 concurrency. Instrument discovery, reads, parse, rules, preview validation, semantics, grammar, style and write costs separately; freeze new visual/cell and machine evidence.

Investigate repeated discovery sorting/context scans first. Reuse an ordered Git candidate list and directory lookup structure if beneficial. Separate candidate discovery from bounded read/parse jobs: selected sources first, derive required context, then missing context. Workers return results; coordinator publishes deterministically. Preserve admission of root playbooks, explicit-file ignores overrides, source selection, symlink/root checks, operational-error ordering and cancellation. Reuse established concurrency ceiling; avoid nested full-sized pools. Keep rule evaluation after complete project exists and retain lint.Load interface. Benchmark alternatives before adoption and compare paired trials after implementation; defer only with evidence if no qualifying win.

### Task 3: Avoid semantic work unused by display

Latest user clarification requires light-theme quality parity. Add a renderer-specific highlighting entry point returning display tokens and enable Ansible semantic categories for both supported display themes using their real theme/fallback palettes. Existing full/prefix evidence APIs retain configuredByTheme metadata, complete semantic results and behavior; imported assets remain unchanged. The previously proposed light semantic skip is inapplicable because it would retain weaker classification. Reuse successful lexical results on semantic failure rather than lexing twice; preserve cancellation/plain fallback. Dark cells and all text/machine/source invariants stay exact; light styles are intentionally corrected against category/color oracles. Record quality costs honestly and measure optimization at equivalent quality.

### Task 4: Reduce redundant ANSI sequences

Measure/coalesce adjacent safe rendered text with identical effective foreground/background/font styles after wrapping. Preserve source token data, RGB validation, gutter styling and resets at visual-row boundaries. Measure size, rendering CPU/allocations and a controlled slower-output sink. Decoded cells must match across color profiles; do not require old escape bytes. Keep chunk bounds and progressive output. Adopt any repeatable win with correctness.

### Task 5: Research and implement shared parsed analysis

Measure repeated lexing/parsing/indexing/source copies. Compare shared token/index reuse with a common immutable parsed-source model, permitting a neutral analysis module or parser consolidation when it wins and preserves BOTH lint behavior and semantic evidence. Keep existing public entrypoints as compatibility wrappers; share validated analysis from preview preparation without authorizing fixes. Differentially cover acceptance/errors, aliases/tags/duplicate keys/scalar styles/Unicode offsets and semantic-token oracles. Reject designs needing weakened behavior; compare alternatives and adopt qualifying gains, otherwise record researched/deferred evidence.

### Task 6: Research and implement direct grammar checkpoints

Measure remaining prefix traversal/allocation after previous optimizations. Prototype per-document snapshots: resume earliest affected line, reuse unchanged suffix only at complete grammar-state convergence, invalidated by validated original-byte edits. Preserve first-line/grammar/resolver/captures/multiline/safety/taint semantics; full-source semantic context remains independent. Prototype combined64MiB cache/snapshot ceiling including existing line cache, measure cost, and keep lifetimes per report. Existing highlighter entrypoints remain wrappers if document-session API adopted. Compare full uncached oracle and current line cache; adopt repeatable wins or record supported deferral.

### Task 7: Delivery and results reconciliation

Update docs/terminal-rendering-results.md per item with implemented or researched/deferred status and evidence; docs/stack match final architecture. Final independent integration review, make build snapshot, root/nested race gates, actual-terminal width/theme/stdin acceptance, source/machine/fix parity and idempotence, demo/consumer hashes and offline CGO-free execution. Report measured results honestly, including tradeoffs/deferred candidates. No unmeasured performance claims and no remote/consumer mutations.
