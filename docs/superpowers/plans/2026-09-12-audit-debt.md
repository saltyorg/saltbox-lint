# Audit debt implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Resolve the four findings from the approved codebase audit without changing lint policy, source bytes, or rendered output.

**Architecture:** Give declaration queries an invocation-local source index, give display caches a file-scoped lifetime, preserve independent oracle generation as development tooling, and use one lexical location implementation with separate lint and semantic projections.

**Tech Stack:** Go 1.27.1, goccy/go-yaml, yaml.v3, Cobra, embedded TextMate/Nuri; Node only for explicitly invoked development oracles.

**Spec:** The user approved implementation of the four audit findings in this conversation. The binding design is the goal, architecture, constraints and acceptance requirements below; no separate speculative feature specification is needed.

## Global Constraints

- Keep Go 1.27.1 and existing runtime dependencies; Node is not a normal build or runtime dependency.
- Preserve lint policy, diagnostic identity/order/spans, selected-file boundaries, fix authority, and source bytes.
- Preserve rendered text, colors and styles, proposal deduplication, cancellation and writer-error behavior.
- Keep the lint and yaml.v3 semantic parsers independently authoritative.
- Public Source and Node values remain mutable between calls; do not retain stale analysis across invocations.
- Work sequentially in /opt/git/saltbox-lint as directed by repository guidance. No branch switching, consumer edits, role execution or remote mutations.
- Never edit or stage examples.yaml or archived demo sources. Local workflow evidence is read-only input when recovering the missing oracle tooling.
- Stage exact task paths and use standard lowercase Conventional Commits. Use fix(scope): for broken behavior.
- Use focused RED/GREEN evidence where a missing behavior is being added; performance regressions use a before/after benchmark and deterministic correctness coverage, never flaky wall-time assertions.
- Each implementer owns only its task, performs self-review, writes its report, and never spawns agents. The controller owns independent task and final integration review.

## Task 1: Eliminate repeated whole-source declaration walks

**Files:** Modify lint/rules_defaults.go, lint/jinja.go and the declaration-query callers in lint/rules_docker.go, lint/rules_web.go and related lint rule files as required. Extend lint/declaration_expressions_test.go; add lint/declaration_expressions_benchmark_test.go.

**Interfaces:** Keep public lint APIs unchanged. Introduce a private invocation-local declaration query/index, consumed by checkers with repeated queries. Keep expressionsForDeclaration behavior for nested keys/values, unsafe ancestors, shared nodes, foreign parents containing source nodes, and foreign nodes. Queries must retain source occurrence order and multiplicity.

- [ ] Step 1: Establish the existing traversal contract through the committed tests and a parse-once benchmark of the two affected rules at 100, 200, 400 and 800 literal declarations. The benchmark construction is:

```go
var text strings.Builder
for i := range n { fmt.Fprintf(&text, "example_role_value_%d: literal\n", i) }
source, ds := Parse("roles/example/defaults/main.yml", []byte(text.String()))
if len(ds) != 0 { b.Fatal(ds) }
project := &Project{Sources: map[string]*Source{source.Path: source}, Selected: map[string]bool{source.Path: true}}
var rules []Rule
for _, rule := range Rules() {
    if rule.ID == "docker-aggregate-contract" || rule.ID == "role-web-contract" { rules = append(rules, rule) }
}
for b.Loop() { Analyze(project, rules) }
```

- [ ] Step 2: Add correctness tests for the index/query behavior before implementation. Independently expect ordered key/first/second tokens, duplicate shared-node occurrences, no unsafe expressions and no foreign-only nodes. Mutate public nodes between invocations and verify the next call observes the mutation. Retain the existing narrow-query allocation test.
- [ ] Step 3: Build source traversal/membership information once per checker or analysis invocation, not per declaration. Use occurrence order plus node membership; avoid a global or persistent Source cache. Route every repeated-query loop through that boundary. Keep single-query helpers simple and compatible.
- [ ] Step 4: Run focused declaration and affected rule tests, the same benchmark, then go test ./lint. Report before/after scaling and allocations without a production latency claim.
- [ ] Step 5: Self-review and commit exact paths as fix(lint): avoid repeated declaration source scans. Report commands, outputs, changed files and any caveats.

## Task 2: Release completed-file display data

**Files:** Modify report/human.go, report/human_parallel.go and report/highlighting.go or report/source.go only where lifetime ownership requires it. Add report/cache_lifetime_test.go.

**Interfaces:** Keep public report APIs unchanged. A renderer must retain display token/line/prepared data only while processing a primary file group and its related excerpts. The existing highlighter-owned bounded lexical caches remain unchanged. Noncontiguous input order and proposal-reference behavior remain valid.

