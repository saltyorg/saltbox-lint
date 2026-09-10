# Standalone Saltbox lint design

Approved through the planning conversation on 2026-09-10. The user authorized
implementation on main in the primary checkout. Subsequent changes to product
behavior must remain consistent with these requirements.

## Goal

A standalone, extensible Go linter for Saltbox and Sandbox with shared policy,
broader YAML coverage, actionable expected-format hints, safe explicit fixes,
saved-file/workspace VS Code tasks, and a GitHub Action.

## Global constraints

- Go 1.27.1; module github.com/saltyorg/saltbox-lint; Cobra CLI;
  github.com/goccy/go-yaml for YAML token/AST parsing; GPLv3.
- Linux amd64 and arm64 binaries; Linux, WSL, and Remote SSH editor usage.
- One shared enforced policy; no per-repository rule configuration in v1.
- Single-file commands report only findings whose primary location is selected.
  Reading required context is allowed; related locations explain a finding.
- Fix violations only; preserve already-valid formatting byte-for-byte.
- No Python, Ansible, template execution, or lookup execution at lint runtime.
- Preserve examples.yaml; test fixes on copies.
- Consumer repositories are read-only validation inputs. No role execution,
  consumer edits, pushes, tags, releases, or remote workflow mutations.
- Use Superpowers subagent-driven development with fresh implementers,
  independent task reviews, test-first behavioral changes, and final review.
- Required coding skills and portable contributor guidance live in AGENTS.md;
  host-specific guidance remains outside tracked repository instructions.
- Work directly on main in the primary checkout, explicitly authorized by user.

## Architecture

The root executable calls the cmd package. The lint package owns source loading,
classification, shared syntax analysis, built-in rule registration, evaluation,
and verified edit proposals, split into focused files by responsibility. The
report package renders the shared results. Rules neither print nor write files.
Source bytes remain authoritative for ranges and edits; YAML is never globally
reserialized to apply a formatting correction.

Rules declare identity, source kinds, scope (file, role, shared resource set),
explanation, examples, and fix availability. A new styling rule normally adds a
checker, registration, and positive/negative fixtures. All renderers consume its
diagnostics automatically. The initial rule catalog is not a ceiling.

## Source discovery and context

Directory scans select conventional Ansible YAML under roles and resources/roles
(defaults, tasks, handlers, vars), resources/tasks, root tasks/handlers,
playbooks, inventory/group/host variable directories, and root playbooks
identified structurally. Accept .yml and .yaml. In Git worktrees use Git's
tracked plus non-ignored untracked file list, including modified tracked files;
Git-less source directories use conventional discovery. Explicit YAML targets
can override discovery exclusions and receive applicable checks, including
generic Jinja checks outside a role. Explicit unsupported/missing paths and
empty directory selections are operational errors, never optimistic success.

Read related sources needed by role/shared-resource rules; do not infer runtime
merging of arbitrary defaults files. Task policies inspect tasks, handlers,
nested block/rescue/always lists, and action/local_action forms structurally.
Static payloads and standalone templates receive no general lint policy;
Traefik renderer checks may inspect templates as supporting evidence.

Root identity is the inspected Saltbox/Sandbox project, independent of binary
installation paths. The canonical Git and SVM resource exemptions apply only
to exact resource paths in a Saltbox project, not suffix-matching copies.

## Rules

Preserve the detection intent of the legacy 40 policies, with these 29 IDs:

1. jinja-layout: operator/conditional/function/dictionary alignment, lookup
   argument layout, block Jinja indentation, closing braces.
2. jinja-conditional-length: existing 160-character inline conditional limit.
3. role-variable-prefix: owning-role prefixes for role defaults.
4. docker-aggregate-contract: default/custom ordering plus network, host, and
   environment-specific composition; avoid duplicate generic findings.
5. role-web-contract: canonical endpoint families and direct host composition.
6. docker-image-contract: image repository/tag declarations and lookups.
7. role-lookup-target: explicit role targets for role_var and role_web defaults.
8. defaults-sections: canonical section uniqueness and relative order.
9. computed-default-documentation: immediate supported exclusion directives.
10. docker-empty-layers: redundant empty companions, retaining real exceptions.
11. traefik-api-contract: declarations, ordering, and legacy-name rejection.
12. traefik-adapter-contract: namespaced declarations and task forwarding.
13. docker-helper-arguments: public var_prefix on lifecycle-helper calls.
14. traefik-renderer-contract: non-Docker API contract rendering evidence.
15. role-var-empty-default: canonical default_if_empty fallback interface.
16. docker-vars-policy: declared omit/default/required shared-resource policy.
17. network-health-contract: explicit source/target inputs and helper ownership.
18. cloudflare-auth-contract: normalized authentication interface.
19. lookup-conditional-argument: resolve conditionals outside lookup arguments.
20. docker-healthcheck-shape: marker-specific block-list layout/cardinality.
21. docker-healthcheck-mode: CMD preference, explicit CMD-SHELL allowance.
22. lint-directive: known, correctly placed, necessary allowances only.
23. svm-github-api-resource: canonical resource owns direct SVM use.
24. git-clone-resource: canonical resource owns direct Git actions.
25. ansible-tag-name: literal lowercase kebab-case string tags.
26. ansible-static-import: include_tasks/include_role composition.
27. role-docker-state: shared helper owns container state.
28. role-directory-name: snake_case role directories.
29. ansible-source-header: standard ordered role YAML headers.

