# Nuri v1.0.1 local patches

Base: `github.com/frostybee/nuri v1.0.1`, downloaded through the Go module proxy.
`upstream-module-ziphash.txt` preserves the original module checksum;
`UPSTREAM-SHA256.json` records the original bytes of every copied upstream file.
`LICENSE`, `THIRD-PARTY-NOTICE` and `provenance.lock.json` preserve upstream
attribution, bundled Oniguruma WASM provenance and dependency notices.

The compatibility change in `internal/grammar/compile.go` is preserved as
`captured-regexp-literals.patch`: escape captured whitespace, `#`, `-` and `,`
when expanding end/while regex backreferences. VS Code's
`escapeRegExpCharacters` escapes these. Leaving indentation unescaped makes
extended-mode `(?x)` patterns ignore it, incorrectly carrying Ansible conditional
and list-item states onto subsequent lines.

Saltbox Lint also adds an opt-in, highlighter-owned TextMate line cache:

- `options.go` adds `WithLineCache`, whose byte budget is disabled by default.
- `nuri.go` owns the cache for one `Highlighter` instance and passes it only to
  lexical tokenization.
- `internal/tokenizer/line_cache.go` stores exact bare-line results under the
  complete normalized incoming state, grammar and resolver identity, first-line
  status, and tokenizer safety options. It uses a synchronized bounded LRU and
  clones stored and returned state/tokens. Eviction clears retired bucket slots
  and compacts sparse backing arrays so removed entries are not retained outside
  the byte accounting.
- `internal/tokenizer/tokenizer.go` reuses only successfully completed lines;
  cancellation remains checked before every line and timeout, panic, and
  over-length degradation results are never stored. A persistent document taint
  from `line.go`, `injections.go`, and `captures.go` also disables all later
  cache reads and writes after a soft-fallback scanner, resolver, while, or
  nested-capture error, preventing reuse of state derived from degradation.

`line_cache_test.go` and `internal/tokenizer/line_cache_test.go` cover the public
option, concurrent calls, cancellation, bounded eviction, immutable snapshots,
deterministic reuse counts, every state/key field, error-tainted downstream
state, and cancellation observed during sentinel scanning. The cache does not
expose grammar state through Nuri's public API.

Saltbox Lint adds opt-in immutable document checkpoints through
`WithDocumentCache`, `NewDocument`, `WarmDocument`, `CodeToDocumentTokens`, and
`CodeToEditedDocumentTokens`:

- Original source identity, raw tokens, and complete line-boundary states remain
  private. Exact validated original-byte edits determine restart and suffix
  alignment; suffix reuse also requires equal normalized complete grammar state.
  Suffix offsets advance together to a physical boundary in both sources, so
  joining lines cannot reuse tokens or styles from a different original line.
- Grammar/resolver identity, first-line status, safety options, captures, and the
  existing taint checks remain authoritative. Invalid edits fall back to the
  supplied source. Degraded or canceled scans never publish a snapshot and
  invalidate any older snapshot of that document.
- The cache has a fixed budget and bounded eviction. Borrowed snapshots remain
  charged until their final reader finishes, including after invalidation.
  Token slots, scope slices, complete frame arrays, and resolved end/while-rule
  storage are charged conservatively. Closing the highlighter clears both
  caches, and grammar/alias replacement invalidates both context caches.
- Public result scopes are independently owned. Snapshots retain no scanners,
  workers, disk state, theme results, or semantic analysis. The existing pool
  owns every grammar scan; the document API coordinates close and registration.
- Saltbox Lint configures 32 MiB for each lexical cache, a combined 64 MiB
  retained-data ceiling per report. Caller-owned source/semantic documents,
  in-flight result construction, and output buffers remain separate allocations.

`document_test.go` and `internal/tokenizer/document_test.go` exercise direct
reuse counters, original-byte edit validation, multiline/backreference/while and
first-line behavior, taint, ownership, concurrency, cancellation, eviction, and
memory accounting. Saltbox Lint's `highlight/checkpoint_test.go` differentially
compares real grammar scopes, RGB/fonts, diagnostics, CRLF, Unicode, EOF, and
full-source semantic context against uncached highlighting in both display themes.

Saltbox Lint also adds a per-result exact scope-style memo in `nuri.go`:

- `buildResult` and `buildResultMulti` construct one call-local memo and reuse
  the final resolved style for repeated complete scope stacks.
- The key length-prefixes every scope byte string in order and includes theme
  identity, avoiding delimiter and cross-theme collisions.
- Scope keys are constructed once per token and shared across themes in the
  multi-theme builder. Theme selection, per-property overrides, and fallbacks
  still use the existing `resolveStyle` path on a miss.
- The memo is never stored on `Theme` or `Highlighter`, so a later call observes
  mutable theme rules and no synchronization or persistent eviction policy is
  needed.

`result_style_memo_test.go` differentially covers direct resolution, exact-key
collisions, theme identity, within-result reuse, between-result theme mutation,
and multi-theme output. `result_style_benchmark_test.go` measures repeated-scope
result construction independently of TextMate tokenization.

Ten other imported production files have formatting-only changes from
`gofmt` with Go 1.27.1, required by the repository's non-mutating format gate.
`FORMAT-CHANGES.json` lists each file and its before/after SHA256. The original
`UPSTREAM-SHA256.json`, module checksum and upstream provenance remain unchanged;
these ten files are not byte-identical copies. Functional changes to `nuri.go`
are inventoried above rather than represented as formatting-only changes. The
captured-regexp functional patch remains separate and applies to the original
`compile.go`.

`internal/grammar/backref_compatibility_test.go` is the compatibility regression test.
It was observed failing before the patch. The demo's complete independent VS Code
oracle fixtures also failed before this patch and pass after it.

This copy contains root production Go files and required `ast`, `internal`,
`renderer`, `resources`, and `theme` source/assets. Unused `bundle`, `cmd`,
`transformers`, `tools`, `wasm-build`, illustrations, and upstream test files are
omitted; this is a scoped dependency copy, not a complete Nuri development fork.
The embedded WASM is unchanged. The global Go module cache is unchanged.

Separately, `highlight/grammar.go` bridges Nuri's missing registry forwarding for
external injections by deriving host self-injections from manifest metadata.
Cross-scope includes preserve each external grammar's own repository. This
adapter does not modify this dependency copy or the embedded grammar originals.

Run the local dependency regression with:

```sh
go test ./internal/grammar
go test -race . ./internal/tokenizer
go test -run '^$' -bench '^BenchmarkBuildResultRepeatedScopes$' -benchmem
```
