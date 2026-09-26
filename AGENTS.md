# Saltbox Lint contributor guidance

## Every workflow

- Explicit user instructions and repository scope take precedence over skill
  defaults. Preserve approvals already given; remote mutations still require
  authorization for the action and target.
- Select skills relevant to the current task or explicitly requested by the user.
- For code or build work, read `.agents/stack-context.md`; use `detect-stack`
  when project context is missing, stale, or affected by stack changes. In
  planning mode, report discoveries without writing files.

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
- Implementation covers this repository and local validation. Pushes, tags,
  releases, remote workflow execution, and consumer-repository mutations need
  explicit authorization for the action and target.
