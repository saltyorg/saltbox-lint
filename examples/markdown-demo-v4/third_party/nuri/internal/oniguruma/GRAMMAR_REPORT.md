# Oniguruma WASM Scanner — Grammar Compile Report

Compile smoke test: every regex pattern extracted from TextMate grammar
files is compiled through the production Scanner API (Oniguruma WASM + wazero).

## Summary

- **Grammars tested:** 245
- **Total unique patterns:** 20764
- **Compiled successfully:** 20641 (99.4%)
- **Backreference end-patterns (expected):** 123
- **Genuine failures:** 0

> **Note on backreference end-patterns:** TextMate `begin`/`end` rules use
> backreferences (`\1`, `\2`, ...) in the `end` pattern to refer to capture
> groups from the `begin` pattern. These are resolved at runtime by the
> tokenizer (which substitutes the captured text before compiling). They are
> not valid standalone regexes, so Oniguruma correctly rejects them. This is
> expected behavior.

## Per-Grammar Results

| Grammar | Patterns | Passed | Backref | Failed |
|---|---|---|---|---|
| abap | 50 | 50 | 0 | 0 |
| actionscript-3 | 57 | 57 | 0 | 0 |
| ada | 201 | 200 | 1 | 0 |
| angular-expression | 96 | 96 | 0 | 0 |
| angular-html | 3 | 3 | 0 | 0 |
| angular-inline-style | 8 | 7 | 1 | 0 |
| angular-inline-template | 6 | 5 | 1 | 0 |
| angular-let-declaration | 4 | 4 | 0 | 0 |
| angular-template-blocks | 11 | 11 | 0 | 0 |
| angular-template | 2 | 2 | 0 | 0 |
| angular-ts | 366 | 365 | 1 | 0 |
| antlers | 46 | 46 | 0 | 0 |
| apache | 60 | 60 | 0 | 0 |
| apex | 190 | 190 | 0 | 0 |
| apl | 179 | 177 | 2 | 0 |
| applescript | 151 | 151 | 0 | 0 |
| ara | 54 | 54 | 0 | 0 |
| asciidoc | 314 | 310 | 4 | 0 |
| asm | 298 | 298 | 0 | 0 |
| astro | 62 | 60 | 2 | 0 |
| awk | 36 | 36 | 0 | 0 |
| ballerina | 232 | 232 | 0 | 0 |
| bat | 58 | 58 | 0 | 0 |
| beancount | 42 | 42 | 0 | 0 |
| berry | 18 | 17 | 1 | 0 |
| bibtex | 19 | 19 | 0 | 0 |
| bicep | 31 | 31 | 0 | 0 |
| blade | 338 | 336 | 2 | 0 |
| bsl | 82 | 82 | 0 | 0 |
| c | 177 | 177 | 0 | 0 |
| cadence | 128 | 128 | 0 | 0 |
| cairo | 19 | 19 | 0 | 0 |
| clarity | 43 | 43 | 0 | 0 |
| clojure | 38 | 38 | 0 | 0 |
| cmake | 23 | 22 | 1 | 0 |
| cobol | 138 | 138 | 0 | 0 |
| codeowners | 4 | 4 | 0 | 0 |
| codeql | 152 | 152 | 0 | 0 |
| coffee | 120 | 120 | 0 | 0 |
| common-lisp | 58 | 58 | 0 | 0 |
| coq | 27 | 27 | 0 | 0 |
| cpp-macro | 184 | 184 | 0 | 0 |
| cpp | 256 | 256 | 0 | 0 |
| crystal | 140 | 138 | 2 | 0 |
| csharp | 313 | 313 | 0 | 0 |
| css | 142 | 142 | 0 | 0 |
| csv | 1 | 1 | 0 | 0 |
| cue | 85 | 85 | 0 | 0 |
| cypher | 39 | 39 | 0 | 0 |
| d | 275 | 274 | 1 | 0 |
| dart | 76 | 76 | 0 | 0 |
| dax | 24 | 24 | 0 | 0 |
| desktop | 16 | 16 | 0 | 0 |
| diff | 16 | 16 | 0 | 0 |
| docker | 7 | 7 | 0 | 0 |
| dotenv | 9 | 9 | 0 | 0 |
| dream-maker | 54 | 54 | 0 | 0 |
| edge | 10 | 10 | 0 | 0 |
| elixir | 102 | 101 | 1 | 0 |
| elm | 68 | 68 | 0 | 0 |
| emacs-lisp | 152 | 152 | 0 | 0 |
| erb | 9 | 9 | 0 | 0 |
| erlang | 150 | 147 | 3 | 0 |
| es-tag-css | 9 | 9 | 0 | 0 |
| es-tag-glsl | 9 | 9 | 0 | 0 |
| es-tag-html | 11 | 11 | 0 | 0 |
| es-tag-sql | 7 | 7 | 0 | 0 |
| es-tag-xml | 7 | 7 | 0 | 0 |
| fennel | 31 | 31 | 0 | 0 |
| fish | 34 | 34 | 0 | 0 |
| fluent | 23 | 23 | 0 | 0 |
| fortran-fixed-form | 6 | 6 | 0 | 0 |
| fortran-free-form | 327 | 326 | 1 | 0 |
| fsharp | 120 | 120 | 0 | 0 |
| gdresource | 32 | 32 | 0 | 0 |
| gdscript | 95 | 92 | 3 | 0 |
| gdshader | 39 | 39 | 0 | 0 |
| genie | 20 | 20 | 0 | 0 |
| gherkin | 16 | 16 | 0 | 0 |
| git-commit | 9 | 9 | 0 | 0 |
| git-rebase | 4 | 4 | 0 | 0 |
| gleam | 26 | 26 | 0 | 0 |
| glimmer-js | 82 | 82 | 0 | 0 |
| glimmer-ts | 82 | 82 | 0 | 0 |
| glsl | 7 | 7 | 0 | 0 |
| gnuplot | 82 | 81 | 1 | 0 |
| go | 126 | 126 | 0 | 0 |
| graphql | 63 | 63 | 0 | 0 |
| groovy | 134 | 134 | 0 | 0 |
| hack | 305 | 304 | 1 | 0 |
| haml | 64 | 60 | 4 | 0 |
| handlebars | 64 | 64 | 0 | 0 |
| haskell | 164 | 151 | 13 | 0 |
| haxe | 175 | 175 | 0 | 0 |
| hcl | 67 | 66 | 1 | 0 |
| hjson | 55 | 55 | 0 | 0 |
| hlsl | 52 | 52 | 0 | 0 |
| html-derivative | 3 | 3 | 0 | 0 |
| html | 117 | 117 | 0 | 0 |
| http | 20 | 20 | 0 | 0 |
| hurl | 22 | 22 | 0 | 0 |
| hxml | 6 | 6 | 0 | 0 |
| hy | 12 | 12 | 0 | 0 |
| imba | 242 | 241 | 1 | 0 |
| ini | 11 | 11 | 0 | 0 |
| java | 142 | 142 | 0 | 0 |
| javascript | 378 | 377 | 1 | 0 |
| jinja-html | 0 | 0 | 0 | 0 |
| jinja | 35 | 35 | 0 | 0 |
| jison | 68 | 68 | 0 | 0 |
| json | 19 | 19 | 0 | 0 |
| json5 | 23 | 23 | 0 | 0 |
| jsonc | 19 | 19 | 0 | 0 |
| jsonl | 19 | 19 | 0 | 0 |
| jsonnet | 33 | 33 | 0 | 0 |
| jssm | 30 | 30 | 0 | 0 |
| jsx | 378 | 377 | 1 | 0 |
| julia | 95 | 95 | 0 | 0 |
| kdl | 30 | 29 | 1 | 0 |
| kotlin | 58 | 58 | 0 | 0 |
| kusto | 60 | 60 | 0 | 0 |
| latex | 214 | 210 | 4 | 0 |
| lean | 32 | 32 | 0 | 0 |
| less | 280 | 280 | 0 | 0 |
| liquid | 77 | 77 | 0 | 0 |
| llvm | 25 | 25 | 0 | 0 |
| log | 31 | 31 | 0 | 0 |
| logo | 9 | 9 | 0 | 0 |
| lua | 113 | 111 | 2 | 0 |
| luau | 90 | 89 | 1 | 0 |
| make | 51 | 51 | 0 | 0 |
| maml | 20 | 20 | 0 | 0 |
| markdown-vue | 2 | 2 | 0 | 0 |
| markdown | 123 | 121 | 2 | 0 |
| marko | 112 | 109 | 3 | 0 |
| matlab | 88 | 88 | 0 | 0 |
| mdc | 35 | 35 | 0 | 0 |
| mdx | 197 | 197 | 0 | 0 |
| mermaid | 139 | 139 | 0 | 0 |
| mipsasm | 17 | 17 | 0 | 0 |
| mojo | 216 | 211 | 5 | 0 |
| move | 117 | 117 | 0 | 0 |
| narrat | 34 | 34 | 0 | 0 |
| nextflow | 33 | 33 | 0 | 0 |
| nginx | 102 | 102 | 0 | 0 |
| nim | 114 | 114 | 0 | 0 |
| nix | 79 | 79 | 0 | 0 |
| nushell | 85 | 84 | 1 | 0 |
| objective-c | 223 | 223 | 0 | 0 |
| objective-cpp | 310 | 309 | 1 | 0 |
| ocaml | 178 | 178 | 0 | 0 |
| pascal | 23 | 23 | 0 | 0 |
| perl | 156 | 151 | 5 | 0 |
| php | 342 | 340 | 2 | 0 |
| pkl | 65 | 65 | 0 | 0 |
| plsql | 43 | 43 | 0 | 0 |
| po | 23 | 23 | 0 | 0 |
| polar | 31 | 31 | 0 | 0 |
| postcss | 47 | 47 | 0 | 0 |
| powerquery | 30 | 30 | 0 | 0 |
| powershell | 88 | 88 | 0 | 0 |
| prisma | 28 | 28 | 0 | 0 |
| prolog | 26 | 26 | 0 | 0 |
| proto | 33 | 33 | 0 | 0 |
| pug | 91 | 90 | 1 | 0 |
| puppet | 59 | 59 | 0 | 0 |
| purescript | 87 | 85 | 2 | 0 |
| python | 221 | 216 | 5 | 0 |
| qml | 38 | 38 | 0 | 0 |
| qmldir | 7 | 7 | 0 | 0 |
| qss | 31 | 31 | 0 | 0 |
| r | 85 | 79 | 6 | 0 |
| racket | 69 | 68 | 1 | 0 |
| raku | 52 | 51 | 1 | 0 |
| razor | 85 | 85 | 0 | 0 |
| reg | 9 | 9 | 0 | 0 |
| regexp | 34 | 34 | 0 | 0 |
| rel | 17 | 17 | 0 | 0 |
| riscv | 36 | 36 | 0 | 0 |
| rosmsg | 31 | 31 | 0 | 0 |
| rst | 64 | 61 | 3 | 0 |
| ruby | 209 | 203 | 6 | 0 |
| rust | 89 | 89 | 0 | 0 |
| sas | 32 | 32 | 0 | 0 |
| sass | 67 | 67 | 0 | 0 |
| scala | 115 | 115 | 0 | 0 |
| scheme | 34 | 34 | 0 | 0 |
| scss | 106 | 106 | 0 | 0 |
| sdbl | 22 | 22 | 0 | 0 |
| shaderlab | 38 | 38 | 0 | 0 |
| shellscript | 149 | 144 | 5 | 0 |
| shellsession | 2 | 2 | 0 | 0 |
| smalltalk | 43 | 43 | 0 | 0 |
| solidity | 103 | 103 | 0 | 0 |
| soy | 45 | 45 | 0 | 0 |
| sparql | 4 | 4 | 0 | 0 |
| splunk | 17 | 17 | 0 | 0 |
| sql | 68 | 68 | 0 | 0 |
| ssh-config | 12 | 12 | 0 | 0 |
| stata | 192 | 192 | 0 | 0 |
| stylus | 107 | 107 | 0 | 0 |
| svelte | 110 | 107 | 3 | 0 |
| swift | 338 | 337 | 1 | 0 |
| system-verilog | 102 | 102 | 0 | 0 |
| systemd | 32 | 32 | 0 | 0 |
| talonscript | 46 | 46 | 0 | 0 |
| tasl | 23 | 23 | 0 | 0 |
| tcl | 32 | 32 | 0 | 0 |
| templ | 76 | 76 | 0 | 0 |
| terraform | 68 | 67 | 1 | 0 |
| tex | 39 | 39 | 0 | 0 |
| toml | 44 | 44 | 0 | 0 |
| ts-tags | 0 | 0 | 0 | 0 |
| tsv | 1 | 1 | 0 | 0 |
| tsx | 378 | 377 | 1 | 0 |
| turtle | 15 | 15 | 0 | 0 |
| twig | 94 | 94 | 0 | 0 |
| txt | 0 | 0 | 0 | 0 |
| typescript | 366 | 365 | 1 | 0 |
| typespec | 73 | 73 | 0 | 0 |
| typst | 78 | 78 | 0 | 0 |
| v | 80 | 80 | 0 | 0 |
| vala | 20 | 20 | 0 | 0 |
| vb | 34 | 34 | 0 | 0 |
| verilog | 33 | 33 | 0 | 0 |
| vhdl | 85 | 85 | 0 | 0 |
| viml | 72 | 72 | 0 | 0 |
| vue-directives | 0 | 0 | 0 | 0 |
| vue-html | 36 | 36 | 0 | 0 |
| vue-interpolations | 0 | 0 | 0 | 0 |
| vue-sfc-style-variable-injection | 4 | 4 | 0 | 0 |
| vue-vine | 401 | 400 | 1 | 0 |
| vue | 72 | 70 | 2 | 0 |
| vyper | 241 | 236 | 5 | 0 |
| wasm | 78 | 78 | 0 | 0 |
| wenyan | 18 | 18 | 0 | 0 |
| wgsl | 44 | 44 | 0 | 0 |
| wikitext | 105 | 105 | 0 | 0 |
| wit | 79 | 79 | 0 | 0 |
| wolfram | 501 | 501 | 0 | 0 |
| xml | 31 | 31 | 0 | 0 |
| xsl | 5 | 5 | 0 | 0 |
| yaml | 51 | 50 | 1 | 0 |
| zenscript | 21 | 21 | 0 | 0 |
| zig | 51 | 51 | 0 | 0 |

