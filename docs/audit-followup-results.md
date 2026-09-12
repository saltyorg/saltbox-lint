# Audit follow-up results, 2026-09-12

All six findings from the audit of `79cdf3c` are resolved. The final implementation
is `d0be24839f8fae28a5be8d3fc7fbb94da10a1bd5`; later documentation-only commits do
not change the tested implementation. Independent task and integration reviews
have no remaining findings.

## Changes

- Scalar action and local-action arguments now expose source-preserving values
  to the existing rules. Mapping, inline and nested argument precedence follows
  Ansible. Decoding precedes key/value interpretation; Python-specific boundary
  whitespace, quoted contents, command-option admission and original spans are
  covered by regressions. Unsupported projections remain conservative.
- Role membership, renderer evidence, source runtime expressions and shared
  Docker policy facts have one analysis-invocation owner. Public inputs remain
  mutable between calls, direct rule checks retain uncached behavior, and
  returned diagnostics own their related-location slices independently.
- Fix planning deduplicates edits before expansion and indexes whitespace
  authority once per verification. Reporting shares converted proposals, and
  human proposal payloads are released at the existing file/job boundary.
- Independent lexical expectations can be regenerated with pinned TextMate
  9.3.2 and Oniguruma 1.7.0 packages. The retained executable closure and licenses
  are hash-verified before execution. Both palettes reproduce their frozen bytes.
  The separate archived Nuri capture route reproduces both token snapshots.
- Source installation uses `go install .` from a complete local checkout, retaining
  the Nuri replacement. The README no longer duplicates a stale rule count.
- A final lone CR remains visible in human excerpts and comparisons and no longer
  hides the missing-final-newline marker. LF and CRLF behavior is unchanged.

## JSON migration

The user explicitly selected shared fixes and diagnostic references. JSON now
emits `schema_version: 2`, `diagnostics` and `fixes`. Each fix-bearing diagnostic
has a `fix_id`; the matching top-level fix owns its path, message and original
source edits. IDs follow first occurrence, and exact path/message/ordered-edit
content determines identity. Manual previews do not gain fix authority.

Readers of the former inline `diagnostic.fix` field must resolve `fix_id` through
the top-level array. Other diagnostic fields, Go entrypoints and non-JSON output
remain compatible. See the [README](../README.md#output-and-fixes) for the wire
contract and migration instructions.

## Measured work reduction

These are constructed parse-once benchmarks on Go 1.27.1, Linux amd64,
Intel i5-13500, GOMAXPROCS 8. Timings are medians of three retained observations;
they do not measure end-to-end CLI latency or process RSS.

| Case | Before | Final measured implementation |
| --- | ---: | ---: |
| Role analysis, 32 task sources | 124.64 ms; 208.40 MB allocated | 1.10 ms; 1.81 MB allocated |
| Docker policy analysis, 32 sources | 4.98 ms; 9.78 MB allocated | 0.257 ms; 0.342 MB allocated |
| Fix planning, 40 layout expressions | 4.028 ms; 6.673 MB allocated | 0.531 ms; 0.514 MB allocated |
| JSON, 40 layout findings | 1,600 edit records; 207,480 bytes | 40 edit records; 17,818 bytes |

Role/resource measurements compare production code at `4fe601a` and `9ce89d8`.
Planning measurements compare `9ce89d8` and `bc43521`. Later changes do not alter
the measured functions or these benchmark inputs. All observations were retained;
the initial planning result of 0.431 ms was superseded after removal of duplicated
encoding logic, rather than selected over the final 0.531 ms observation.

The 10/20/40 expression cases now contain 10/20/40 JSON edit records, with
4,528/8,958/17,818 output bytes. Every original finding remains. Human, concise
and GitHub output hashes and verified replacement bytes match the baseline.

Committed benchmark definitions are in `lint/analysis_benchmark_test.go` and
`report/shared_fixes_test.go`. Reproduction commands:

```sh
go test ./lint -run '^$' -bench '^BenchmarkAnalyzeSharedFacts$' -benchmem -benchtime=200ms -count=3
go test ./report -run '^$' -bench '^BenchmarkSharedFixProcessing$' -benchmem -benchtime=100ms -count=3
go test ./report -run '^$' -bench '^BenchmarkSharedFix(HumanSuggestions|Prefix)$' -benchmem -benchtime=100ms -count=3
```

## Final validation

`make build` passed on the final implementation, including module/format checks,
vet, pinned golangci-lint, root and patched Nuri race tests, shell syntax,
actionlint and GoReleaser configuration validation. Independent copied-input
Node oracle tests passed. Published engine/WASM/package/license bytes were also
independently verified against both official npm archives.

Read-only corpus acceptance passed 431 Saltbox and 414 Sandbox selected-file
comparisons, 200 stdin comparisons and 652 valid-source no-op plans. Current
findings are 469 and 106 respectively; these are consistency checks, not clean
policy results. Expanding JSON v2 references reproduces the original binary's
complete diagnostic records, and verified patch bytes match exactly on the same
current inputs.

The live Saltbox inventory changed while this work ran. Earlier totals of 471
and 470 therefore do not describe the final input. Matched comparisons used the
original `79cdf3c` binary and the final binary against the same current bytes,
checking source hashes before and after. No consumer corrections were applied.
Scratch input, archived demos, production grammars/themes and frozen oracle
payloads remain unchanged.

Actual CLI probes covered LF, CRLF, absent final LF and lone final CR, plus all
four Python-only boundary whitespace characters and ordinary argument controls.
The documented source installation command was exercised with a private GOBIN.

```sh
make build
node --test tools/oracles/oracles.test.mjs
SALTBOX_LINT_SALTBOX_CORPUS=/srv/git/saltbox \
SALTBOX_LINT_SANDBOX_CORPUS=/opt/sandbox \
go test ./lint -run '^TestCorpus$' -count=1 -v
```

Work used sequential implementers and independent task, scoped-fix and final
integration reviews in the existing primary checkout. The user's request to fix
the audited findings was treated as approval of their local remediation. These
execution choices leave reversible local commits; no remote action was performed.
Local task/review reports and raw verification records are retained under the
ignored `.superpowers/sdd/2026-09-12-audit-followup/` directory.
