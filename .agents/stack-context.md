# Stack Context

Generated: 2026-09-10

Bootstrap status: source packages and gates below describe the approved target;
implementation and verification are pending.

## Stack
- Language: Go 1.27.1
- CLI: Cobra; command factories with explicit input/output streams
- YAML: goccy/go-yaml syntax trees and source tokens
- Build: make build (checks before compiling)
- Test: Go testing, table-driven and golden fixtures in testdata
- Lint: pinned golangci-lint and actionlint
- Format: gofmt, checked without rewriting by make check

## Conventions
- Flat cmd, lint, and report packages; main wires the CLI.
- Rules consume parsed sources and return diagnostics, never execute Ansible.
- Errors gain context and are reported once at the command boundary.
- Rule metadata owns documentation, source scopes, and fix availability.
- Source edits are explicit and preserve YAML and Jinja meaning.

## CI gates
- Formatting, module consistency, vet, lint, race tests, workflow validation.
- Linux binary builds and GoReleaser snapshot packaging.
