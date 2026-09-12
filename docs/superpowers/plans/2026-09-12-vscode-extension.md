# Portable VS Code Extension Implementation Plan

> Agentic workers: use superpowers:subagent-driven-development, fresh implementers,
> independent specification/quality review per task, and final integration review.

**Goal:** Implement the user-approved portable extension, verified broader YAML
formatter, local VSIX packages and publication preparation without regressing CLI
performance. The approved design below is the binding spec for these tasks.

**Architecture:** A TypeScript workspace extension invokes the bundled CGO-free Go
CLI. Go owns lint policy, formatting and verification. The extension owns process
lifecycle, diagnostics, editor coordinates and edits. No persistent server.

**Tech stack:** Existing Go/parser dependencies; pinned Node/TypeScript/esbuild,
VS Code stable APIs, extension-host tests and vsce. Keep new dependencies minimal.

## Global Constraints / Approved Design

- Work in this repository; consumers /srv/git/saltbox and /opt/sandbox are read-only.
  Never execute consumer roles. examples.yaml is ignored user scratch, never edited.
- Preserve existing Linux fast paths and byte-identical existing command output.
  OS-specific implementations are explicitly approved; never replace efficient
  native behavior with a slower universal fallback.
- Six CGO-free Go targets: linux/darwin/windows x amd64/arm64. Eight VSIX targets:
  linux-x64, linux-arm64, alpine-x64, alpine-arm64, darwin-x64, darwin-arm64,
  win32-x64, win32-arm64. Alpine reuses Linux binaries after musl validation.
- Identity: saltyorg.saltbox-lint, subject to publisher namespace availability.
  Microsoft account/publisher access not configured; no credentials needed locally.
- Automatic diagnostics on open/save; manual file/workspace checks. YAML/Ansible
  workspace documents supported. No while-typing checks, persistent daemon, web
  extension or virtual workspace support in v1.
- Quick fixes, document Fix All and Format Document are required. Register a
  formatter but never change default formatter or enable format-on-save. Users
  opt into VS Code's own format-on-save setting.
- Remote SSH/WSL/Dev Containers execute beside workspace files: extensionKind
  workspace. Disable operation in untrusted workspaces using built-in trust.
- One lint process and one formatting process maximum per extension host. Coalesce
  duplicate requests, keep latest pending snapshot per document, cancel superseded
  work and discard stale results. No orphaned descendants after cancellation.
- Workspace folder is explicit source root with a folder-scoped root override.
  Support multi-root. Check workspace means saved files; don't overwrite dirty
  document results from disk checks. Recheck document hash/version before edits.
- JSON check schema v2 and shared fixes remain unchanged. Preview is never an edit.
  Runtime launches bundled executable directly, shell:false, windowsHide:true.
- No telemetry, runtime downloads, Python/Ansible runtime or runtime formatter JS
  dependency. Git remains required for repository-aware discovery.
- Existing check --fix stays conservative whitespace-only. Broader canonical
  formatting has its own read-only command and explicit verification boundary.
- Canonical formatting: two-space indented block collections for nonempty lists
  and mappings, {} / [] retained for empty collections; normalize structural
  spacing. Preserve safe existing plain strings/task names. Convert only simple
  quoted strings to double quotes; mixed quotes, escapes and Jinja inner quote
  choices remain protected. Example `message: 'He said "hello"'` stays unchanged.
- Include existing verified Jinja layout and section-spacing fixes. Preserve
  token contents, whitespace-control markers, mapping/sequence order, typed
  scalar values, anchors/aliases/merges/tags, document markers and comment
  attachment. Multiline scalar styles, chomping, literal data, line endings and
  final-newline state are preserved. No general line wrapping or blank-line
  collapse. Already canonical inputs must be exact no-ops.
- Generate targeted source edits from tokens/CST, not generic-map serialization.
  Verify candidates independently through both existing parsers, typed structure,
  protected comments and exact scalar values except narrowly verified existing
  Jinja whitespace. Unsupported/ambiguous/invalid documents return no edits and a
  reason. Require idempotence and no new non-formatting violations.
- Read-only endpoint: format --stdin-filename PATH --mode canonical|lint-fixes -.
  JSON response fields: schema_version:1, path, source_sha256, status
  (ready|unchanged|skipped), edits (existing report edit shape), reason for skipped.
  canonical is default. lint-fixes calls existing analysis + PlanFixes to combine
  verified fixes. Optional --root has check's meaning. Operational errors stderr,
  exit 2; successful/unchanged/skipped plans exit 0. Never write source files.
- UTF-8/code-point Go coordinates translate to zero-based UTF-16 editor coordinates
  against the exact snapshot. Return small TextEdits / WorkspaceEdits with undo.
- make check remains non-mutating; make build authoritative. Local commits use
  Conventional Commits and exact staging. Remote writes, publisher registration,
  agreement acceptance and publication need separate explicit authorization.
- Preserve task/review evidence across interruptions. Native execution that is
  unavailable here must be reported accurately, with CI gates prepared; neither
  cross-compilation nor mocks count as native platform acceptance.

