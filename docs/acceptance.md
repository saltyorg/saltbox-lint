# Local acceptance, 2026-09-10

The matched corpus run found **four Saltbox diagnostics and no Sandbox
diagnostics**. All four are intentional differences from the old Python linter;
this acceptance pass required no production-code correction or policy exemption.
The consumer checkouts and the user's `examples.yaml` were preserved.

## Frozen inputs

The production implementation at `9d2dec4556f01afa3cc2e0b5733e756bdbdf2509`
was tested with Go 1.27.1 on Linux amd64. This acceptance change adds an optional
corpus test and records its evidence; it does not alter that implementation.

| Input | Revision or SHA-256 | Worktree state |
| --- | --- | --- |
| Saltbox | `a243b198eb32ffe39f6f85afc34e35d9632fe0b1` | Existing modified `roles/gluetun/defaults/main.yml` |
| Sandbox | `1d1c40e3e17b97afdd318e35b8663a0c9563dc20` | Clean |
| Saltbox dirty defaults bytes | `e7797f9a794244957e3ccc57cddd0b4d875928d6cd12f6be6bc55a8a9d8dcd80` | Preserved |
| Python linter bytes | `2e4e23528a9ec43229f12a7078def0904fafc7baa7e031d9eafe813a3cfa2e2c` | Preserved |
| User example bytes | `eab41c1a460f7a33e0b1f4e136160b934096c84b00c0e854d2e219871949eb32` | Preserved |

The original baseline remains immutable in the local workflow evidence.
Separate before/after manifests include every tracked and nonignored untracked
consumer file, source revisions, dirty status, the Python linter blob and the
original example hash. The local evidence directory is
`.superpowers/sdd/2026-09-10-saltbox-lint/task-9-evidence/`; it is intentionally
ignored, not a runtime or CI dependency. Command records retain argv, cwd,
stdout, stderr, exit status and elapsed seconds. The task report identifies the
final tested commit and packaged artifact hashes.

## Matched old/new results

Each Python invocation used the same `/srv/git/saltbox/scripts/saltbox-linter.py`
and ran with the corresponding corpus as cwd. `GITHUB_OUTPUT` and
`GITHUB_STEP_SUMMARY` were unset. The Go invocation used `check --root <corpus>
--format json <corpus>`. Neither invocation executed Ansible or Jinja lookups.

| Corpus | Python selected defaults/tasks/inventory | Python exit | Go selected files | Go findings / exit |
| --- | --- | --- | --- | --- |
| Saltbox | 92 / 334 / 1 | 0 | 431 | 4 / 1 |
| Sandbox | 173 / 236 / 0 | 0 | 410 | 0 / 0 |

The first matched invocation took 1.420 / 1.524 seconds for Python / Go on
Saltbox, and 1.412 / 1.750 seconds on Sandbox. These are single observed wall
clock durations, including startup and discovery; they are not a performance
benchmark or evidence of a sustained speed difference.

The Go Saltbox selection contains 93 defaults, 334 tasks, one handler, one
inventory and two playbooks. Relative to the Python reported
defaults/tasks/inventory buckets it
adds `resources/roles/dns/defaults/main.yml`, `roles/system/handlers/main.yml`,
`backup.yml` and `saltbox.yml`. Sandbox adds the `sandbox.yml` playbook to 173
defaults and 236 tasks. No source in those Python buckets was omitted. The
legacy header rule also walks handlers/vars, and Git/tag/static-import checks
have separate task/playbook discovery. These deltas describe the printed
primary buckets, not files previously unseen by every legacy rule.

| Saltbox primary location | Rule | Attribution |
| --- | --- | --- |
| `inventories/group_vars/all.yml:270` | `jinja-layout` | The first-line `if` must continue at its owning expression's indentation. |
| `inventories/group_vars/all.yml:314` | `jinja-layout` | Same approved first-line conditional correction. |
| `roles/arr_db/defaults/main.yml:31` | `jinja-layout` | The inline `else` must continue aligned with its owning `if`. |
| `roles/mongodb/tasks/upgrade_hop.yml:76` | `jinja-conditional-length` | A 229-character source line exceeds the retained 160-character limit. |