- [ ] Step 1: Add a real-renderer regression that processes many distinct file jobs and proves finished jobs no longer retain token/line/prepared source payloads. Cover sequential file transitions, parallel job reuse, related excerpts and failure/cancellation cleanup. Name the missing release behavior caught by each test; no production-only test hook.
- [ ] Step 2: Run the focused regression before implementing and retain its failing output.
- [ ] Step 3: Add a single renderer-owned release operation at the actual job/primary-file lifetime boundary. Release line and token maps and prepared documents. Keep proposal deduplication identity separate from disposable display data. On noncontiguous sequences re-render evicted sources safely. Prefer dropping file data over a speculative second LRU.
- [ ] Step 4: Run the new tests and existing sequential/parallel, noncontiguous, related-location, cancellation, writer-error and output-equivalence tests, followed by go test -race ./report. Demonstrate that old-file payloads do not accumulate as file count grows.
- [ ] Step 5: Self-review and commit exact paths as fix(report): release completed file display caches. Report lifetime evidence and tests.

## Task 3: Preserve reproducible independent oracle tooling

**Files:** Create tools/oracles/ for development-only runners, pinned input manifest, explicit dependency lock if needed and README. Recover only required independently authored generator/source/case files from .superpowers/sdd/demo-v4-semantics; preserve that source directory. Modify tools/import-grammars/main.go and add main_test.go. Update highlight/testdata/README.md, highlight/semantics/testdata/README.md and highlight/ASSETS.md. Add a small non-network asset-integrity test in highlight if needed.

**Interfaces:** Normal Go gates read frozen fixtures/assets and do not require Node, network or installed editor extensions. Explicit oracle regeneration accepts source/output locations and validates pinned upstream identities. The grammar import command accepts an extension directory and output directory; pinned version and manifest constraints remain enforced. No implicit downloads during normal checks.

- [ ] Step 1: Inventory actual existing local oracle harnesses, source pins and case inputs named by the fixture documentation. Determine which independent style and semantic runners produce the tracked fixture families. Do not replace the independent oracle with Go-produced expectations or silently regenerate different fixtures.
- [ ] Step 2: Before changing the grammar importer, add temporary-directory tests for explicit source/output paths, incorrect source version, malformed later grammar preserving prior output, and consistent hash manifests. Run the command or extracted real run function and assert bytes/errors, not source text.
- [ ] Step 3: Make source/output paths explicit, parse/validate all required input before publishing generated files, and update both per-import and aggregate asset hashes consistently. Preserve unrelated existing assets. Add offline manifest validation that detects changed/missing assets with useful paths.
- [ ] Step 4: Preserve independently executable style and semantic oracle generators with required case inputs and verifiable source/dependency pins. Remove controller-home assumptions. Include upstream license/provenance for copied source. Keep runtime and make check Node-free. Existing catalog documentation may describe external Ansible inputs explicitly; supply fixture-based pinned documentation input where sufficient to reproduce semantic expectations without the controller installation.
- [ ] Step 5: Exercise tracked tooling from a temporary directory with only its documented inputs. Regenerate independent expectations to temporary output and compare them to the tracked fixtures. Test grammar import from an explicitly supplied copied extension directory; do not mutate the installed extension. Retain exact evidence of reproduced families and any meaningful environment provenance differences.
- [ ] Step 6: Update human-facing reproduction instructions and run focused tool/asset/highlight tests. Self-review and commit exact paths as fix(tooling): make highlighting evidence reproducible.

## Task 4: Share exact lexical source locations

**Files:** Modify yamlindex/index.go and lint/source.go; add yamlindex/locations.go and locations_test.go if that keeps the boundary focused. Extend existing source/index tests only for meaningful missing cases.

**Interfaces:** Introduce one yamlindex lexical location result per token carrying trimmed start/end plus the complete origin end. Both lint source adaptation and immutable semantic scalar indexing consume it. Keep source coordinates, literal contents, comments, tags, anchors, escape handling and malformed-input behavior unchanged. Do not merge parsers or expand aliases.

- [ ] Step 1: Characterize both existing projections on escaped double quotes, Unicode escape spellings, CRLF, tags/anchors, folded/literal values, empty tokens and duplicate scalar spellings. Use hand-authored expected byte spans and origin ends, and test invalid non-whitespace gaps fail closed. Write tests for the shared boundary before adding it.
- [ ] Step 2: Implement ordered raw-token location once in yamlindex. Keep complete origin end available to lint and trimmed scalar spans available to semantic classification. Translate rune coordinates through one helper when needed. Remove duplicated double-quote scans and mapping logic from lint.
- [ ] Step 3: Run source/index and decorated-scalar tests, then go test ./lint ./yamlindex ./highlight/semantics ./report. Check valid fixture diagnostic/fix bytes are unchanged, not only parser acceptance.
- [ ] Step 4: Self-review and commit exact paths as refactor(yamlindex): share lexical source locations. Document any consciously preserved projection difference.

## Final integration and delivery

- [ ] Run make build (includes make check) and the optional read-only Saltbox/Sandbox corpus test.
- [ ] Compare current machine diagnostics and planned fix bytes with frozen pre-change results for both corpora; consumer sources remain unchanged.
- [ ] Run final independent integration review over all new commits, including each task's report and any deferred findings.
- [ ] Inspect every new commit subject and final git status. Preserve task and review evidence; report the implemented changes, measured limits and validation.