## Task 1: Portable process input and terminal boundaries

Own root input*.go/main.go, cmd/terminal*.go and affected native test harnesses.
Consume existing processInput reader lifecycle and theme query contract; produce
the same behavior with build-tagged Linux, Darwin and Windows implementations.

- Preserve Linux /proc reopening, socket per-read flags, cancellation joins,
  regular-file offsets, lazy setup, caller descriptor ownership and bounded OSC
  query behavior. Keep shared protocol parsing separate from OS syscalls.
- Implement native macOS readiness/cancellation and correct termios requests;
  Windows inherited pipe/file/console handling and cancellable native reads.
  Do not adopt a console-only cancelreader for pipes or flush user console input.
- Native implementations must restore console modes and release owned resources.
  Use platform-specific signal lists where needed. JSON must not probe terminals.
- Native subprocess cancellation must not leak children. Audit filesystem path
  and replacement portability; fix demonstrated defects without relaxing safety.
- Split Unix-only socket/fcntl tests from common tests. Replace Linux script -qec
  assumptions with platform-specific terminal harnesses. Record native limitations.
- TDD: failing cross-build/native behavior tests, then implementation. Run focused
  tests while iterating, root suite and six CGO-free cross-builds before commit.
- Commit and report exact commands, RED/GREEN evidence and remaining native gates.

## Task 2: Verified canonical formatting engine

Own a focused formatting package and narrow shared parser/fix helpers in lint.
Consume existing source indexing, Jinja layout and section spacing. Produce a Go
API that plans canonical edits and reports unsupported syntax without source writes.

- Implement the full formatting policy in Global Constraints, using source/CST
  ownership. Separate candidate construction, equivalence verification and edit
  planning into focused files. Preserve shared parsing knowledge; don't weaken
  the existing whitespace-only WriteChanges/PlanFixes verification contract.
- Protect comments/directives by semantic attachment, not merely comment counts.
  Compare both parser representations; preserve scalar type/value, aliases and
  anchor relationships. Reject unsupported transformations with explicit reasons.
- Supported ordinary YAML must actually normalize indentation, flow collections
  and simple quotes; don't substitute a no-op blanket refusal for implementation.
- Include existing Jinja and section fixes, verify whole candidate and idempotence.
  Don't run unrelated full-project rule discovery for canonical formatting.
- TDD fixtures: ordinary block/flow nesting, empty containers, simple/plain/mixed
  quotes, escapes, type ambiguities, Jinja literals/control delimiters, literal and
  folded blocks/chomping, comments/directives, anchors/merges/tags, multiple docs,
  Unicode and LF/CRLF/EOF. Invalid/uncertain cases must yield zero edits.
- Commit with exact test evidence and exported API documented in the report for
  Task 3. The package structure/API may follow existing Go idioms; policy is fixed.

## Task 3: Read-only verified edit CLI

Own cmd format command, machine response rendering, root command registration and
CLI documentation/tests. Consume Task 2's API and existing PlanFixes; produce the
endpoint and exact JSON fields/status/exit semantics from Global Constraints.

- Require exactly one stdin selection and filename; validate mode/root before
  consuming input. Retain input ownership/cancellation behavior from Task 1.
- lint-fixes selects current snapshot and required context, combines fixes with
  existing Go planner, and returns a verified nonconflicting source-edit union.
- canonical formats only supplied document with source-kind identity. Hash exact
  input; return small edits using existing range/span conversion semantics.
- Distinguish operational failure, skipped, unchanged and ready. No ANSI/progress
  on JSON stdout. Never alter ordinary check output or broaden check --fix.
- TDD public CLI tests for both modes, statuses, unsafe/invalid documents,
  hash/Unicode positions, stale-relevant identity, conflicting fixes, cancellation,
  error channels and no disk writes. Document machine schema and quoting policy.
- Commit and report exact consumer contract and test results.

## Task 4: VS Code editor integration

Own extension/ TypeScript source, manifest, lockfile, unit/integration tests and
development configuration. Consume existing check JSON v2 and Task 3 edit JSON v1.
Packaging/release scripts and CI integration belong to Task 5.

- Implement all editor behavior in Global Constraints. Bundle minimal TS with
  esbuild (vscode external); stable APIs, explicit engine floor and corresponding
  pinned types, modern supported Node build pin and lockfile.
- Separate pure protocol/coordinates, subprocess scheduler and VS Code adapter.
  Documents selected by YAML/Ansible language and .yml/.yaml workspace paths.
  Resolve multi-root source identity and related locations safely.
- Commands: check document, check workspace, Fix All current document. Diagnostics
  auto open/save; current snapshot for manual checks. Shared per-file quick fixes
  label scope truthfully. Fix All uses lint-fixes; formatter uses canonical.
- Protect shared-fix lookup and ranges, validate response schemas and input hashes,
  reject malformed/conflicting/out-of-bounds edits. No source write via CLI.
- Bounded priority queues; formatting stays responsive to its cancellation token.
  Subprocess lifecycle includes POSIX process groups and native Windows tree
  termination without shell interpolation or visible console windows.
