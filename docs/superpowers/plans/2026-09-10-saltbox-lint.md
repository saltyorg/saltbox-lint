# Saltbox Lint Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Goal: Deliver the approved standalone Saltbox linter, explicit safe fixes, and editor/CI adapters.

Architecture: Shared source analysis in lint supplies built-in rule functions and
verified edits. cmd owns invocation and report owns presentation. Source bytes
are preserved; production code never delegates policy to Python or Ansible.

Tech Stack: Go 1.27.1, Cobra v1.10.2, goccy/go-yaml v1.19.2, Go testing.

Spec: docs/superpowers/specs/2026-09-10-saltbox-lint-design.md

## Global Constraints

- Go 1.27.1; module github.com/saltyorg/saltbox-lint; Cobra CLI;
  github.com/goccy/go-yaml for YAML token/AST parsing; GPLv3.
- Linux amd64 and arm64 binaries; Linux, WSL, and Remote SSH editor usage.
- One shared enforced policy; no per-repository rule configuration in v1.
- Single-file commands report only findings whose primary location is selected.
  Reading required context is allowed; related locations explain a finding.
- Fix violations only; preserve already-valid formatting byte-for-byte.
- No Python, Ansible, template execution, or lookup execution at lint runtime.
- Preserve optional local, gitignored examples.yaml; automated tests use
  committed regression fixtures in lint/testdata.
- Consumer repositories are read-only validation inputs. No role execution,
  consumer edits, pushes, tags, releases, or remote workflow mutations.
- Work directly on main in the primary checkout, explicitly authorized by user.
- Read AGENTS.md and the required skills. Use test-first behavioral changes,
  scoped Conventional Commits, and independent controller-dispatched review.
- Implementers do not dispatch subagents or reviewers. Each report includes
  actual RED/GREEN evidence, exact verification commands, and changed files.

## Shared contracts

Byte spans are half-open UTF-8 offsets into Source.Data. User-facing positions
are one-based; Position uses Unicode code points and rendering adapts columns
for VS Code's UTF-16 interpretation. File identities use root-relative slash
paths. A single invocation belongs to one discovered/explicit source root.

Task 1 defines these concrete types in lint/model.go:

    type Span struct { Start, End int }
    type Position struct { Line, Column int }
    type Node struct {
        Kind, Value, Style, Tag, Anchor string
        Span Span
        Entries []Entry
        Items []*Node
    }
    type Entry struct { Key, Value *Node }
    type Source struct {
        Path string
        Data []byte
        Kind Kind
        Role, RolePath string
        Documents []*Node
    }
    type Kind string
    type RelatedLocation struct { Path, Message string; Span Span }
    type Edit struct { Span Span; Text string }
    type Fix struct { Message string; Edits []Edit }
    type Diagnostic struct {
        Path, RuleID, Severity, Message, Expected string
        Span Span
        Related []RelatedLocation
        Fix *Fix
    }
    type Rule struct {
        ID, Summary, Explanation, GoodExample, BadExample string
        Kinds []Kind
        Scope string
        Fixable bool
        Check func(*Project, *Source) []Diagnostic
    }
    type Project struct {
        Root, Name string
        Sources map[string]*Source
        Selected map[string]bool
        Diagnostics []Diagnostic
    }
    type Options struct {
        Root string
        Paths []string
        StdinFilename string
        Stdin []byte
    }
    type Change struct { Path string; Before, After []byte }

Node kinds: mapping, sequence, string, bool, number, null, alias. Preserve tags,
anchor names, and block/flow/quoted scalar styles. Kind constants: Generic,
Defaults, Tasks, Handlers, Vars, Inventory, Playbook, Template. Source can carry
private parse bookkeeping in addition to these fields; parser-library internals
stay inside lint. Node.Get(key) and Source.Position(offset) are nil/bounds-safe
read helpers. Parser errors attach to Source without becoming fake clean input.

The scope field documents the context a rule needs; checkers are invoked for
each applicable parsed source. Analyze filters and deduplicates returned
diagnostics by primary selected path and sorts by path, span, rule ID, message.
Malformed context is only relevant when a checker actually depends on it.

## Task 1: Shared source model, discovery, and evaluation

Files: lint/model.go, lint/source.go, lint/discovery.go, lint/engine.go,
lint/source_test.go, lint/discovery_test.go, lint/engine_test.go; go.mod/go.sum.

Consumes: existing module scaffold and approved shared contracts.
Produces:

    func Parse(path string, data []byte) (*Source, []Diagnostic)
    func Load(ctx context.Context, opts Options) (*Project, error)
    func Analyze(project *Project, rules []Rule) []Diagnostic
    func (n *Node) Get(key string) *Node
    func (s *Source) Position(offset int) Position

