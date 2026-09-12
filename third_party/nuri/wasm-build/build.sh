#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building onig.wasm via Docker..."
docker build -t nuri-onig-build .
docker create --name nuri-onig-extract nuri-onig-build
docker cp nuri-onig-extract:/build/onig.wasm ../resources/wasm/onig.wasm
docker rm nuri-onig-extract

echo "Done. onig.wasm copied to resources/wasm/"
ls -la ../resources/wasm/onig.wasm
