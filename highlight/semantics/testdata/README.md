# Semantic oracle fixtures

`upstream-semantic-cases.json` was generated before the Go classifier from the
installed Red Hat Ansible 26.8.2 `doSemanticTokens` provider and its initialized
real `DocsLibrary` with 8,691 discovered modules. Its source cases live in the
controller evidence directory as `oracle-cases.json`; the reproducible runner is
`full-provider-oracle.mjs --cases`.
The installed semantic provider source SHA256 is
`9f0d3c8a4323ce393dc3e41bc4b2293d5fc378b486c2d38e07c5904a86845ddb`.

`demo-tasks.yml` and `demo-defaults.yml` are exact copies of the standalone v4
demo's `testdata/roles/web` source files. Their corresponding oracle JSON files
were generated from the same installed provider and real documentation library.
The JSON provider results retain the resolver, module-root and message evidence
captured by that run.

`decorated-scalar-keys.yml` and its oracle capture tagged, anchored and escaped
module and option keys from the same provider. They prove that semantic ranges
exclude YAML tag/anchor metadata while retaining the authored scalar spelling.

Provider coordinates and lengths are UTF-16 code units. Tests convert them to
half-open UTF-8 byte offsets independently before comparing the Go output.
