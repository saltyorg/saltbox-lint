# Markdown comparison demos

One standalone Go module presents the same three v4 findings in two ways:

- **v5 — unified diff:** one hunk per finding, current/suggested file labels,
  two fixed-width source-number gutters, and separate `-`/`+` markers. Removed
  rows have a restrained red background; added rows have a green background.
- **v6 — guided comparison:** complete Current and Suggested excerpts with
  plain instructions. A neutral background emphasizes changed suggested words
  or structural rows. Current is emphasized for pure removals, including an
  edit that only removes words. The inserted blank row stays empty, has a
  visible band, and is explained by a sentence outside the YAML.

From the repository root:

```sh
make -C examples/markdown-demo-compare build
./bin/markdown-demo-v5 --theme dark
./bin/markdown-demo-v6 --theme dark
./bin/markdown-demo-v5 --theme light
./bin/markdown-demo-v6 --theme light
```

Compare with the preserved v4 binary using the same theme:

```sh
./bin/markdown-demo-v4 --theme dark
./bin/markdown-demo-v5 --theme dark
./bin/markdown-demo-v6 --theme dark
```

Both commands accept `--theme auto|dark|light` (default `auto`). Auto queries
`/dev/tty` once only when stdout is a terminal, with v4's 250 ms bounded
background query and dark fallback. Explicit themes bypass terminal detection
and queries. Redirected auto output uses dark without querying; stdin is never
read, including when piped. These are ANSI presentation demos: redirected
output retains colors. Use `less -R` to page a capture.

The report model, fixtures, computed line diff, and word spans are shared.
Rendering classifies each **complete** current/suggested YAML document through
v4's exported highlighter before selecting excerpt lines. The decoration layer
splits/clones composed tokens and changes only backgrounds. Original source
bytes, indentation, tabs, Unicode, scopes, font flags, and semantic/syntax
foregrounds stay intact. Number gutters, diff metadata, and a separate padding
segment are presentation only. Structural changes extend to a 64-column code
band; padding is emitted as a separate background-only ANSI segment after the
source and never added to source tokens or comparison offsets.

Both variants retain the same file grouping, rule/location details,
explanations, fix information, summary, and restored default Glamour H1 banner.
Prose uses the small frozen v4 style reference. Code is rendered directly with
v4's ANSI function, so Markdown never reinterprets patch markers or YAML bytes.

| Background | Dark | Light |
| --- | --- | --- |
| Removed (v5) | `#3A2C32` | `#F3E6E6` |
| Added (v5) | `#2C3A32` | `#E6EFE7` |
| Emphasis (v6) | `#35383E` | `#E6E7E9` |

These backgrounds accompany the existing One Dark Pro / One Light syntax and
semantic foregrounds. v6 offers a quieter reading comparison; v5 makes the
edit operations explicit. Neither mode uses strikethrough or words/whitespace
glyphs inside YAML to explain blank lines.

## Build and validation

```sh
make -C examples/markdown-demo-compare check
make -C examples/markdown-demo-compare build
(cd examples/markdown-demo-compare && GOWORK=off go test -race -count=1 ./...)
make check
```

The module gate checks formatting and module tidiness without rewriting files,
then runs vet and tests. Build runs that gate and writes only
`bin/markdown-demo-v5` and `bin/markdown-demo-v6`, using `CGO_ENABLED=0` and
`-trimpath`. The root gate remains independent and unchanged.

Local replacements import `../markdown-demo-v4` and its Nuri replacement
(`../markdown-demo-v4/third_party/nuri`). v4 owns the frozen embedded grammars,
themes, catalog, and Wasm engine. They are reused at build time, with no catalog
regeneration or asset copies. The resulting binaries need no external runtime,
source checkout, Python, Node, Ansible, grammar files, or network access.

## Scope and limits

This is a local comparison of three fixed findings, not a linter integration
or a general patch export. The unified view includes extra number gutters;
its output is for reading, not feeding to `patch`. Its hunk ranges are the
selected complete excerpts. The guided instructions are demo presentation
copy; change rows and word spans are computed from the full source, never from
those instructions. Small-source LCS comparison is appropriate for these
fixtures and is not intended for very large files. Prose retains Glamour's
fixed layout and code is not wrapped or expanded, so narrow terminals may
wrap long lines. Selected themes should match the actual terminal background.
Source line endings stay in the shared model; displayed code rows use terminal
newlines. Earlier demos, linter code, and consumer repositories are untouched.
