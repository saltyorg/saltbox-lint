# Nuri v1.0.1 local compatibility patch

Base: `github.com/frostybee/nuri v1.0.1`, downloaded through the Go module proxy.
`upstream-module-ziphash.txt` preserves the original module checksum;
`UPSTREAM-SHA256.json` records the original bytes of every copied upstream file.
`LICENSE`, `THIRD-PARTY-NOTICE` and `provenance.lock.json` preserve upstream
attribution, bundled Oniguruma WASM provenance and dependency notices.

Only `internal/grammar/compile.go` has a functional change to upstream production source.
The exact change is `captured-regexp-literals.patch`: escape captured whitespace,
`#`, `-` and `,` when expanding end/while regex backreferences. VS Code's
`escapeRegExpCharacters` escapes these. Leaving indentation unescaped makes
extended-mode `(?x)` patterns ignore it, incorrectly carrying Ansible conditional
and list-item states onto subsequent lines.

Eleven other imported production files have formatting-only changes from
`gofmt` with Go 1.27.1, required by the repository's non-mutating format gate.
`FORMAT-CHANGES.json` lists each file and its before/after SHA256. The original
`UPSTREAM-SHA256.json`, module checksum and upstream provenance remain unchanged;
these eleven files are not byte-identical copies. The functional patch remains
separate and applies to the original `compile.go`.

`internal/grammar/backref_compatibility_test.go` is a local regression test.
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
```
