# go-yaml v1.19.2 local parser correction

Base: `github.com/goccy/go-yaml v1.19.2`, published tag commit
`92bc79cb5f685e999ad131473168fc45215d12d9`. The module checksum is in
`upstream-module-ziphash.txt`; `UPSTREAM-SHA256.json` records every copied
original file. `LICENSE` is the upstream MIT license. `provenance.lock.json`
records the source identity and maintenance condition.

`parser/parser.go` extracts single-entry parsing and accumulates same-column
siblings in one append-only slice. An explicit frame stack preserves the old
recursive footer unwind and head-comment attachment, including flow terminators.
Nested values retain their existing recursion. `iterative-mapping.patch` records
the intentional parser change against the copied original. This eliminates quadratic suffix
copying without changing public APIs, parser options, tokens, paths, or errors.

The root `lint/parser_contract_test.go` compares raw parser output and original
source adaptation against frozen published-parser contracts and checks safe
formatting preservation and idempotence. Its bounded wide-map allocation test
rejects the original quadratic work without a wall-time assertion.

This scoped copy retains complete production packages and public APIs, plus
upstream ast, lexer, parser, printer and token tests and the parser's three newline
fixtures. Upstream CI, docs, root tests and their bulk YAML conformance fixtures
are omitted. Necessary Go 1.27 formatter-only differences are recorded separately
in `FORMAT-CHANGES.json`. The upstream module cache is never patched.

`COMPATIBILITY-CHANGES.json` and `lint-compatibility.patch` separately record
behavior-preserving lint adjustments in `decode.go`, `encode.go` and `parser/token.go`.
Uses of the `reflect.Ptr` alias use its synonymous `reflect.Pointer` name.
Five debug print calls explicitly discard their results, preserving the existing
void debug API. No lint exclusions were added.

Canonical `make check` and all six native Go suites check every retained package,
including tests, vet, lint and module tidiness. Race runs cover supported targets.
The source vulnerability scan includes a separate complete local-module scope
and exact module advisory lookup without version filtering. Release source and
license inventories include this replacement.

Remove this replacement when a published upstream version contains an equivalent
correction and passes these preservation and allocation contracts. Keep the
published requirement until that update; local maintenance is not an upstream
version or release.
