# Nuri WASM corresponding source

Dockerfile, build.sh and onig_scanner.c are copied byte-for-byte from the
checksum-verified Go module github.com/frostybee/nuri v1.0.1, wasm-build/.
The parent provenance files retain the module origin/checksum and local patches.
The release source export includes Oniguruma 6.9.10 source and tarball using the
URL/SHA-256 pin in extension/scripts/release-inputs.mjs.

The embedded resources/wasm/onig.wasm remains unchanged. These restored build
inputs complete its corresponding source; restoring them is not a claim that
this session reproduced the WASM bit-for-bit. Follow docs/extension-release.md
for isolated rebuild instructions. The original build.sh is retained as source,
but its fixed global Docker names make it unsuitable for a shared build host.
