# Extension packaging and release validation

The [platform table](platforms.md) maps six standalone CLI targets to eight
VSIX targets. `extension/scripts/release-inputs.mjs` owns the VSIX map;
`.goreleaser.yaml` defines native archives. Tests require CI coverage for every
native release target. Packages include a CGO-free CLI, licenses and source
provenance. GitHub release publication and Marketplace publication are separate.

## Local packaging

Use the Go version in `go.mod`, Node in `extension/.node-version` and npm 11.19.0.
From the repository root:

```sh
make check
make snapshot
```

`make snapshot` repeats the quality gate and creates six CLI archives, eight
VSIXs, checksums, `SOURCE.json`, `vsix-artifacts.json` and corresponding source in
ignored `dist/`. It publishes nothing. `make release-artifacts` requires a stable
tag and matching extension manifest version, and also creates local artifacts.
The release scripts verify archive/ZIP structure, binary identity and source
hashes. The source archive includes vendored modules, modified Nuri and its WASM
wrapper, matching Oniguruma source, license texts and build instructions.

## Required CI coverage

The [CI workflow](../.github/workflows/ci.yml) checks and packages artifacts on
Linux, independently runs source suites on all six native targets, and runs
packaged acceptance on those same targets. Installed VSIX tests use the minimum
and current editor versions configured in the host test scripts. Both Linux
architectures also run Alpine musl probes. Windows arm64 lacks a Go race runtime;
its ordinary Go and extension suites still run. Alpine probes do not constitute
an installed editor host suite.

Inspect the exact final commit SHA, every required job and matrix result, and the
artifact manifest before claiming readiness. `CI required` aggregates packaging,
all native checks and all packaged acceptance jobs. Pending, failed, cancelled or
unexpectedly skipped required coverage is incomplete. A local Linux check or a
cross-built archive does not establish correctness on other platforms.

Optional corpus, loader-semantic and performance qualification uses
[tools/qualification](../tools/qualification/README.md). Its operator-owned inputs
and reports are separate from routine CI. Historical qualification reports are
not shipped here; do not treat missing reports as measured results.

## Publication

Agree the version and exact commit, validate that commit, and obtain explicit
release authorization before creating or pushing a release tag. The
[release workflow](../.github/workflows/release.yml) publishes artifacts for an
exact stable version tag after its CI gates. Verify the remote tag target,
successful publication and all expected assets. Changes after validation require
validation again. Consumer version updates and Marketplace publication each
require their own authorization.

The published [v0.1.0 GitHub release](https://github.com/saltyorg/saltbox-lint/releases/tag/v0.1.0)
is dated 2026-09-20 and targets commit
`e2716109d86c56863c6182d1659f97f379622a3b`. Its assets include six standalone CLI
archives and eight VSIXs. This publication fact does not establish Marketplace
availability or qualify subsequent commits. See the [changelog](../extension/CHANGELOG.md)
for released and subsequent changes.