- [ ] Write parser/classification tests first. Concrete cases: a quoted
  multiline Jinja scalar, CRLF and a non-BMP character before a token,
  nested defaults path roles/example/defaults/sub/main.yaml, block scalar
  with '# literal content', anchored mappings/aliases, !unsafe and !vault tags,
  duplicate keys, incomplete quoted YAML. Assert preserved Data, semantic
  values, exact source spans, source kinds/role identity, and located errors.
- [ ] Run go test ./lint and record the expected RED result.
- [ ] Adapt goccy tokens/AST into the shared model. Map library coordinates
  through original bytes, preserving scalar boundaries and not reserializing.
  Read scalars only from real syntax nodes so YAML comments are not expressions.
- [ ] Test directory and explicit-file loading in temporary Git repositories:
  ignored untracked vars excluded, tracked modified file included, untracked
  nonignored YAML included, explicit ignored YAML accepted, missing/unsupported
  target rejected, source directory without Git supported, empty selection
  rejected, duplicate targets deduplicated, stdin bytes override one identity.
  A selected task loads its role's defaults/tasks/handlers/vars/templates as context, but only
  the selected file is marked Selected. Shared Docker resources load siblings
  when needed. Whole-project selection loads all conventional sources.
- [ ] Implement Load with context cancellation and operational errors. Infer
  root from explicit --root, otherwise the target's enclosing project/Git root
  or containing directory for standalone YAML. Name projects saltbox/sandbox
  from their root playbook; canonical resource exemptions require saltbox.
- [ ] Test Analyze with small actual checker functions returning diagnostics:
  select primary file only, retain explanatory related locations, skip invalid
  parsed input for structural checkers, deterministic order and deduplication.
- [ ] Run go test ./... and go vet ./...; self-review; commit only task files.

## Task 2: Jinja structural analysis, layout, and safe edits

