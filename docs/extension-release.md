# VS Code extension release

The extension identity is `saltyorg.saltbox-lint`, subject to owner verification of
publisher, extension name and display-name availability. No publisher account,
agreement acceptance or Marketplace publication is performed by local tooling.
First release uses manual VSIX upload in Microsoft's publisher management page.

## Local build and artifact contracts

Use Go from `go.mod`, Node from `extension/.node-version`, and npm from
`extension/package.json` (`packageManager`). `make check` is non-mutating to source:
Go format/tidiness/vet/lint/race gates, Linux GNU Make and editor-task harnesses,
TypeScript check/unit/release tests/format check, and workflow/GoReleaser validation.
It may populate ignored dependency, tool and test-binary caches. `make build` runs
that gate and builds the ordinary local CLI. `make catalog` remains Go-only.

`make snapshot` runs the gate, builds the extension bundle, exports corresponding
source into `bin/release-source`, then asks pinned GoReleaser to clean/build `dist`.
Only after GoReleaser finishes are the source and eight VSIX packages placed in
`dist`, so `--clean` cannot erase completed VSIXs. `make release-artifacts` performs
the same local work for a clean stable tag that exactly matches the manifest.
Neither command publishes anything.

`dist/vsix-artifacts.json` identifies the source archive/hash, exact Git revision,
source dirtiness, snapshot/stable kind and all VSIX/binary hashes and Go metadata.
`SOURCE-PROVENANCE.json` inside the source archive records every tracked input hash,
tool versions, dependency versions and the embedded Nuri WASM hash. Snapshots use
the manifest's numeric version because VSIX does not support SemVer prerelease
suffixes; `build_kind: snapshot` explicitly disqualifies them from publication.
A stable rebuild is a new artifact and must repeat native qualification.

The package builder stages only the runtime bundle, manifest, one matching binary,
README/changelog/support/privacy, GPL license, third-party notices, `SOURCE.json`
and inventoried license texts. The independent ZIP verifier rejects any other
entry, missing file, symlink, wrong binary/hash, unexpected executable, development
dependency, proposed API or unsupported target. Fixtures, tests, SDKs, maps,
node_modules and scratch examples cannot enter a VSIX through the allowlist.
Packaging runs on Linux to preserve executable bits. No runtime JS dependencies
are bundled; the host supplies the stable VS Code API and Node builtins.

## Corresponding source

Each binary distribution must have its exact `saltbox-lint_VERSION_source.tar.gz`
available at the URL recorded in its `SOURCE.json`, at no charge and without
credentials. Publish that archive alongside the release binaries **before**
distributing a Marketplace package; retain its availability for that release.
The generic GitHub source zip is insufficient: it omits vendored dependencies and
Oniguruma source. This implements the intended GPLv3 section 6(d) distribution
route; the owner must verify the actual distribution and terms at publication.

The archive includes tracked CLI/extension source and modifications to Nuri,
vendored Go dependencies, embedded grammar/theme assets and provenance, all
shipped licenses, the original Nuri `wasm-build` wrapper/build recipes and the
matching Oniguruma 6.9.10 source/tarball. Its HTTPS source URL and locally pinned
SHA-256 are recorded; the older upstream asset has no independently published
signature/digest. `ONIGURUMA_SOURCE_ARCHIVE=/absolute/path/onig-6.9.10.tar.gz` can
supply the already-verified tarball for an offline export.

To rebuild the CLI without downloading dependencies, unpack the archive, enter
`saltbox-lint-source`, install the recorded Go toolchain and run:

```sh
CGO_ENABLED=0 GOPROXY=off GOSUMDB=off go build -mod=vendor -buildvcs=false -trimpath \
  -ldflags '-s -w -X main.version=VERSION' -o saltbox-lint .
./saltbox-lint --version
```

Set `GOOS` and `GOARCH` to one of linux/darwin/windows and amd64/arm64 for another
target. `-buildvcs=false` is appropriate for an exported source tree without Git;
build metadata may differ from the release executable. Version, source and
behavior must match; this is not a byte-identical executable promise.
To rebuild the editor bundle, use the pinned Node/npm, `npm ci --ignore-scripts`
then `npm run build` in `extension`; the exact lockfile records build dependencies.

The embedded WASM is unchanged. Its matching C wrapper is
`third_party/nuri/wasm-build/onig_scanner.c`; the original Dockerfile records
Emscripten 3.1.61 and compiler flags. For an offline WASM build with that SDK, unpack
`source-deps/onig-6.9.10.tar.gz` into a temporary build directory, copy the wrapper,
run the `emconfigure`/`emmake` and `emcc` commands from the Dockerfile there, using
the included source instead of the Dockerfile's network download. Compare output
with the recorded WASM hash before replacing it. The upstream `build.sh` uses
fixed global Docker names and writes the reference WASM; do not run it against
a shared reference checkout. Source completeness is established here; a separate
WASM toolchain reproduction is not claimed by a normal CLI rebuild.