Retain exact line-local '# saltbox-lint allow cmd-shell' semantics and the
existing computed-default documentation directives. Malformed source/context
diagnostics are additional engine diagnostics, not catalog policy count.
Rule IDs/messages can change freely in this initial rewrite. Fix evidenced
legacy false positives without losing real detection coverage; record changes.

## Commands and output

Commands: check [paths...], rules [rule-id], --version. check defaults to '.',
accepts --root and stdin with '- --stdin-filename PATH'. Output format choices
are human (default), concise, json, github. Structured stdout has no progress
text. Operational errors/progress go to stderr.

Diagnostics carry rule ID, severity, primary file/range, explanation, expected
form, related locations, and optional verified fix. Human output includes
source and expected-format hints. rules exposes rationale and good/bad examples.
All outputs are deterministic. Exit 0 means clean after requested corrections,
1 means findings remain, and 2 means invocation/I/O/operational failure.
Malformed selected source produces a located finding. Missing required context
must not silently yield a clean result.

check --fix writes only verified safe changes to selected disk files.
check --diff previews the same changes and never writes. The two flags are
mutually exclusive; both reject stdin in v1. Diff output is unified diff on
stdout and diagnostics on stderr; --diff cannot combine with structured output.
Ordinary check never edits source files.

## Formatting safety

Share a Jinja tokenizer/structural layout model between diagnostics, expected
snippets, and corrections. Correct only actual violations: multiline
indentation, wrapped lookup argument layout, multiline conditional first-if
placement and nested branches, and misplaced closing braces. Do not normalize
accepted alternative layouts. Keep long wholly-inline expression wrapping
diagnostic-only unless preservation is established by the same structural model.

Verify identical expression tokens/string literals/whitespace-control markers,
identical template literal segments, equivalent YAML structure and scalar
styles/tags, and unchanged unrelated values. Reparse, recheck, and require
idempotence. Uncertain, incomplete, unsafe-tagged, raw/comment, or unsupported
constructs receive no automatic edit. Never guess a role target, rename tags,
reorder sections, delete declarations, or change a healthcheck's execution mode.

The user's examples.yaml conditional must be rejected even though the legacy
linter accepts it. Its first if moves onto a continuation line aligned with
the outer else, and nested if/else align under the else value. Tests preserve
the original file and validate before/after behavior on copies.

## Integrations

VS Code process tasks: saved current file, workspace, explicit current-file fix.
A concise-output matcher populates Problems. Stdin/JSON support future editor
adapters; no extension or LSP in v1.

Root composite action.yml downloads and checksum-verifies a released binary.
Inputs: required exact release version, working-directory (default '.'), paths
(newline-separated; default '.'). It runs check with GitHub annotations and an
appended job summary, never fixes, preserves errors, and treats paths as data.
Account for checkout-relative annotation paths, including nested Sandbox clones.
GoReleaser produces Linux amd64/arm64 archives and checksums; go install works.
Prepare CI/release definitions but perform no remote publication or dispatch.

Document migration examples for both variants of each consumer workflow.
Saltbox's unrelated Python facts test keeps its Python setup. General Ansible
and YAML validation remain companion tools rather than subprocesses of this
linter. Save cited primary-source research, rule migration, and a rule-authoring
guide with a concrete extension example.

## Acceptance

Test-first fixtures cover all 40 legacy intents, all 29 registered rules,
overlaps, broad YAML source kinds, contextual single-file filtering, stdin,
range mapping (Unicode/CRLF/tabs), YAML aliases/tags/comments, Jinja strings/raw
regions, error reporting, and all output formats. Fix tests assert exact expected
output, preservation, and a no-op second run.

Compare against both current real repositories with revisions and dirty state
recorded in local evidence. Legacy corpus baseline was clean (Saltbox 92
defaults/334 tasks/1 inventory; Sandbox 173 defaults/236 tasks). The 47 local
Python tests are untracked reference coverage, not a complete acceptance suite.
Review new findings instead of weakening rules or editing consumers.

make check performs non-mutating formatting/module checks, vet, pinned lint,
race tests, and workflow/Action validation. make build checks before compiling.
Action fixtures cover download/checksum failures, paths with spaces, nested
checkouts, findings/success exits, and correct summary/annotation escaping.
Snapshot packaging is local evidence, not a claim of GitHub-hosted execution.

Deferred: per-repository policy configuration, runtime rule plugins, external
linter orchestration, extension/LSP, SARIF, unsafe fixes, and remote publication.