## Genuine Failures

None — all patterns compiled successfully (excluding expected backreference end-patterns).

## Backreference End-Patterns (expected, not failures)

<details>
<summary>123 patterns across 53 grammars</summary>

**ada** (1)
- `(?i)(?:\b(end)\s+(\3|\4)\s*)?(;)`

**angular-inline-style** (1)
- `\1`

**angular-inline-template** (1)
- `\1`

**angular-ts** (1)
- `(\3)|(?=$|\*/)`

**apl** (2)
- `(?<=\s)(\2>)`
- `^.*?\2.*?$`

**asciidoc** (4)
- `^\1$`
- `(?<=\1)`
- `(?<=\1)$`
- `\1`

**astro** (2)
- `\1`
- `</\1\s*>|/>`

**berry** (1)
- `\1`

**blade** (2)
- `^(\3)\b`
- `^(\2)\b`

**cmake** (1)
- `\]\1\]`

**crystal** (2)
- `\s*\2\b`
- `\s*\1\b`

**d** (1)
- `\1"`

**elixir** (1)
- `\1[a-z]*`

**erlang** (3)
- `(\2)`
- `^(\s*(\3))(?!")`
- `^(\s*(\7))\s*([)]\s*)?(\.)`

**fortran-free-form** (1)
- `(?i)(?:^|(?<=;))(?=\s*\b\2\b)`

