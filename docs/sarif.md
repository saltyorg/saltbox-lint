# SARIF export

Generate a SARIF 2.1.0 report locally with an explicit source root:

```bash
saltbox-lint check --root . --format sarif -- roles resources > findings.sarif
```

Exit status is 0 for clean input, 1 for findings, and 2 for usage or operational
failure. A clean report has an empty `results` array. A usage or operational
failure is reported on stderr, rather than disguised as a clean SARIF report.
Generation does not upload anything. SARIF stdout stays plain JSON even with
`--color always`; it does not append to `GITHUB_STEP_SUMMARY`. `--diff` rejects
SARIF, and `--include-analysis` still requires `--format json`.

Each result contains the same primary diagnostic as the existing JSON renderer.
The rule descriptors project the rule registry, including explanations and good
and bad examples. `yaml-syntax` has a separate stable parser descriptor. Tool
version is the CLI build version, or `dev` for a development build.

Artifact URIs escape spaces, Unicode, percent signs and other URI delimiters.
Paths are relative to the selected source root, with `%SRCROOT%` declared in
`originalUriBaseIds`. `invocations[0].workingDirectory` identifies the same
absolute file URI, including for nested checkouts. Select a root that matches
the checkout used by an external code-scanning integration. Locations declare
`utf16CodeUnits`, with one-based columns and half-open ends. Related locations
use the same conversion against their own original source bytes.

## Finding identity

`partialFingerprints.saltboxLintContext/v1` is a SHA-256 identity over the rule,
root-relative source path, severity, diagnostic message and expected guidance,
exact nonblank source context, and the span's prefix and suffix within that
context. YAML parser messages are excluded because they can contain line numbers.
Identical contexts use their occurrence in the source, rather than the order of
findings in the report. Two spans on one line remain distinct, as do identical
findings in nearby repeated syntax. Related locations add their root-relative
paths, messages, source contexts, span prefixes and suffixes, and source
occurrences to the identity. This distinguishes findings with equal primary
fields that refer to separate includes, including identical repeated includes.
Related identities are sorted before hashing. Selecting fewer diagnostics or
reordering diagnostics or related locations does not change their identities.
Report-local fix IDs and physical line numbers are excluded.

Inserting blank-only lines before findings preserves their identities. Moving
the checkout to another absolute directory also preserves identities. Renaming
a primary or related source, or changing the selected root so its relative path
changes, creates a new identity. Editing primary or related diagnostic context,
messages or guidance can create a new identity. Inserting or removing an earlier
identical context in either source can change occurrence identities for later
copies. This version does not promise identity across arbitrary syntax edits or
duplicate reordering.

## Fixes and validation

The optional SARIF `fixes` property is omitted for all findings in this version.
Neither a verified automatic fix nor a manual display preview becomes a SARIF
replacement. Use explicit `check --fix` to apply the existing verified fixes;
SARIF reporting does not change that verifier or source preservation behavior.

Tests validate committed goldens offline against the
[OASIS SARIF 2.1.0 schema](https://github.com/oasis-tcs/sarif-spec/blob/a560296ca8c921f3bdb8d4a8db57ab83dae968a7/sarif-2.1/schema/sarif-schema-2.1.0.json).
The local schema SHA-256 is
`c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`.
The test validator is `github.com/santhosh-tekuri/jsonschema/v6` at `v6.0.2`,
pinned in `go.mod` and `go.sum`; schema loading rejects remote requests.
Coverage includes clean reports, parser findings, multiple rules, multiline and
related spans, Unicode with CRLF, unusual paths, nested roots, shared verified
fixes, manual previews, movement and duplicate identity, and JSON parity.

## External integration

[GitHub's SARIF support documentation](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support)
describes supported rule, result, location and fingerprint fields. Local schema
validation proves format validity; it does not establish that an upload occurred.
GitHub also imposes ingestion limits on report size and result counts.

To upload, separately configure a supported code-scanning integration with its
required permissions and repository features. Keep report generation and upload
as separate steps, and allow generation's findings exit status while failing on
exit 2. This repository's active workflows do not upload SARIF reports.

The [opt-in workflow example](../examples/github/sarif.yml) is an unwired template
for this repository. It builds the CLI from the current checkout, generates a
report for that checkout, and keeps upload in a separate step. It accepts exit
0 or 1 from generation and rejects every other status, including exit 2. Upload
defaults to disabled and runs only when the manual `upload` input is true after
the template is enabled. Copying it into `.github/workflows`, configuring code
scanning, and requesting an upload are separate operator actions. The template
uses published, commit-pinned
[checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-go v7.0.0](https://github.com/actions/setup-go/releases/tag/v7.0.0), and
[upload-sarif v4.38.2](https://github.com/github/codeql-action/releases/tag/v4.38.2).
It does not assume a published linter release already includes SARIF support.
