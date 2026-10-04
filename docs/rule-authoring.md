# Rule authoring

Rules enforce the same policy for Saltbox and Sandbox. Start with a concrete
valid/invalid pair and decide whether the rule can prove the violation from
source alone. The linter never executes Ansible, Jinja templates or lookups.

## Register a rule

Add an entry to `lint.Rules` in [lint/rules.go](../lint/rules.go). Include the
identifier, summary, explanation, applicable source kinds, context scope, and
valid/invalid examples. Rules consume shared `Project` and `Source` analysis and
return standard `Diagnostic` records. Keep command parsing and output rendering
outside rule checkers. The registry supplies CLI rule help automatically.

Use the shared source indexes and expression/parser helpers. Preserve original
UTF-8 byte spans; source positions and renderer-specific columns derive from
those spans. Context-dependent checks may load sibling sources, but report only
findings whose primary location is selected. Include useful Expected guidance
and related locations when another declaration explains the problem.

## Add fixtures

Commit valid and invalid cases under `lint/testdata`, with focused Go tests for
scope, selected-file behavior and guidance. Include malformed or unsupported
source forms that the rule must decline to interpret. The optional local
`examples.yaml` is ignored scratch input, never an automated fixture.

For contract rules, verify both ordinary role and resource-role paths, and
record intentional differences found in static Saltbox/Sandbox corpus checks.
Do not edit or execute consumer roles during this validation.

## Offer fixes conservatively

A preview is not permission to write. Only `check --fix` writes source files;
the editor endpoints return edits against the exact submitted snapshot.
Register fix availability with the rule. Existing structural fix providers
share planning and preservation checks; extending one requires preserving its
contract across CLI checks, formatter responses and editor actions.

Prove YAML/Jinja semantic and non-whitespace-token preservation. Keep comments,
scalar styles, literal contents, line endings and already-valid formatting.
Verify idempotence and interacting corrections. Decline uncertain changes and
provide manual guidance. Template layout can change generated file contents;
`.j2` templates currently supply contract context, not formatting targets.

## Validate

Run the focused tests, then `make check`. See [contributing](contributing.md)
for tool versions and delivery checks. Inspect exact-commit CI across all
required targets before claiming completion.

## Public metadata

Register the explanation, human scope, source kinds and both examples with the
rule. `rules --format json`, editor help and `docs/rules.md` all use the data-only
registry projection. Run `make rules-update` explicitly after changing metadata;
`make check` rejects stale generated content without rewriting it. Existing
metadata-fixture tests execute the registered examples.