**gdscript** (3)
- `(\3)`
- `\1`
- `\2`

**gnuplot** (1)
- `^(\3)\b(.*)`

**hack** (1)
- `^(\2)(?=;?$)`

**haml** (4)
- `^(?!\1\s+|$\n*)`
- `^(?!\1\s+|\n)`
- `^(?=\1\s+|$\n*)`
- `(?m:(?<=\n)(?!\1\s+|$\n*))`

**haskell** (13)
- `(?x) # Detect end of class declaration:
         # 'where' keyword
   (?=(?<!')\bwhere\b(?!'))  
         # Decreasing indentation
   |(?=\}|;)      # Explicit indentation
   |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
       \1\s+\S    # - more indented, or
     | \s*        # - starts with whitespace, followed by:
       (?: $      #   - the end of the line (i.e. empty line), or
       |\{-[^@]   #   - the start of a block comment, or
       |--+       #   - the start of a single-line comment.
          (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                  # The double dash may not be followed by other operator characters
                  # (then it would be an operator, not a comment)
     )`
- `(?x) # Detect end of data declaration:
         # Deriving clause
   (?=(?<!')\bderiving\b(?!'))  
         # Decreasing indentation
   |(?=\}|;)      # Explicit indentation
   |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
       \1\s+\S    # - more indented, or
     | \s*        # - starts with whitespace, followed by:
       (?: $      #   - the end of the line (i.e. empty line), or
       |\{-[^@]   #   - the start of a block comment, or
       |--+       #   - the start of a single-line comment.
          (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                  # The double dash may not be followed by other operator characters
                  # (then it would be an operator, not a comment)
     )
`
- `(?x) # Detect end of pattern type definition by decreasing indentation:
  (?=\}|;)       # Explicit indentation
  |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
      \1\s+\S    # - more indented, or
    | \s*        # - starts with whitespace, followed by:
      (?: $      #   - the end of the line (i.e. empty line), or
      |\{-[^@]   #   - the start of a block comment, or
      |--+       #   - the start of a single-line comment.
         (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                 # The double dash may not be followed by other operator characters
                 # (then it would be an operator, not a comment)
    )
`
- `(?x) # Detect end of data declaration: 
     # Decreasing indentation
   (?=\}|;)      # Explicit indentation
   |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
       \1\s+\S    # - more indented, or
     | \s*        # - starts with whitespace, followed by:
       (?: $      #   - the end of the line (i.e. empty line), or
       |\{-[^@]   #   - the start of a block comment, or
       |--+       #   - the start of a single-line comment.
          (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                  # The double dash may not be followed by other operator characters
                  # (then it would be an operator, not a comment)
     )`
