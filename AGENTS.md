# Saltbox Lint contributor guidance

## Every workflow

- Load `superpowers:using-superpowers` at the start of every workflow and
  follow the applicable Superpowers process skills. Superpowers workflows are
  required, including planning, test-driven development, systematic debugging,
  independent review, and verification before completion where applicable.
- Implement accepted multi-step plans with
  `superpowers:subagent-driven-development`: fresh implementers with focused
  task briefs, independent specification and code-quality review, and a final
  integration review. Required subagent work must not be replaced by
  controller-only implementation. Coordinate writes in this shared checkout
  sequentially and retain task and review evidence across interruptions.
- Use the existing Superpowers installation. If its skills are not exposed to
  the session, report that visibility limitation accurately and resolve the
  skill sources; absence from a session's catalog does not establish that the
  plugin is uninstalled. The upstream entrypoint is
  https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md.
- Explicit user instructions and repository scope take precedence over skill
  defaults. Preserve approvals already given; remote mutations still require
  authorization for the action and target.
- Apply these skills in every workflow: `detect-stack`, `kiss`, `dry`, `solid`,
  `yagni`, `separation-of-concerns`, `law-of-demeter`, `boy-scout-rule`, and
  `convention-over-configuration`. Read their installed `SKILL.md` instructions
  and apply the principles to the work at hand.
- If one of these nine skills is unavailable locally, read its
  `skills/<skill-name>/SKILL.md` from
  https://github.com/JordanCoin/codingskills before proceeding. This is the
  upstream fallback source for the required coding-principle skills.
- Read `.agents/stack-context.md`; use `detect-stack` to refresh it when missing,
  stale, or affected by stack changes. In planning mode, report discoveries
  without writing files.

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
- Treat `examples.yaml` as the user's collection of failing examples. Preserve
  its contents during implementation and run fix validation on copies.
- Validate against Saltbox and Sandbox without editing or executing their roles.
  Record intentional coverage differences instead of weakening rules to obtain
  a clean corpus result.

## Validation and delivery

- `make check` is the non-mutating quality gate; `make build` runs it before
  building. Keep local and CI checks aligned and tool versions pinned.
- Use standard Conventional Commits with concise lowercase imperative subjects.
  Use `fix(<scope>):` when correcting broken behavior.
- Preserve unrelated user changes and stage exact paths when committing.
- Implementation covers this repository and local validation. Pushes, tags,
  releases, remote workflow execution, and consumer-repository mutations need
  explicit authorization for the action and target.
