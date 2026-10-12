# Saltbox Lint contributor guidance

## Every workflow

- Explicit user instructions and repository scope take precedence over skill
  defaults. Preserve approvals already given; remote mutations still require
  authorization for the action and target.
- Select skills relevant to the current task or explicitly requested by the user.
- For code or build work, read `.agents/stack-context.md`; use `detect-stack`
  when project context is missing, stale, or affected by stack changes. In
  planning mode, report discoveries without writing files.

## Working document retention

- At each agent handoff and completed plan, inspect disk usage in the external
  task folder and remove released, regenerable dependency installs, caches,
  build trees, extracted packages and temporary source copies. Keep generated
  working files out of the documentation folder where practical.
- Retain plans, research conclusions, decisions, review results, concise
  validation reports, commit/tool identities, artifact hashes, final CI evidence,
  and original failure logs with the small fixtures or scripts needed to
  understand or reproduce them. Keep one authoritative copy of each record.
- Retain a bulky artifact only when it contains evidence or inputs that cannot
  be reconstructed from the recorded commit and pinned tools. Record why it is
  needed and the next handoff or plan completion at which to reconsider it.
  Prefer one compressed copy to duplicate archives and extracted trees.
- Before cleanup, confirm the owning agent has released the files and that the
  retained record is sufficient. Preserve active inputs and unresolved failure
  evidence. Record removed paths and reclaimed space in a concise cleanup log;
  historical manifests must clearly identify intentionally removed working
  files. Routine cleanup of verified task-generated temporary files needs no
  further approval.

## Extension work