- `(?x) # Detect end of type family by decreasing indentation:
  (?=\}|;)       # Explicit indentation
  |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
      \1\s+\S    # - more indented, or
    | \s*        # - starts with whitespace, followed by:
      (?: $      #   - the end of the line (i.e. empty line), or
      |\{-[^@]   #   - the start of a block comment, or
      |--+       #   - the start of a single-line comment.
         (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                 # The double dash may not be followed by other operator characters
                 # (then it would be an operator, not a comment)
    )
`
- `(?x) # Detect end of type definition by decreasing indentation:
  (?=\}|;)       # Explicit indentation
  |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
      \1\s+\S    # - more indented, or
    | \s*        # - starts with whitespace, followed by:
      (?: $      #   - the end of the line (i.e. empty line), or
      |\{-[^@]   #   - the start of a block comment, or
      |--+       #   - the start of a single-line comment.
         (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                 # The double dash may not be followed by other operator characters
                 # (then it would be an operator, not a comment)
    )
`
- `(?=^(?!\1--+(?![\p{S}\p{P}&&[^(),;\[\]`{}_"']])))`
- `(?x) # Detect end of FFI block by decreasing indentation:
  (?=\}|;)       # Explicit indentation
  |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
      \1\s+\S    # - more indented, or
    | \s*        # - starts with whitespace, followed by:
      (?: $      #   - the end of the line (i.e. empty line), or
      |\{-[^@]   #   - the start of a block comment, or
      |--+       #   - the start of a single-line comment.
         (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                 # The double dash may not be followed by other operator characters
                 # (then it would be an operator, not a comment)
    )
`
- `\3\]`
- `\5\]`
- `(?x)
  # GADT constructor ends
  (?=\b(?<!'')deriving\b(?!'))  
        # Decreasing indentation
  |(?=\}|;)      # Explicit indentation
  |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
      \1\s+\S    # - more indented, or
    | \s*        # - starts with whitespace, followed by:
      (?: $      #   - the end of the line (i.e. empty line), or
      |\{-[^@]   #   - the start of a block comment, or
      |--+       #   - the start of a single-line comment.
         (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                 # The double dash may not be followed by other operator characters
                 # (then it would be an operator, not a comment)
    )
`
- `(?x) # Detect end of block by decreasing indentation:
  (?=\}|;)       # Explicit indentation
  |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
      \1\s+\S    # - more indented, or
    | \s*        # - starts with whitespace, followed by:
      (?: $      #   - the end of the line (i.e. empty line), or
      |\{-[^@]   #   - the start of a block comment, or
      |--+       #   - the start of a single-line comment.
         (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                 # The double dash may not be followed by other operator characters
                 # (then it would be an operator, not a comment)
    )`