Files: lint/jinja.go, lint/jinja_layout.go, lint/fixes.go, lint/rules.go,
lint/jinja_test.go, lint/jinja_layout_test.go, lint/fixes_test.go,
lint/testdata/jinja/*.

Consumes: Source/Node spans, Project, Rule, Diagnostic, Edit, Change from Task 1.
Produces:

    type Token struct { Kind, Text string; Span Span }
    type Expression struct { Kind string; Span Span; Tokens []Token; Complete bool }
    type Argument struct { Name string; Tokens []Token }
    type Call struct { Name string; Span Span; Arguments []Argument }
    func Expressions(source *Source) []Expression
    func Calls(expression Expression, name string) []Call
    func Rules() []Rule
    func PlanFixes(project *Project, diagnostics []Diagnostic) ([]Change, error)
    func WriteChanges(project *Project, changes []Change) error

Rules initially registers the three implemented rules below, with full metadata;
subsequent tasks add family entries without modifying engine/report behavior.
Expression spans include delimiters, tokens retain exact source offsets.
Calls recognizes nested calls and top-level named/positional argument boundaries.

- [ ] Add RED fixtures for jinja-layout, jinja-conditional-length, and
  lookup-conditional-argument. Port the intended cases of legacy checks 1, 2,
  23-29, including conditional nesting, lookup boundaries and closing braces.
  Read the legacy implementations and the existing regression cases as source
  evidence; do not mechanically duplicate their line/quote-state bugs.
- [ ] Capture the supplied first-if case in committed regression fixtures;
  keep the user's optional examples.yaml local and outside automated tests.
  Expected output moves its outer if onto a new line aligned with outer else;
  nested if/else retain alignment under the else value. Already-valid input is
  identical after PlanFixes; a second correction run proposes zero changes.
- [ ] Implement quote-aware tokenization with delimiter nesting, complete
  expression spans, raw/comment handling, and conditional ownership. Ignore
  YAML/Jinja comments and !unsafe text; distinguish output and statement tags.
  YAML escape/folding source mapping must retain token identity for fix checks.
  Incomplete live expressions produce a diagnostic, never a speculative fix.
- [ ] Implement one shared layout analysis for operators, nested if/else,
  ordinary function arguments, dict keys, multiline lookup arguments, block
  expression indentation, and closing delimiters. Wholly inline conditional
  expressions over 160 characters are flagged. Lookup arguments containing
  unquoted conditionals are flagged independently of layout.
- [ ] Add exact fix preservation tests: string literals containing keywords,
  braces and escaped quotes; composed URL/credential template segments; CRLF;
  comments; block scalar styles; tags/anchors; overlapping proposed edits;
  unsupported/incomplete/raw constructs; already-correct alternative layouts.
- [ ] PlanFixes combines only nonconflicting proven edits per selected source,
  reparses the candidate, compares semantic YAML shape/scalar styles/tags,
  unchanged literal segments and exact Jinja tokens/string values, and verifies
  that rerunning layout analysis requires no more edits. Decline uncertain
  corrections and keep their hints. WriteChanges checks original file contents,
  preserves modes, rejects symlink writes, and atomically replaces each file.
- [ ] Run go test ./... and go vet ./...; self-review; commit only task files.

## Task 3: Defaults, role lookups, images, and endpoint policy

Files: lint/rules_defaults.go, lint/rules_web.go, lint/rules.go,
lint/rules_defaults_test.go, lint/rules_web_test.go, lint/testdata/defaults/*.

Consumes: the shared YAML and Jinja models, Calls, and existing registry.
Produces: eight registered rules with shared analysis and no source writes:
role-variable-prefix, defaults-sections, computed-default-documentation,
role-lookup-target, role-docker-state, docker-image-contract,
role-web-contract, role-var-empty-default.

- [ ] Write positive/negative fixtures for legacy checks 3, 5-7, 9-10, 12, 19,
  and 38. Assert ID, primary source span, useful expected form, and no unsafe fix.
  Run focused tests RED before implementing each policy.
- [ ] Read the corresponding legacy methods to retain their exact supported
  endpoint families, role_web schemes/host fallback, section ordering,
  documentation directives, and default_if_empty fallback conditions.
- [ ] Use parsed top-level declarations in each defaults file. Derive role
  ownership from classified paths, including nested defaults and resource roles.
  Require explicit role= for both role_var and role_web. Cross-role targets are
  valid; do not guess or rewrite the target.
- [ ] Merge direct subdomain/domain joining with canonical role_web policy and
  suppress duplicate findings for the same endpoint defect. Image declarations
  require repo/tag companions and corresponding explicit role_var reads.
- [ ] Include cases with misleading comments/quoted strings, empty optional
  defaults, legitimate cross-role targets, incomplete endpoint families,
  absent unrelated Docker/Traefik sections, and source-header-bearing examples.
- [ ] Run go test ./... and go vet ./...; self-review; commit task files.

## Task 4: Docker aggregates, healthchecks, and allowances

Files: lint/rules_docker.go, lint/rules_healthcheck.go, lint/rules.go,
lint/rules_docker_test.go, lint/rules_healthcheck_test.go,
lint/testdata/docker/*.

Consumes: shared declarations, Jinja calls/tokens, source comment locations.
Produces: docker-aggregate-contract, docker-empty-layers,
docker-healthcheck-shape, docker-healthcheck-mode, lint-directive.

- [ ] Write RED positive/negative fixtures for legacy checks 4, 8, 11, 13-14,
  30-32. Read their legacy implementations for supported network variants and
  meaningful-extra-source exceptions before implementing.
- [ ] Check explicit default-before-custom Docker lookups; standard/common
  network composition and interface-pinned variant with uniqueness; role-local
  host composition; final-only env-custom access, including forbidden direct
  variable access and access from the wrong aggregate/role.
- [ ] Detect redundant empty default/custom pairs without flagging networks or
  aggregates with meaningful additional input. Keep deletion diagnostic-only.
- [ ] Validate healthcheck block lists: CMD executable plus optional argv,
  CMD-SHELL exactly one nonempty command, NONE alone. Quoted 'null' is a string;
  unquoted null/empty collections are invalid command values.
- [ ] Require exact '# saltbox-lint allow cmd-shell' on the test key for shell
  mode. Validate unknown/malformed/misplaced/unnecessary directives independently.
  Text inside quoted commands is not a directive. Allowance never hides invalid
  shape or Jinja defects. Shape/mode remain distinct diagnostic policies.
- [ ] Cover flow lists, folded command strings, typed scalars, fake key names in
  shell payloads, wrong-target env lookups, extra network branches, and repeated
  generic/specialized findings. No automatic semantic changes.
- [ ] Run go test ./... and go vet ./...; self-review; commit task files.

## Task 5: Structural Ansible tasks and shared-resource ownership

Files: lint/tasks.go, lint/rules_ansible.go, lint/rules_resources.go,
lint/rules_docker_policy.go, lint/rules.go, corresponding *_test.go files,
lint/testdata/ansible/*.

Consumes: parsed YAML sources, project identity/context, Jinja tokens/calls.
Produces: docker-helper-arguments, network-health-contract,
cloudflare-auth-contract, svm-github-api-resource, git-clone-resource,
ansible-tag-name, ansible-static-import, role-directory-name,
ansible-source-header, docker-vars-policy.

- [ ] Write RED valid/invalid fixtures for legacy checks 17, 20-22, 33-37,
  39-40. Read the named legacy implementations; inspect real helper consumers.
- [ ] Normalize actual play/task/handler structures, including nested
  block/rescue/always, action/local_action string/mapping forms, short module
  names and FQCNs. Arbitrary YAML mappings and shell/block strings are not tasks.
- [ ] Require literal kebab-case string tags, retaining quoted string values
  and rejecting dynamic/YAML typed tags. Reject static imports with the precise
  include alternative. Validate snake_case role paths and ordered source
  headers only in role defaults/tasks/handlers/vars, not payloads/templates.
- [ ] Validate lifecycle helper var_prefix and network health source/target
  inputs from the actual include task's vars (not adjacent text). The shared
  health resource cannot depend on caller-local Docker facts.
- [ ] Restrict Git/SVM ownership to exact canonical resources in Saltbox;
  equivalent suffixes in other paths or Sandbox do not receive exemptions.
  Use the full legacy git ownership contract, including action variants.
  SVM analysis must distinguish variable reads from attributes/filter names,
  binding positions, raw regions and comments, retaining macro-default reads.
- [ ] Enforce normalized Cloudflare reads on real source expressions. Build
  shared Docker omit/default/required declarations and verify conflicting
  policies and sparse fallback accesses against the full relevant resource set.
- [ ] Test headers with extra metadata, multiline fields, task-looking payloads,
  nested source paths, invalid contextual input, duplicate annotations, and
  single-file selection while reading needed sibling policy declarations.
- [ ] Run go test ./... and go vet ./...; self-review; commit task files.

## Task 6: Traefik declarations, adapters, and renderers

Files: lint/rules_traefik.go, lint/rules.go, lint/rules_traefik_test.go,
lint/testdata/traefik/*.

Consumes: source declarations, actual role tasks/templates, normalized calls.
Produces: traefik-api-contract, traefik-adapter-contract,
traefik-renderer-contract; final catalog contains exactly 29 policy rules.

- [ ] Write RED positive/negative fixtures for legacy checks 15, 16, 18:
  missing API defaults, default/custom ordering, legacy names, complete and
  incomplete namespaced forwarding, Docker-label rendering, legitimate
  non-Docker rendering, and missing renderer contract consumption.
- [ ] Share the API suffix contract across declaration/adapter/rendering checks
  while retaining separate rule IDs and actionable locations. Use actual task
  argument/default evidence; arbitrary tokens in comments do not establish
  forwarding. Retain real supported legacy/deprecated renderer exceptions.
- [ ] Keep primary locations on the file owning the defect and supporting
  references in Related. Test selected task/default/template context reporting
  against full-project results: unrelated primary files remain filtered.
- [ ] Add catalog completeness/unique-ID tests, and prove every registered
  rule has explanation, good/bad examples and at least one failing/passing case.
- [ ] Run go test ./... and go vet ./...; self-review; commit task files.

## Task 7: Command surface and shared presentation

Files: main.go, cmd/root.go, cmd/check.go, cmd/rules.go, cmd/*_test.go,
report/report.go, report/human.go, report/json.go, report/github.go,
report/diff.go, report/*_test.go, go.mod/go.sum.

Consumes: Load, Analyze, Rules, PlanFixes, WriteChanges, shared diagnostics.
Produces: executable CLI and report formatting without policy duplication.

- [ ] Write RED in-process Cobra factory tests for every specified invocation.
  Use actual temporary YAML sources; capture stdout/stderr and exit codes.
  Missing path/bad flags/invalid combinations return 2; findings return 1;
  clean input and successfully fixed input without other findings return 0.
- [ ] Implement NewRootCommand with injected streams and a Run helper returning
  the exit code; main only wires cancellation/streams and exits once.
  Default check paths to '.', support --root, stdin filename, human/concise/
  json/github output, --fix and --diff, rules explanation, and --version.
- [ ] Human diagnostics include source excerpts and concrete expected forms.
  Concise records are stable path:line:column: severity [rule] message records
  suitable for VS Code; correctly convert non-BMP columns to UTF-16 there.
  JSON exposes lowercase documented fields, position ranges and optional edits.
  GitHub output escapes command properties/messages and appends a bounded,
  escaped job summary on both clean and failing checks.
- [ ] Test all renderers describe the same findings, Unicode/range conversion,
  percent/CR/LF/comma/colon/path escaping, nested checkout annotation paths and
  commit-specific links, duplicate target handling, and clean structured stdout.
- [ ] --diff outputs unified changes without writes; --fix verifies original
  bytes, applies selected changes, and rechecks before reporting remaining
  diagnostics. Reject --fix/--diff with stdin, both flags together, and
  --diff with structured output. Remaining unfixable findings still exit 1.
- [ ] Run go test ./..., go vet ./..., and a real binary smoke check on a copy
  of the committed first-if fixture. Self-review and commit task files.

## Task 8: GitHub Action, VS Code tasks, packaging, and contributor docs

Files: action.yml, action/install.sh, action/run.sh, action/action_test.go,
examples/vscode/tasks.json, examples/github/*.yml, .goreleaser.yaml,
.github/workflows/ci.yml, .github/workflows/release.yml, Makefile,
.golangci.yml, README.md, docs/research.md, docs/rule-migration.md,
docs/rule-authoring.md, .agents/stack-context.md.

Consumes: stable CLI from Task 7; use exact command contract in all adapters.
Produces: locally tested install/run integration, snapshots, examples and docs.

- [ ] Write RED shell integration tests driven by Go testing. Fixture downloads
  live behind a local HTTP server; test exact release validation, checksums,
  corrupted downloads, unsupported platform, paths with spaces, multiple paths,
  findings vs operational errors, working directories, and no shell evaluation.
- [ ] Composite Action takes required exact version, working-directory='.',
  newline-separated paths='.'. Install the correct Linux amd64/arm64 binary
  into runner temp, verify exact checksum file entry, and invoke check with
  --format github. Script implementation exposes only narrow testable download
  transport overrides; no arbitrary executable command strings or eval.
- [ ] Ship VS Code process tasks for current saved file, workspace, and explicit
  current-file --fix. Use concise output and a tested problem matcher. Document
  save requirements and WSL/Remote SSH use; examples are not installed into
  consumer repositories by this task.
- [ ] Add GoReleaser Linux amd64/arm64 archives/checksums, CGO_ENABLED=0,
  version metadata and go install support. Add non-mutating make check and
  check-before-build make build. Pin golangci-lint, actionlint, GoReleaser and
  workflow actions to verified versions. CI uses the same gates. Release
  definitions can publish on an explicitly pushed version tag in future;
  perform only local snapshot packaging now.
- [ ] Document command/output/exit contracts, conservative fixes, all 40-to-29
  mappings, primary-source linter/editor research, and a concrete rule-authoring
  example tied to a real registry entry. Include all four consumer migrations
  preserving the Saltbox facts test and nested Sandbox checkout annotation path.
- [ ] Validate make check, make build, Action harness, task JSON/matcher and
  snapshot packaging; update stack context to actual gates. Commit task files.

## Task 9: Real-corpus acceptance and integrated remediation

Files: lint/corpus_test.go, lint/testdata/regressions/*, docs/acceptance.md,
and the source/tests implicated by evidenced acceptance defects.

Consumes: complete CLI/rules/integrations and read-only Saltbox/Sandbox sources.
Produces: full acceptance evidence and any minimal tested fixes.

- [ ] Record source revisions, linter blob, dirty-file state, Go/tool versions,
  exact commands and exit results in local evidence. Optional corpus tests take
  explicit environment paths; default tests require no external checkouts.
- [ ] Run the old Python linter on both corpora with GitHub output env unset,
  then the new CLI. Attribute differences to broader scope, approved layout
  correction, or evidenced parser/policy bugs; do not outcome-filter evidence.
- [ ] For each real defect in the new linter, add a focused RED fixture, fix it,
  and rerun the affected checks. Never mutate either consumer or examples.yaml.
  Compare selected-file findings with full-run findings filtered by primary
  path, stdin identity with disk, and valid-source no-op fixes.
- [ ] Confirm exact 29-rule coverage and all 40 legacy intent mappings. Run
  make check, make build, user-example fail/preview/fix/pass/no-op on a copy,
  Action harness, and GoReleaser snapshot. Inspect every local commit subject.
- [ ] Write accurate acceptance documentation distinguishing real GitHub runs
  from local emulation and any new consumer findings. Self-review and commit.

## Completion

The controller dispatches a final whole-change reviewer with the original base,
complete diff, accepted spec, acceptance evidence, and parked/deferred findings.
Fixes get a separate implementer and scoped re-review. Resolve material gaps,
run fresh required verification, preserve the user's example bytes, and hand
back the completed local repository without remote mutations.
