# Adopting Saltbox Lint

Use `saltbox-lint rules` to list the current enforced policies and
`saltbox-lint rules RULE_ID` for explanations and valid/invalid examples. The
registry is the current policy authority. A historical 40-to-29 mapping and its
supporting research are not published in this repository; this guide does not
claim to reconstruct them.

## Four consumer workflow migrations

The templates in [examples/github](../examples/github) replace the linter job
only. Preserve the consumer's workflow triggers and unrelated jobs. They use the
published [shared Action v1.3.2](https://github.com/saltyorg/github-actions/releases/tag/v1.3.2)
and [linter v0.1.0](https://github.com/saltyorg/saltbox-lint/releases/tag/v0.1.0).
The two versions are independent. Use existing published version tags for
future updates; Renovate owns consumer version bumps.

| Consumer workflow | Local adoption template | Additional behavior |
| --- | --- | --- |
| Saltbox `saltbox.yml` | [saltbox.yml](../examples/github/saltbox.yml) | Retains the facts-persistence test |
| Saltbox `saltbox-os.yml` | [saltbox-os.yml](../examples/github/saltbox-os.yml) | Retains the facts-persistence test |
| Sandbox `sandbox.yml` | [sandbox.yml](../examples/github/sandbox.yml) | Checks the nested `sandbox` checkout |
| Sandbox `sandbox-os.yml` | [sandbox-os.yml](../examples/github/sandbox-os.yml) | Checks the nested `sandbox` checkout |

The facts test requires the consumer's existing `.github/scripts/test_saltbox_facts.py`;
these templates do not install that script. Do not copy a Sandbox nested-checkout
job into a root checkout without adapting its checkout path and working directory.

The verified Action tag contains `saltbox-lint/action.yml`, `install.sh` and
`run.sh`. It accepts an exact stable linter version, verifies the matching Linux
archive checksum and binary version, passes newline-separated paths as literal
arguments, and preserves CLI statuses 0, 1 and 2. It supports Linux X64/ARM64
runners. The standalone CLI also supports macOS and Windows.

## Paths and annotations

`working-directory` is relative to `GITHUB_WORKSPACE`; `paths` are relative to
that directory. Spaces and shell metacharacters stay literal. Blank lines are
ignored, CRLF lists are supported, and one path cannot contain a newline. The
Action does not accept arbitrary CLI flags or apply fixes.

JSON and concise findings use source-root-relative identities, such as
`roles/example/tasks/main.yml`. GitHub annotations instead resolve source files
relative to `GITHUB_WORKSPACE` when that variable is set. For a Sandbox checkout
under `$GITHUB_WORKSPACE/sandbox`, the annotation path is
`sandbox/roles/example/tasks/main.yml`. Without `GITHUB_WORKSPACE`, annotations
use the source-root-relative identity.

`GITHUB_STEP_SUMMARY` receives a bounded Markdown summary, while annotations
retain the complete finding set. Summary labels remain source-root-relative.
Their hyperlinks use repository-relative paths: the CLI asks Git for the
source root's repository top level, falling back to the source root if Git cannot
resolve it. It builds URLs using `GITHUB_REPOSITORY`, `GITHUB_SHA` and
`GITHUB_SERVER_URL`, with a GitHub.com server fallback. Without a repository and
commit, locations remain plain text. Files outside the resolved repository root
do not receive a source link.

A nested checkout of the workflow's own repository retains that repository's
normal link paths, without the workspace checkout-directory prefix. When
checking a different repository, supply that checked-out repository's name and
exact checkout commit in `GITHUB_REPOSITORY` and `GITHUB_SHA` for the check step;
the workflow's default values describe the triggering repository instead.
Keep `GITHUB_WORKSPACE` unchanged so annotations continue to identify actual
workspace files. This environment adjustment corrects summary hyperlinks; it
does not move the check run or annotations into the other repository.

## Editor adoption

For the bundled extension, create an empty regular `.saltbox-lint` marker at the
selected source root and follow [extension installation](../extension/README.md#platforms-and-installation).
The marker does not configure the standalone CLI or Action. For process tasks,
copy or merge [tasks.json](../examples/vscode/tasks.json), install the CLI on the
workspace host and save files before checking them. Tasks read disk.