- `(?x) # Detect end of deriving statement
  # Decreasing indentation
   (?=\}|;)      # Explicit indentation
  |^(?!          # Implicit indentation: end match on newline *unless* the new line is either:
      \1\s+\S    # - more indented, or
    | \s*        # - starts with whitespace, followed by:
      (?: $      #   - the end of the line (i.e. empty line), or
      |\{-[^@]   #   - the start of a block comment, or
      |--+       #   - the start of a single-line comment.
         (?![\p{S}\p{P}&&[^(),;\[\]{}`_"']]).*$) # non-symbol
                 # The double dash may not be followed by other operator characters
                 # (then it would be an operator, not a comment)
    )`

**hcl** (1)
- `^\s*\2\s*$`

**imba** (1)
- `(\3)|(?=$|\*/)`

**javascript** (1)
- `(\3)|(?=$|\*/)`

**jsx** (1)
- `(\3)|(?=$|\*/)`

**kdl** (1)
- `\2\1`

**latex** (4)
- `(\\end\{\2\}(?:\s*\n)?)`
- `\\end\{\1\}`
- `\\end\{\1\}(?:\s*\n)?`
- `(\\end\{\2\})`

**lua** (2)
- `(\]\2\])[ \t]*`
- `\]\1\][ \t]*`

**luau** (1)
- `\]\1\]`

**markdown** (2)
- `^ {,3}\1-*[ \t]*$|^[ \t]*\.{3}$`
- `^(?! {,3}\1-*[ \t]*$|[ \t]*\.{3}$)`

**marko** (3)
- `\1`
- `\2>`
- `/>|(?<=</>|</\2>)`

**mojo** (5)
- `(\2)`
- `(\3)|((?<!\\)\n)`
- `(\3)`
- `(\4)|((?<!\\)\n)`
- `(\4)`

**nushell** (1)
- `'\1`

