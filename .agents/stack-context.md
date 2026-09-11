# Stack Context

Generated: 2026-09-11

## Stack
- Language: Go 1.27.1; Linux amd64/arm64, CGO disabled for release binaries.
- CLI: Cobra v1.10.2; factories with explicit I/O and exit-code boundary.
- Terminal presentation: colorprofile v0.4.3 and x/term v0.2.2; cmd resolves
  destination capability, width, and color before calling report renderers.
- YAML: goccy/go-yaml v1.19.2 AST/tokens behind the lint package.
- Build: make build runs make check before compiling bin/saltbox-lint.
- Tests: Go testing with table/golden fixtures; race and real shell/editor harnesses.
- Lint: golangci-lint v2.13.2 standard, actionlint v1.7.12.
- Format: gofmt checked without rewriting; go mod tidy -diff checks modules.
- Packaging: GoReleaser v2.18.1; make snapshot checks before local archives.

## Secondary languages
- Bash: composite Action download/checksum/install and literal-argv runner.
- YAML/JSON: workflows, packaging, VS Code process tasks and problem matcher.

## Conventions
- Flat cmd, lint, report packages; main owns process stdin/signal lifecycle.
- Rules consume shared analysis and return metadata-backed diagnostics.
- Paths/spans preserve source identity; renderers adapt columns for consumers.
- Auto human output is destination-aware; concise/JSON/GitHub/diff bytes remain
  deterministic and unstyled, and report receives explicit human options.
- Explicit fixes preserve YAML/Jinja meaning and already-valid source bytes.
- Consumer repositories remain read-only; examples are adoption templates.

## CI gates
- make build: format, module tidiness, vet, golangci-lint, go test -race ./....
- Same gate: Bash syntax, workflow/example actionlint, GoReleaser config check.
- make snapshot: same checks, local Linux amd64/arm64 archives/checksums.
- Exact tool versions live in Makefile; workflow actions are commit-pinned.
- Tools use ignored bin/tools; checks never rewrite source/module files.