## Native qualification

Six CI runners execute normal Go tests, the patched Nuri suite, extension tests,
then smoke the binary extracted from the VSIX and run an installed-product host
suite at VS Code 1.100.0 and 1.137.0 (normal, regressions, trust and disabled modes).
Race testing runs on linux/darwin amd64/arm64 and windows/amd64; Go does not support
windows/arm64 race. Linux-specific Makefile tests retain Linux coverage while
the portable example-task test uses a native `.exe` suffix on Windows.
The Linux jobs also execute the Alpine VSIX binary in a pinned musl container of
the same native architecture, including diagnostics, formatting and embedded WASM
highlighting. Alpine has no desktop Electron SDK: Alpine remote-server extension
host acceptance remains an explicit manual gate.

For an existing SDK and locally built VSIX:

```sh
cd extension
npm run build
npm run stage:test-fixture
SALTBOX_TEST_VSIX=../dist/saltbox-lint-0.1.0-linux-x64.vsix \
  VSCODE_EXECUTABLE_PATH=/path/to/code npm run test:host
```

`SALTBOX_TEST_REGRESSIONS=1`, `SALTBOX_TEST_UNTRUSTED=1` and
`SALTBOX_TEST_DISABLED=1` select separate modes. Installed mode uses an isolated
extensions directory, installs/uninstalls through the real CLI, and uses a
separate temporary test-controller extension. The product is never supplied as
`extensionDevelopmentPath`; host assertions check its actual installation path.
The test-only failure executable is outside the VSIX. A development run without
`SALTBOX_TEST_VSIX` is useful but cannot qualify a release package.

Local Linux x64 results do not qualify Windows, macOS, ARM or remote hosts.
Failures and unavailable native runners block publication for those targets.
Record SDK version/commit, artifact hash, host architecture and raw logs, including
upstream Electron noise; don't report cross-compilation as native execution.

## Owner publication checklist

Recheck the authoritative links below immediately before release.

- Verify `saltyorg` publisher ownership, extension/display-name availability and
  permitted Saltbox branding. No copied competitor promotions, unsupported badges
  or invented logos/screenshots. Any future images must meet HTTPS/SVG rules and
  have redistribution rights; any icon must meet Microsoft's raster requirements.
- Obtain explicit authorization for the exact Microsoft account/publisher target,
  account creation/access and Publisher Agreement/Participation Policies acceptance.
  Record the acceptance date: Participation Policies section 2 requires publishing
  at least one offering within 60 days of executing the Publisher Agreement.
- Verify accurate metadata, engine floor, target matrix, local executable/Git
  disclosure, GPL license, privacy/no telemetry, support and private security
  reporting channel. Confirm dependency/platform support and no proposed APIs.
- Complete native artifact/host gates and manual Remote SSH, WSL, Dev Container
  and Alpine remote-host placement, install, real previous-version upgrade,
  disable/re-enable, uninstall and formatter-coexistence checks. Fresh installs or
  forced same-version reinstalls do not prove upgrades.
- Inspect final package permissions, executable identities, signing/Marketplace
  validation status and source/license hashes. Local VSIXs are unsigned; do not
  claim a Microsoft signature before Marketplace processing/verification.
- Authorize the exact GitHub release/tag/source upload actions and targets
  separately. Make the matching source URL publicly downloadable at no charge;
  verify the downloaded archive hash against each VSIX before Marketplace upload.
- Obtain separate authorization for manual upload of the exact eight reviewed
  VSIX hashes to publisher `saltyorg`, extension `saltbox-lint`, version VERSION.
  No PAT, account credentials or automated Marketplace publishing is needed for
  local work. Do not infer authority to push, tag, dispatch CI or accept terms.
- After upload, verify Marketplace processing/signatures, the platform routing,
  listing, installation and adjacent source availability. Microsoft decides
  acceptance; local packaging success does not predict that decision.

Sources reviewed 2026-09-12: [publishing/platform packages](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
[manifest](https://code.visualstudio.com/api/references/extension-manifest),
[stable/proposed APIs](https://code.visualstudio.com/api/advanced-topics/using-proposed-api),
[workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust),
[remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions),
[Marketplace policies](https://aka.ms/vsmarketplace-policies),
[Publisher Agreement](https://cdn.vsassets.io/v/M187_20210610.3/_content/Visual-Studio-Marketplace-Publisher-Agreement.pdf),
[GPLv3 section 6](https://www.gnu.org/licenses/gpl-3.0.html#section6),
[native runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The policies redirect still resolves to the June 2021 PDF; use the currently
presented terms at actual account acceptance, not this historical copy alone.