**objective-cpp** (1)
- `\)\2(\3)"`

**perl** (5)
- `\2`
- `\1`
- `(?=\2)`
- `\1(?=[egimosradlupc]*x[egimosradlupc]*)\b`
- `^((?!\5)\s+)?((\6))$`

**php** (2)
- `^\s*(\3)(?![A-Za-z0-9_\x{7f}-\x{10ffff}])`
- `^\s*(\2)(?![A-Za-z0-9_\x{7f}-\x{10ffff}])`

**pug** (1)
- `(\G(?<!\5[^\w-]))|\}|$`

**purescript** (2)
- `^(?!\1[ \t]|[ \t]*$)`
- `^(?!\1[ \t]*|[ \t]*$)`

**python** (5)
- `(\3)`
- `(\4)`
- `(\2)`
- `(\4)|((?<!\\)\n)`
- `(\3)|((?<!\\)\n)`

**r** (6)
- `\]\1"`
- `\]\1'`
- `\}\1"`
- `\}\1'`
- `\)\1"`
- `\)\1'`

**racket** (1)
- `^\1$`

**raku** (1)
- `\3`

**rst** (3)
- `^\1(?=\s)|^\s*$`
- `^(?!\1\s|\s*$)`
- `^(?!\1[ \t]|$)`

**ruby** (6)
- `\1[eimnosux]*`
- `\1`
- `^\s*\2$\n?`
- `^\2$`
- `^\s*\6$`
- `^(?!\s*#\3\s{2,}|\s*#\s*$)`

**shellscript** (5)
- `(?<!\G)(?<=(?:\2))`
- `(?:(?:^\t*)(?:\3)(?=\s|;|&|$))`
- `(?:^(?:\3)(?=\s|;|&|$))`
- `(?:(?:^\t*)(?:\2)(?=\s|;|&|$))`
- `(?:^(?:\2)(?=\s|;|&|$))`

**svelte** (3)
- `\1`
- `(\3)`
- `</\1\s*>|/>`

**swift** (1)
- `/\1`

**terraform** (1)
- `^\s*\2\s*$`

**tsx** (1)
- `(\3)|(?=$|\*/)`

**typescript** (1)
- `(\3)|(?=$|\*/)`

**vue-vine** (1)
- `(\3)|(?=$|\*/)`

**vue** (2)
- `(\2)`
- `(?=\1)`

**vyper** (5)
- `(\3)`
- `(\4)|((?<!\\)\n)`
- `(\4)`
- `(\2)`
- `(\3)|((?<!\\)\n)`

**yaml** (1)
- `^(?!\1|\s*$)`

</details>
