# Linter output mockup

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
