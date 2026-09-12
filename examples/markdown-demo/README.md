# Linter output mockup — version 2

Standalone mockup of one Saltbox Lint finding: rule, location, explanation,
current YAML, expected YAML, fix availability, and summary. Both code samples
are fenced YAML Markdown, rendered by Glamour with their indentation intact.
The finding is hard-coded in `example.md`; this demo does not import or run
the linter.

From this directory:

```sh
go run .
```

The demo uses Glamour's dark style with the visible `##` and `###` heading
prefixes removed. It emits ANSI styling directly.

Version 2 adds a muted, right-aligned line-number gutter beside each YAML
block. Numbers are added after YAML tokenization, so the source itself stays
unchanged. Both excerpts start at source line 99, demonstrating the transition
from two-digit to three-digit numbers. The location points to the offending
condition at line 102, column 9. The gutter width is calculated from the last
displayed line number and stays fixed throughout each block.

From the repository root, compare the built versions:

```sh
./bin/markdown-demo-v1
./bin/markdown-demo-v2
```

The original source is preserved in `../markdown-demo-v1`. The existing
`./bin/markdown-demo` command runs version 2.
