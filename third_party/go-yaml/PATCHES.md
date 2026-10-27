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

`lazy-yaml-path.patch` stops copying the complete YAMLPath into every nested
parser context and node. `ast.PathRef` stores one parent pointer and final
segment per level; `GetPath` renders the same path string on request, and
duplicate-key detection compares the shared parent and final key segment.
Deeply nested flow collections therefore retain linear rather than quadratic
memory. The patch applies to the copied originals of `ast/ast.go`,
`parser/context.go` and `parser/node.go`, and to `parser/parser.go` after
`iterative-mapping.patch`. Public APIs are additive (`ast.PathRef`,
`BaseNode.GetPathRef`, `BaseNode.SetPathRef`); `SetPath` and `GetPath` keep
their behavior, but parsed nodes leave the exported `BaseNode.Path` field empty
because populating it would reintroduce the quadratic copies. Readers must use
`GetPath`. The root `lint/parser_contract_test.go` deep-flow allocation test
rejects quadratic growth and checks rendered paths.

`plain-origin-whitespace.patch` keeps spaces and tabs before a line break in
plain scalar origins once the origin already holds content or a line break.
Upstream dropped them, so `" 1 \r\n"` produced the origin `" 1\r"` and
`"a: 1 \nb: 2"` produced `" 1\n"`, neither of which is a source substring;
lint source location then failed as a yaml-syntax error. Whitespace that would
lead an origin is still dropped, preserving upstream tab-key validation.
Scalar values, positions and errors are unchanged. One upstream lexer test
origin expectation is updated to the retained source bytes. Root yamlindex and
lint tests cover LF, CRLF and CR sources.

`LOCAL-CORRECTIONS.json` records each corrected file's before and after hash
and the patch that produced it.

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

The root `integration/vendored_test.go` verifies these records offline. Every
file in `UPSTREAM-SHA256.json` must keep its upstream bytes or be declared by a
`FORMAT-CHANGES.json` or `COMPATIBILITY-CHANGES.json` before/after record (before
equals the upstream hash, after the vendored hash) or a `*.patch`. Reverse-applying
each file's patches, in reverse patch-name order, to the vendored copy must
reproduce its upstream hash. `provenance.lock.json` must match the go.mod module
and version, the module checksum, the license and parser hashes, and the files
patched by each named patch; `lint-compatibility.patch` must patch exactly the
files listed in `COMPATIBILITY-CHANGES.json`. Each `LOCAL-CORRECTIONS.json` entry
must match the hashes on either side of its named patch within that cumulative
stack, and the lock's `localCorrectionPatchDiffs` must patch exactly the files
the record lists.

Canonical `make check` and all six native Go suites check every retained package,
including tests, vet, lint and module tidiness. Race runs cover supported targets.
The source vulnerability scan includes a separate complete local-module scope
and exact module advisory lookup without version filtering. Release source and
license inventories include this replacement.

Remove this replacement when a published upstream version contains an equivalent
correction and passes these preservation and allocation contracts. Keep the
published requirement until that update; local maintenance is not an upstream
version or release.
