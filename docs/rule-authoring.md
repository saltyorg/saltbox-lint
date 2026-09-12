# Authoring a rule

Rules own policy and metadata. Source analysis owns parsing/classification,
commands own I/O and exit handling, and reporters own presentation. A rule
receives a `*lint.Project` and `*lint.Source` and returns standard diagnostics;
it does not print, start processes, read environment variables or execute
Ansible/Jinja. Use the existing shared analysis before inventing a new scanner.

## Real example: ansible-static-import

The `ansible-static-import` entry in [`lint/rules.go`](../lint/rules.go) applies
to tasks, handlers and playbooks with file scope. It declares a summary,
explanation, good and bad YAML examples, and its `Check` function. `Fixable`
remains false because changing an import to an include changes semantics.
A shortened registry entry showing the same public contract is:

```go
Rule{
    ID:          "ansible-static-import",
    Summary:     "Use dynamic Ansible includes",
    Explanation: "Static task and role imports are rejected on actual tasks, with the corresponding include alternative. This semantic change is not an automatic fix.",
    GoodExample: "- include_tasks: example.yml\n",
    BadExample:  "- import_tasks: example.yml\n",
    Kinds:       []Kind{Tasks, Handlers, Playbook},
    Scope:       "file",
    Check:       checkAnsibleStaticImports,
}
```

Its implementation in [`lint/rules_ansible.go`](../lint/rules_ansible.go) consumes
`TasksIn(s)`. That shared analysis normalizes short/FQCN module keys,
`action`/`local_action`, nested task blocks and playbooks while excluding
arbitrary data mappings. The checker checks `task.Module` for `import_tasks` or
`import_role`, selects `include_tasks` or `include_role` for its Expected hint,
and returns an error diagnostic spanning `task.ModuleSpan` in `s.Path`.

```yaml
# Invalid task (tasks/main.yml)
- ansible.builtin.import_tasks: setup.yml

# Expected manual correction
- ansible.builtin.include_tasks: setup.yml
```

The real `TestAnsibleStaticImports` in
[`lint/rules_ansible_test.go`](../lint/rules_ansible_test.go) exercises both import
kinds and scalar/mapping/FQCN action forms, checks the exact module span and
replacement hint, and proves that a payload mapping containing `import_tasks`
is not a task. `TestAnsibleStructuralActions` additionally establishes the shared
normalizer's nested block/handler/playbook behavior. Read these tests before
adding a new task policy.

## Development sequence

1. State the distinct policy, source kinds, and minimum context. Add a failing
   behavioral test using a real parsed source and an independently specified
   expected span/message hint. Include valid input that remains valid. For
   source-sensitive layouts, keep good/bad golden pairs in `lint/testdata`.
2. Implement the smallest checker using `TasksIn`, `Expressions`, `Calls`,
   `VariableReads`, and parsed nodes as appropriate. Keep related but distinct
   policies separate. Do not duplicate task parsing, Jinja scanning or rule
   lists in CLI/editor/Action adapters.
3. Register the complete metadata in `Rules()`. The CLI's `rules` and
   `rules <id>` output and all diagnostic renderers consume that registry;
   no adapter-specific registration is needed. The catalog test runs good/bad
   metadata examples through their rule and checks required fields. Examples
   should demonstrate the actual valid contract, including required context.
4. For role/resource scope, exercise the real loader with required context,
   malformed/missing context, and selected-file boundaries. Keep primary
   locations on the responsible source and add related locations for evidence.
   `Analyze` filters by selected primary path and deterministically sorts and
   deduplicates findings; do not reimplement that filtering in each checker.
5. Offer a fix only for provably safe formatting. Byte spans are half-open
   UTF-8 offsets into the original `Source.Data`. Preserve comments, literal
   text, exact Jinja tokens/string contents and YAML styles/tags/structure.
   Exercise `PlanFixes`/`WriteChanges`, reparse, check idempotence and ensure
   already-valid inputs remain byte-identical. Uncertain syntax stays visible
   as a diagnostic with no fix. Keep automated regressions in `lint/testdata`.
   `examples.yaml` is optional local scratch input; preserve it and keep it out
   of Git and test dependencies.
6. For an exact manual suggestion, attach `Preview{Edits: ...}` using original
   byte spans on the primary source. Keep this separate from `Fix`: previews
   never enter `PlanFixes`, patches, fix counts, JSON or GitHub annotations. Do
   not duplicate existing `Fix.Edits` into Preview. The reporter validates and
   reconstructs a full candidate through `PreviewChange`, then shows a compact
   comparison. Do not build previews by parsing Expected prose or inventing
   replacements for ambiguous syntax. Decline unsupported shapes and retain
   Expected guidance. Test exact candidate bytes, source preservation, valid
   YAML, removal of the targeted finding, and unchanged fix authority. Shared
   file-wide formatting proposals are deduplicated by the renderer.
7. Run the focused test through RED/GREEN, then `make check` and `make build`.
   Request independent specification and code-quality review. Record deliberate
   differences from the frozen legacy corpus instead of weakening a rule to
   obtain a clean result. Consumer validation is read-only and never executes
   consumer roles.

For the concrete example above, a focused command is:

```sh
go test ./lint -run 'TestAnsible(StaticImports|StructuralActions)' -count=1
go run . rules ansible-static-import
make check
```

Use a focused Conventional Commit, stage exact paths, and preserve unrelated
work. Local implementation and validation do not authorize consumer edits,
pushes, tags, releases or workflow dispatches.