All four locations already participated in the Python main discovery. The three
layout findings follow the approved conditional-layout correction. The MongoDB
line has two output expressions and escaped YAML quotes between them. Python
combines the first opening delimiter through the last closing delimiter; its
quote scanner consequently finds neither `if` nor `else`. Isolating the second
expression finds both keywords. The Go expression scanner diagnoses that live
conditional. This is an evidenced legacy scanning gap, not broader discovery or
a new threshold. The three layout diagnostics have verified fix candidates;
the length finding supplies a manual wrapping hint. Consumer sources were not
fixed during acceptance.

The CLI lists exactly 29 rules, and the [migration catalog](rule-migration.md)
has exactly 40 unique legacy IDs mapped to those same 29 identifiers. Registry
metadata and policy fixtures pass the standard suite. The old 47 tests also
pass, but cover only healthchecks (18), lookup conditionals (7), closing braces
(5), and SVM (17); they do not establish coverage of all 40 legacy intents.

## Selection, identity and preservation

The optional `lint/corpus_test.go` uses only public `Load`, `Analyze`, `Rules`
and `PlanFixes` APIs. It independently reloads **every selected file** and
compares its complete diagnostics, including spans, related locations and fixes,
with the full-run findings filtered by primary path. It also verifies that the
selection contains exactly that path.

| Corpus | Selected-file comparisons | Representative stdin comparisons | Valid-source no-op plans | First non-race duration |
| --- | --- | --- | --- | --- |
| Saltbox | 431 / 431 | 7 | 428 | 9.772 s |
| Sandbox | 410 / 410 | 3 | 410 | 7.390 s |

Stdin cases include each discovered source kind and every file with findings.
They preserve root-relative identity, classification, bytes and diagnostics.
No-op plans are checked for all 838 files without diagnostics. The test never
calls the disk-writing fix API, and rereads every selected file to detect source
changes. It prints counts, kinds, elapsed time and an ordered path/content
SHA-256 manifest. These are consistency checks; full rule correctness also
relies on the independent policy fixtures and the reviewed findings above.

The actual CLI separately passed disk/stdin equality for the three finding
files, the dirty but valid Gluetun defaults, and a Sandbox task file. Explicit
`--fix` on temporary copies of the two valid sources preserved their bytes.
The user example was copied into a temporary directory and exercised through:

1. Check: exit 1 with the intended layout finding.
2. `--diff`: exit 1, unchanged input, diagnostics on stderr, and stdout accepted
   by `git apply --check` in the temporary directory.
3. `--fix`: exit 0, exactly the reviewed `first-if.good.yaml` fixture bytes.
4. Check again: exit 0 with no diagnostics.
5. A second explicit fix: exit 0 and byte-for-byte unchanged output.

## Reproduce the checks

Ordinary `go test ./...` and `make check` skip the optional corpus subtests when
the two environment variables are unset. A supplied invalid path fails rather
than silently skipping. The corpora are explicit, read-only validation inputs:

```sh
SALTBOX_LINT_SALTBOX_CORPUS=/srv/git/saltbox \
SALTBOX_LINT_SANDBOX_CORPUS=/opt/sandbox \
go test ./lint -run '^TestCorpus$' -count=1 -v

# The same full corpus check can run with the race detector.
SALTBOX_LINT_SALTBOX_CORPUS=/srv/git/saltbox \
SALTBOX_LINT_SANDBOX_CORPUS=/opt/sandbox \
go test -race ./lint -run '^TestCorpus$' -count=1 -v

make check
make build
# Uncached actual scripts, localhost download transport, CLI and editor tasks.
go test ./action -count=1 -v
make snapshot
```

The quality gates passed with golangci-lint v2.13.2, actionlint v1.7.12 and
GoReleaser v2.18.1, using the versions pinned in the Makefile. Snapshot packaging
built Linux amd64 and arm64 archives and checksums without publication.

## Execution limits

The Action installer/runner was exercised locally, including real binary
installation through a localhost archive/checksum server, literal path handling,
status propagation, GitHub annotations and summary creation. The 18 installer
cases, 11 runner cases, actual-binary transport case and three editor task cases
passed. No hosted GitHub workflow was dispatched and no release was published.
The future release pins in the consumer examples remain placeholders.

Editor validation executed the shipped process arguments and matched actual CLI
findings to source paths. It did not launch a VS Code GUI or test interactive
WSL/Remote SSH sessions. ARM64 validation cross-compiled the binary and checked
ELF/build/archive metadata; the installer matrix used portable fixture bytes
for ARM asset selection. No ARM64 binary was executed on an ARM guest.