- Before editing `extension/` or its build, test, packaging or CI integration,
  read [docs/extension-testing.md](docs/extension-testing.md). Follow the relevant
  upstream [VS Code API](https://code.visualstudio.com/api/references/vscode-api),
  [extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
  and [bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
  instructions for the versions this repository supports.
- Consult [Node documentation](https://nodejs.org/docs/),
  [TypeScript documentation](https://www.typescriptlang.org/docs/),
  [typescript-eslint documentation](https://typescript-eslint.io/rules/) and the
  selected runner's public APIs, including [Mocha hooks](https://mochajs.org/features/hooks/)
  and [VS Code test tooling](https://github.com/microsoft/vscode-test), for the
  behavior being changed. Use versioned documentation or matching upstream
  source when current documentation describes a newer version.
- Use stable public APIs compatible with the declared minimum editor. Treat
  external build/test Node and each editor's embedded Node/Electron as separate
  runtimes; record actual host versions in qualification evidence. Preserve
  existing pins unless a dependency change is part of the authorized task.
- Record consulted source URLs and versions in the task's verification record.
  Explain any upstream deviation or compatibility limit and validate the chosen
  alternative. Microsoft's [test-writing guidance](https://github.com/microsoft/vscode/blob/main/.github/instructions/writing-tests.instructions.md)
  supplies ownership and injection principles; its internal helpers are not
  public extension APIs.
- Test imported behavior with injected dependencies at the appropriate layer.
  Keep real native adapter tests, named Mocha editor cases and installed VSIX
  acceptance for their respective contracts. Preserve the guide's coverage map
  and required runtime/platform coverage. Shared global patches and execution
  of extracted source are not routine regression-test architecture.
- Give each case unique fixtures and explicit ownership of pending operations,
  subscriptions, timers, state changes and child processes. Register cleanup
  during setup and await it after success or failure. Cancellation must join
  admitted work, restore state and prove resource release within a separate
  cleanup budget. A passing assertion, delivered kill signal or runner exit
  does not establish cleanup.
- Verify readiness through observable events or state, with listeners installed
  before triggers. Test failure paths and helper cleanup, measure setup,
  exercise and teardown separately, and retain both operation and cleanup
  failures. Follow the guide's qualification checks before claiming stability;
  retries, extra sleeps, force-exit or reduced coverage cannot establish it.
- Freeze source and dependencies before qualification. Sequence dependency
  installs, source edits and fault injection separately from checks that read
  those inputs, or give each run an isolated verified snapshot. Record input
  identities, preserve failure output and invalidate runs whose inputs changed;
  a successful repeat does not make the original run valid.

## Design and rule development

- Keep command handling, source analysis, rule evaluation, and reporting
  separate. Rules consume shared analysis and return standard diagnostics.
- Register each rule with its identifier, explanation, applicable source kinds,
  context scope, expected-format examples, and fix availability. Adding a rule
  should automatically expose it through the CLI and integration renderers.
- Enforce one shared policy for Saltbox and Sandbox. Selected-file checks may
  read required context, but report only diagnostics whose primary location is
  in a selected file. Fix only violations and preserve already-valid formatting
  byte-for-byte.
- Add valid and invalid fixtures for every policy, including useful hints.
  Share stable parsing and contract knowledge; keep distinct policies distinct.
- Preserve original source positions, comments, scalar styles, and literal
  contents. Formatting fixes require explicit `check --fix`; verify token and
  YAML preservation and idempotence before applying them.
- Keep `examples.yaml` optional, local and gitignored. It is the user's scratch
  collection of cases that should fail; never stage or rewrite it. Automated
  tests and CI must use committed fixtures in `lint/testdata`, not this file.
- Validate against Saltbox and Sandbox without editing or executing their roles.
  Record intentional coverage differences instead of weakening rules to obtain
  a clean corpus result.

## Validation and delivery

- `make check` is the non-mutating quality gate; `make build` runs it before
  building. Keep local and CI checks aligned and tool versions pinned.
- Before telling the user that work is done, commit the intended changes and
  inspect successful CI for the exact final commit. This applies to all work,
  including documentation and CI changes, not only releases. Verify the run's
  commit SHA and every required job and matrix result; a green run for an
  earlier commit or local checks alone do not establish completion.
- Failed, pending, cancelled, missing, or unexpectedly skipped CI means the
  work is incomplete. Investigate failures, make focused fixes, and validate
  the resulting final commit across the full required CI matrix before
  claiming completion. Report the validated commit and CI run link to the user.
- When CI cannot run without an unauthorized push or workflow action, preserve
  the local committed work, report validation as incomplete, and request the
  exact remote action and target needed. This completion policy does not grant
  remote mutation authority. Status updates and handoffs must clearly identify
  outstanding validation rather than describe the work as done.
- Report a release as production ready only after inspecting successful CI for
  the exact release commit and its artifacts: all six native source suites,
  standalone CLI archives, eight VSIX packages (including Alpine probes), and
  installed extension tests at both configured editor versions. Check every
  matrix result; pending, cancelled, skipped, or failed required coverage is
  incomplete. Local Linux checks and cross-compilation alone are insufficient.
- State validation evidence (commit, CI run, artifact identity) and coverage
  exceptions when reporting readiness. Windows arm64 has no Go race runtime;
  Alpine receives packaged CLI probes rather than a full editor host suite.
  Revalidate after changes; never weaken tests or add skips merely to turn CI
  green. Investigate platform failures with focused regressions and rerun all
  affected targets. Branch protection is not required for this agent policy.
- Use standard Conventional Commits with concise lowercase imperative subjects.
  Use `fix(<scope>):` when correcting broken behavior.
- Preserve unrelated user changes and stage exact paths when committing.
- In `saltyorg/saltbox-lint`, the user grants standing authorization to create
  task-related commits and push them to `origin/main`, including corrective
  commits needed for CI. Proceed through push-triggered CI validation without
  asking again for commit or push approval.
- Releases still require the user's input and explicit authorization for the
  version and exact commit. Tags, release publication, manually dispatched or
  rerun workflows, repository settings, and consumer-repository mutations retain
  their separate authorization requirements. Commit/push authority does not
  authorize those actions.
