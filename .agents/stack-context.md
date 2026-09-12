# Stack Context

Generated: 2026-09-12

## Stack
- Go 1.27.1; Linux amd64/arm64, CGO disabled for release binaries.
- Cobra v1.10.2; command factories own explicit I/O and exit-code boundaries.
- colorprofile v0.4.3, x/term v0.2.2 and uniseg v0.4.7 provide destination-aware terminal presentation and grapheme wrapping.
- goccy/go-yaml v1.19.2 validates lint sources; yaml.v3 v3.0.1 independently defines semantic acceptance. Immutable yamlindex records share preview lexing.
- Embedded Ansible/Jinja TextMate grammars and authentic themes use locally patched Nuri v1.0.1; semantic data uses a frozen catalog.
- Go testing covers table/golden fixtures, race safety and real shell/editor/terminal harnesses.
- Secondary languages: Bash for the Action installer/runner; YAML/JSON for workflows, packaging and VS Code tasks; pinned JavaScript/TypeScript under tools/oracles for explicit offline evidence regeneration with Node 24.20.0 (outside normal Go gates).

## Conventions
- Flat cmd, lint, report, highlight and yamlindex packages separate commands, analysis, policy and display; main owns process stdin/signals.
- Rules consume shared analysis and return metadata-backed diagnostics. Paths/spans retain source identity; renderers adapt columns for consumers.
- Loading uses ordered Git candidates and bounded read/parse batches. The coordinator publishes selected/context sources deterministically before sequential rule evaluation.
- Display retains full-source semantic context in both palettes; evidence APIs honor imported theme enablement. Preview indexes are immutable and require exact source matches.
- Each renderer retains one original semantic document; suggested variants remain ephemeral and never authorize source writes.
- TextMate display scans required prefixes. Validated edits resume immutable raw-token checkpoints and reuse suffixes only at complete grammar-state convergence.
- Per-report lexical line and document caches share a 64 MiB retained-data ceiling; pinned readers remain charged. This excludes total process RSS.
- Ordered reporting caps workers by GOMAXPROCS, eight and file count; four-file lookahead and four queued 64 KiB fragments per file bound queued payload to 8 MiB.
- Workers join before highlighter close. Cancellation and output errors stop production. Adjacent equivalent ANSI styles coalesce with row/gutter resets preserved.
- Human source wraps at full destination width without hiding changed/marked lines. Auto format is destination-aware; concise/JSON/GitHub/diff remain deterministic and unstyled.
- Explicit fixes preserve YAML/Jinja meaning and already-valid bytes. Consumer repositories remain read-only; examples are adoption templates.

## CI gates
- make check: non-mutating gofmt/module-tidiness checks, vet, pinned golangci-lint and root plus patched Nuri race suites; Bash syntax, workflow/example actionlint and GoReleaser validation.
- make build runs that gate before the CGO-free binary; make snapshot runs it before local Linux amd64/arm64 archives/checksums with third-party notices/licenses.
- Makefile pins golangci-lint v2.13.2, actionlint v1.7.12 and GoReleaser v2.18.1; workflow actions are commit-pinned. Tools live under ignored bin/tools.
- make catalog is the explicit managed-wrapper refresh. Normal gates use embedded data and require no Saltbox Ansible venv.
- See docs/terminal-rendering-results.md for measured adoption/defer decisions and delivery evidence status.
