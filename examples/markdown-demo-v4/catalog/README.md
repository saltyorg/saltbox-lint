# Frozen module catalog

`make catalog` reads the installed Saltbox Ansible environment through
`/usr/local/bin/ansible-doc` and `/usr/local/bin/ansible-galaxy`, using
`/srv/git/saltbox/ansible.cfg`, `/srv/git/saltbox/library`, the Saltbox playbook
directory, and discovered collection locations. It does not run modules, roles,
or playbooks. Logging is directed to `/dev/null` and Python bytecode writes are
disabled. The generated JSON contains module IDs, actual source paths and
hashes, option types/aliases/suboptions, module routing, installed versions,
input hashes and explicit metadata problems. Descriptions, defaults and
examples are discarded.

`make build` regenerates the catalog, runs the non-mutating `make check`, then
builds the demo. For an offline build from the checked-in snapshot, run:

```sh
CGO_ENABLED=0 go build -o ../../bin/markdown-demo-v4 .
```

The finished binary loads only embedded JSON. No Ansible, Python, Node or
filesystem module lookup is needed at runtime.

## Resolution contract

`Load` returns a catalog. `Resolve` takes a module name and `ResolveContext`;
its `Collections` field is ordered metadata collections followed by inline
collections. Short names try `ansible.builtin` first. All candidates are checked
for the first route before direct module lookup. Redirects take one hop to a
module entry, and missing redirect targets do not fall back. This intentionally
matches the installed Ansible language server, including its tombstone lookup
behavior.

Custom module locations receive the language server's virtual
`ansible.builtin.<basename>` ID, with actual library provenance retained.
CLI discovery aliases such as `ansible.legacy.port_assignment` are recorded
but do not become extra accepted semantic lookup names. `FindOption` resolves
exact canonical option names or aliases. Module existence is independent of
`DocumentationAvailable`.

## Deliberate limits

This snapshot approximates one installed editor environment. It does not scan
arbitrary document-adjacent collections at runtime or fetch execution-environment
documentation. Callers own metadata/inline collection extraction. Installed
collection roots come from configured paths and the CLI collection inventory;
the reference environment's inventory is checked independently against the
language server. Different duplicate collection installations can have different
Python search-path ordering and require a fresh comparison.

The file-list adapter uses the stable `ansible-doc -F` text format because
Ansible core 2.21.2 fails to serialize byte-valued source paths with `-F -j`.
Option schemas come from static Python triple-quoted assignments using the
language server 26.8.2 discovery and fragment merge rules. In particular,
underscore-prefixed documentation fragments are excluded even though the
Ansible CLI expands them. This prevents richer CLI schemas from adding
argument highlighting the editor does not produce. Missing documentation,
missing fragments, and parsing failures are recorded separately; command
failures and malformed collection metadata fail generation and preserve the
previous snapshot. No Python module code executes.

The Go YAML parser does not reproduce the JavaScript parser's partial recovery
from malformed documentation, its alias-expansion budget, or shared regular
expression state after exceptions. These differences are recorded as a parser
compatibility limitation in every snapshot. Full source-inventory parity does
not imply identical option coverage for every exceptional document.

The fixtures retain actual DOCUMENTATION assignments from installed module
sources (core 2.21.2; community.docker 5.2.1) plus the exact managed
`ansible-doc -F` file-list records. Generated output discards prose, defaults,
examples and module implementation. The full snapshot carries current
provenance and coverage gaps.
