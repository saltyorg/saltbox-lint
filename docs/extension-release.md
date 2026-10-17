# Extension packaging and release validation

The [platform table](platforms.md) maps six standalone CLI targets to eight
VSIX targets. `extension/scripts/release-inputs.mjs` owns the VSIX map;
`.goreleaser.yaml` defines native archives. Tests require CI coverage for every
native release target. Packages include a CGO-free CLI, licenses and source
provenance. The release workflow publishes GitHub assets first, then uploads the
same qualified VSIXs to Visual Studio Marketplace.

## Local packaging

Use the Go version in `go.mod`, Node in `extension/.node-version` and npm 11.19.0.
Native Linux and Darwin release tests also require a pthread-capable `cc` for
the live-thread cleanup fixture. Windows staging tests require PowerShell 7.
These tools are development prerequisites; installed extensions need neither.
From the repository root:

```sh
make check
make snapshot
```

`make snapshot` repeats the quality gate and creates six CLI archives, eight
VSIXs, checksums, `SOURCE.json`, `vsix-artifacts.json` and corresponding source in
ignored `dist/`. It publishes nothing. `make release-artifacts` requires a stable
tag and matching extension manifest version, and also creates local artifacts.
The release scripts verify archive/ZIP structure, binary identity and source
hashes. The source archive includes vendored modules, modified Nuri and its WASM
wrapper, matching Oniguruma source, license texts and build instructions.

## Required CI coverage

The [CI workflow](../.github/workflows/ci.yml) checks and packages artifacts on
Linux, independently runs source suites on all six native targets, and runs
packaged acceptance on those same targets. Installed VSIX tests use the minimum
and current editor versions configured in the host test scripts. Both Linux
architectures also run Alpine musl probes. Windows arm64 lacks a Go race runtime;
its ordinary Go and extension suites still run. Alpine probes do not constitute
an installed editor host suite.

Inspect the exact final commit SHA, every required job and matrix result, and the
artifact manifest before claiming readiness. `CI required` aggregates packaging,
all native checks and all packaged acceptance jobs. Pending, failed, cancelled or
unexpectedly skipped required coverage is incomplete. A local Linux check or a
cross-built archive does not establish correctness on other platforms.

Optional corpus, loader-semantic and performance qualification uses
[tools/qualification](../tools/qualification/README.md). Its operator-owned inputs
and reports are separate from routine CI. Historical qualification reports are
not shipped here; do not treat missing reports as measured results.

## CI job summaries

Each job writes one result summary after its checks, including failed or
cancelled runs. The final `CI required` summary reports the build, native and
installed-package groups. Its matrix total describes configured coverage;
each platform's acceptance summary supplies actual editor-profile results.

Editor results come from atomic checkpoints outside the profile fixtures.
A profile passes only after its work, process owners and cleanup have joined.
Failed and unrun profiles remain visible. Missing, stale or malformed evidence
cannot establish completed coverage. A successful editor step with invalid
evidence fails the reporting step.

The summaries link successful package and vulnerability artifact uploads and
explain the Windows arm64 race and Alpine coverage limits. Full diagnostics,
digests and provenance stay in logs and artifacts. If checkout or Node setup
prevents the reporter from running, the terminal step writes an unavailable
report instead of claiming that checks passed. Successful reporting also writes
the same Markdown to the job log for inspection.

## Publication

Agree the version and exact commit, validate that commit, and obtain explicit
release authorization before creating or pushing a release tag. The
[release workflow](../.github/workflows/release.yml) publishes artifacts for an
exact stable version tag after its CI gates. Verify the remote tag target,
successful publication and all expected assets. Changes after validation require
validation again. Release authorization must cover both the GitHub release and
the automatic Marketplace upload. Consumer version updates require separate
authorization.

Keep the extension manifest and lockfile versions aligned, and add a matching
version heading to `extension/CHANGELOG.md`. The release workflow prepends that
section to GitHub's generated release notes and refuses a missing section.

### Marketplace authentication and upload

The release workflow uses the GitHub environment `marketplace-publish`. Its
environment secrets `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` identify a
user-assigned Azure managed identity. GitHub authenticates through OpenID
Connect; no stored access token or client password is needed. Azure must trust
the repository's exact environment subject, including numeric owner/repository
IDs when GitHub uses immutable subjects. Query the repository's actual
configuration before creating that credential:

```sh
gh api repos/saltyorg/saltbox-lint/actions/oidc/customization/sub
```

Create the Azure federated credential for entity type **Environment**, named
`marketplace-publish`, using issuer `https://token.actions.githubusercontent.com`
and audience `api://AzureADTokenExchange`. The managed identity must be a
**Contributor** of the `saltyorg` Marketplace publisher. Its Marketplace member
ID comes from the Azure DevOps profile API after authenticating as that
identity; it differs from its Azure Client ID and Principal ID. The manual-only
[identity workflow](../.github/workflows/marketplace-identity.yml) retrieves this
ID. Running that setup workflow requires operator authorization and does not
publish an extension. See Microsoft's [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
and GitHub's [OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

The Marketplace job waits for the GitHub release, including the corresponding
source archive, to be published. It downloads the qualified artifacts from the
same workflow run, checks their checksums, and uses the pinned `@vscode/vsce`
public API to upload the existing VSIXs. It does not rebuild them or change
their version. Before admitting any upload,
[`publish-marketplace.mjs`](../extension/scripts/publish-marketplace.mjs)
requires the stable tag, clean source provenance and commit to agree, verifies
the source archive hash, and audits all eight target packages and bundled CLI
hashes. A missing, duplicate, extra or changed package fails the job. Upload
errors remain failures, including an already-published target/version.

The identity's tenant-level login uses `allow-no-subscriptions`; publishing
requires no Reader or Contributor access to the Azure subscription. The
subscription is still needed to own the managed identity. Successful login and
publisher membership do not establish a successful extension upload. Verify
the release job results and all eight Marketplace targets after an authorized
release.

The published [v0.1.0 GitHub release](https://github.com/saltyorg/saltbox-lint/releases/tag/v0.1.0)
is dated 2026-09-20 and targets commit
`e2716109d86c56863c6182d1659f97f379622a3b`. Its assets include six standalone CLI
archives and eight VSIXs. This publication fact does not establish Marketplace
availability or qualify subsequent commits. See the [changelog](../extension/CHANGELOG.md)
for released and subsequent changes.
