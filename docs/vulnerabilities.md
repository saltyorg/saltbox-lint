# Go vulnerability maintenance

`make vulnerability-check` runs pinned `govulncheck v1.8.0` with the Go toolchain
from `go.mod`. `make check`, `make build` and packaging require the same scan.
CI runs it once in the canonical check job. The six native source suites and
packaged acceptance suites remain required. Normal Saltbox Lint commands and
the installed extension do not invoke the scanner or contact a database.

The developer gate needs HTTPS access to `https://vuln.go.dev`, plus the ordinary
Go module downloads needed for the pinned tool and project dependencies. It
uses `-mode=source -scan=symbol -test -json`, disables Go workspaces and requests
read-only module loading. It neither edits module files nor reads consumer
repositories. Tool installation uses the same versioned `bin/tools` convention
as the other developer tools.

## Source coverage and results

The root scan shares the current project package discovery used by vet, lint
and tests. The Nuri scan includes `.`, `./internal/grammar` and
`./internal/tokenizer`, their imported packages, and the retained
`./internal/fidelity` and `./internal/shared` helper packages shipped in the
source archive. Upstream fixture submodules remain outside these scopes.
Source reachability includes tests and exported library entry points. It is
conservative and can report a callable library path which the shipped CLI does
not exercise with its current inputs.

The centralized scan uses the host's Go build constraints, recorded in the
manifest as GOOS and GOARCH. It does not replace the six native suites or claim
vulnerability reachability for other build constraints, arbitrary build tags,
Oniguruma WASM/C, JavaScript or npm tools.

The manifest separates module/package discoveries from called-symbol findings.
`reachable` contains called-symbol advisory IDs and fails the gate. `discovered`
also includes affected module/package findings without a call trace. Those need
triage but do not by themselves establish source reachability. Raw OSV records
include advisories for dependencies at other versions; they are not findings.

Govulncheck's successful JSON process exit is zero even when it finds a
vulnerability. The gate parses findings explicitly. A nonzero scanner exit,
missing database metadata, malformed output, an incomplete scope, a database
retrieval failure or changing source inputs yields `inconclusive` and fails.
There are no ignored advisories or successful fallbacks after an error.

## The patched Nuri identity

The root module requires `github.com/frostybee/nuri v1.0.1` but replaces it with
`third_party/nuri`. The local bytes and
[patch record](../third_party/nuri/PATCHES.md) describe the maintained code.
The upstream version alone cannot establish whether these bytes contain a fix.
The manifest records the replacement, module-specific source hash and the
individual input hashes, including the patch and upstream provenance records.

Govulncheck queries a local replacement's path and suppresses version matching
for unversioned main modules. Its absence of Nuri findings therefore does not
prove that a local patch resolves an advisory. The gate independently checks
the original paths of every main/replaced module against the retrieved database
index and all applicable, non-withdrawn advisory entries without a version
filter. Any such advisory is `inconclusive` and fails pending evidence about the
local source. An empty advisory list means that this database has no known
advisory for that path. It does not certify the safety of the patched source.

## Evidence and triage

Ignored `bin/vulnerability/scan.json` uses `schemaVersion: 1` and records the
source commit, dirty flag, input hashes, scanner binary hash and Go build
information, Go version/build target, module identities, scope/options,
reachability findings and errors. Local worktree evidence records its actual
pre-commit source hashes. CI evidence records the exact checked-out commit.

`root.govulncheck.json` and `nuri.govulncheck.json` retain the scanner's actual
stream of concatenated JSON objects. They are not JSON arrays or JSONL. Their
hashes and sizes appear in the manifest. `database.metadata.json` and
`database.modules.json` retain the actual database index responses. Each fetched
advisory response has its URL, retrieval time, HTTP status, available
Date/ETag/Last-Modified headers, size and SHA-256 in the manifest. The scanner's
raw protocol retains the advisory records it analyzes.

Both scopes use one temporary database built from those retrieved bytes.
The gate compares the metadata and module index again after advisory retrieval
and fails if either changed. It removes the temporary database after joining
the scanner. This establishes which responses the scan used, without claiming
the live service provides an atomic historical snapshot. Source snapshots and
environment variables are not part of the evidence artifact.
CI uploads `vulnerability-evidence` after success or failure. A failure before
the scan starts can leave no evidence, and still fails CI.

For a finding, inspect its advisory, vulnerable module/version, `fixed_version`
and source trace. Verify an upstream fix against its published tag or prove a
local patch against the recorded source bytes. Update only authorized repository
dependencies, run the relevant regressions, then rerun the required scan and
the complete quality gate. A local-source advisory remains inconclusive until
there is enough evidence to implement a narrow verification policy. Do not add
a broad ignore rule or remove the check to pass CI. Database/tool failures need
their own correction and a fresh successful scan.

The initial adoption found reachable `GO-2026-5320` in Goldmark's HTML renderer
and `GO-2026-5970` in x/text normalization through Glamour. This repository pins
the published fixes, Goldmark `v1.7.17` and x/text `v0.39.0`.
See the official [Go vulnerability documentation](https://go.dev/doc/security/vuln/),
[database API](https://go.dev/doc/security/vuln/database),
[Goldmark advisory](https://pkg.go.dev/vuln/GO-2026-5320) and
[x/text advisory](https://pkg.go.dev/vuln/GO-2026-5970).
