# Create a minimal role

`scaffold role NAME --root ROOT` previews the exact paths and complete contents
of a new role's `defaults/main.yml` and `tasks/main.yml`. It runs every applicable
registered rule on the proposed files in memory under the root's actual Saltbox
or Sandbox identity. A validation failure exits with status 2 and creates nothing.

Supply the real project title, author attribution and HTTP or HTTPS project URL.
Saltbox requires `--author`. Sandbox uses `Author(s): salty`; an explicitly
supplied author must be `salty`.

```sh
saltbox-lint scaffold role example --root . \
  --title 'Actual project title' --author 'Actual contributor' \
  --url 'https://your-project.example'
```

The root must already exist, have a physical `roles/` directory, and contain
exactly one regular project marker from `saltbox.yml`, `saltbox.yaml`,
`sandbox.yml` or `sandbox.yaml`. Markers remain under your control. Multiple
markers, missing markers, symlinked markers or role directories, and roots
inside Git administration are refused. Root aliases are resolved to their
canonical physical owner and rechecked before creation. Inherited Git
administrative controls use the same checks as source loading.

Names must satisfy the registry's snake_case role policy and be portable path
segments. Separators, traversal, uppercase letters, non-ASCII names, Windows
device names and names longer than 128 bytes are refused. The root path and
header metadata can contain Unicode. Header fields must be nonempty single lines
without control characters or surrounding whitespace.

The defaults file contains an empty mapping and the tasks file an empty sequence,
each with the ordered source header and GPL v3.0 notice. These are deliberately
empty starting points. Add role-prefixed defaults and named tasks for your
application after reviewing the preview. Generation does not create application,
Docker or Traefik profiles, Jinja templates, inventory entries or project markers.
It never executes generated contents, Ansible roles, modules or Jinja code.

## Explicit creation

Repeat the command with `--write` to create the advertised files. Preview remains
the default. The command prints the complete proposal before attempting creation,
so a preview output failure prevents writes.

```sh
saltbox-lint scaffold role example --root . \
  --title 'Actual project title' --author 'Actual contributor' \
  --url 'https://your-project.example' --write
```

Creation requires the entire role directory to be absent. Every planned target
is preflighted before the first write. Directories and files are created
exclusively, with anchored filesystem operations and checks of the original
root, project marker and parent owners. Existing files or directories are never
overwritten or extended. Successful creation exits with status 0 and prints each
created file and directory to stderr. Directory paths have a trailing slash.

Creation is not a filesystem transaction. Cancellation, owner changes or I/O
errors may leave a partial role. The command exits with status 2 and reports all
paths it created before the failure, including a file whose write failed. It
retains those paths and performs no rollback or deletion. Inspect them before
cleaning up; another process may have changed them or added data. Abrupt process
termination can prevent reporting. These checks do not guarantee atomicity
against concurrent filesystem changes.

This explicit source-creation command is separate from `check --fix`, which
corrects verified violations in existing sources. Previewing a role does not
authorize creation or enable formatting on save. `format` and template checking
remain read-only. See the [CLI guide](../README.md) and [rule reference](rules.md).