- Clear/refresh stale diagnostics coherently on changes, close, rename and root
  changes; saved workspace scans cannot replace dirty snapshot diagnostics.
- Native trust gate, no telemetry/downloads, no configuration auto-rewriting.
- TDD pure protocol/scheduler tests and real extension-host tests: editor diagnostics,
  quick fixes, formatting, undo/redo, unsaved changes, Unicode, multi-root, malformed
  responses, cancellation/cleanup and coexistence. Use actual bundled test binary
  for acceptance rather than only mocks. Record unsupported host availability.
- Commit and report tests and dependency pins.

## Task 5: Packaging, native CI and Marketplace preparation

Own release/build tooling, CI, extension packaging scripts/docs and notices. Consume
all earlier runtime interfaces. Produce local eight-target VSIX packages and source
archive; no publishing or authenticated remote mutations.

- Extend GoReleaser for six targets and Windows zip archives; package one matching
  binary per platform VSIX, Alpine reuse. Package on Linux, verify executable bits.
  Deterministic explicit inclusion list; inspect packages for secrets/scratch/dev
  dependencies. Include license texts for all shipped code/assets.
- Pin Node, TS/test/bundle tools and vsce; integrate nonmutating TS checks and
  packaging validation into make check/build/snapshot appropriately. Avoid circular
  build/test dependencies; ordinary Go-only source generation stays independent.
- Add commit-pinned CI for native linux x64/arm64, windows x64/arm64, macOS x64/arm64;
  normal tests each, race where supported, real extension-host acceptance and
  packaged-binary tests. Alpine musl native-architecture container tests required.
- Generate release-matched corresponding source with modified Nuri/dependency
  sources and build instructions; attach source provenance/hash to packaged
  notices. Document adjacent no-charge source availability as publication gate.
- Manifest/README: correct identity, supported engine floor, local executable/Git
  disclosure, accurate platform support/limits, privacy (no telemetry), support
  and security reporting, changelog, GPL terms, permitted branding/images/badges.
  Don't invent assets or copy competing editor promotions into marketplace copy.
- Publication checklist covers Publisher Agreement and Participation Policies,
  namespace ownership, Microsoft account, 60-day offering requirement after
  agreement acceptance, supported dependencies, no proposed APIs, install/upgrade/
  disable/uninstall checks, signature/permissions and matching source availability.
- First release manual upload; local work needs no publisher credentials. Document
  exact future targets/actions, requiring authorization. Recheck rules at release.
- Update stack context for new stack; include authoritative source links from spec.
- Run local packaging and available native checks; report unavailable validation
  as pending, never claim Windows/macOS native acceptance from cross-compilation.
- Commit exact changes and report artifacts with hashes/test evidence.

## Task 6: Corpus, semantic and performance qualification

Own focused acceptance harnesses and durable docs/vscode-extension-results.md.
Consume baseline artifacts captured before Task 1 and final code/artifacts.

- Freeze inputs to both consumers without editing/executing roles. Define paired
  benchmark series before running: 10 alternating AB/BA pairs, same tools/host/
  inputs/sinks, preserve all raw samples, no outcome-selected reruns.
- Measure full colored CLI in dark/light, JSON full project, selected stdin, CPU,
  wall time, first output, RSS and targeted shared-analysis/fix allocations.
  Verify exact output bytes for existing modes; reproducible regressions block
  acceptance. Record variance and avoid unjustified universal performance claims.
- Measure canonical formatter separately on representative files <=100 KiB,
  target p95 <500ms. Include generation/verification/coordinate/editor overhead
  where available; record cold/warm context and fixture hashes.
- Read-only corpus semantics: both YAML parsers and pinned actual Ansible loader
  comparisons; controlled Jinja token/render fixtures without executing arbitrary
  lookups. Preserve consumer state, user scratch, valid bytes and idempotence.
- Test repeated editor use resource retention and idle process absence; package
  source rebuild, installation/upgrade/uninstall on available hosts. Native gates
  elsewhere stay explicitly pending rather than fabricated.
- Fix discovered defects through this task's implementer and independent review;
  rerun only affected acceptance after changes. Full make build final gate.
- Record commit-qualified results, artifacts, supported/unsupported cases and
  pending external gates. Commit docs/harnesses, then controller final review.

## Authoritative publication references

- https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- https://code.visualstudio.com/api/references/extension-manifest
- https://code.visualstudio.com/api/advanced-topics/using-proposed-api
- https://code.visualstudio.com/api/extension-guides/workspace-trust
- https://code.visualstudio.com/api/advanced-topics/remote-extensions
- https://code.visualstudio.com/api/language-extensions/programmatic-language-features
- https://aka.ms/vsmarketplace-policies (resolved June 2021 policies during planning)
- https://cdn.vsassets.io/v/M187_20210610.3/_content/Visual-Studio-Marketplace-Publisher-Agreement.pdf
- https://www.gnu.org/licenses/gpl-3.0.html#section6

Marketplace acceptance belongs to Microsoft; implementation delivers qualified
local code and packages with a truthful publication checklist.
