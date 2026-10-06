# SARIF schema provenance

`sarif-schema-2.1.0.json` is the unchanged OASIS SARIF 2.1.0 JSON schema from
`oasis-tcs/sarif-spec` commit `a560296ca8c921f3bdb8d4a8db57ab83dae968a7`:
https://raw.githubusercontent.com/oasis-tcs/sarif-spec/a560296ca8c921f3bdb8d4a8db57ab83dae968a7/sarif-2.1/schema/sarif-schema-2.1.0.json

Size: 112768 bytes. SHA-256:
`c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`.
The schema bytes are retained unchanged. Upstream's
[license terms](https://github.com/oasis-tcs/sarif-spec/blob/a560296ca8c921f3bdb8d4a8db57ab83dae968a7/LICENSE.md)
apply to this schema.
Tests pin the digest and use `github.com/santhosh-tekuri/jsonschema/v6@v6.0.2`
with remote schema loading disabled. Normal test execution does not download
the schema. Golden refresh is explicit with
`SALTBOX_UPDATE_SARIF_GOLDENS=1 go test ./report -run TestSARIFGoldensAndSchema`.
