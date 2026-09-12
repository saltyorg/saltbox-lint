import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyEntries } from "../scripts/verify-package.mjs";
import { manifest } from "../scripts/release-inputs.mjs";

// Hand-written minimal VSIX boundary fixture. Extra bytes or wrong executable
// identities must be refused before a release artifact can be handed off.
function fixture() {
  const files = new Map();
  const text = (name, value = "notice", mode = 0o100644) =>
    files.set(name, { bytes: Buffer.from(value), mode });
  for (const path of [
    "[Content_Types].xml",
    "extension/dist/extension.js",
    "extension/readme.md",
    "extension/changelog.md",
    "extension/SUPPORT.md",
    "extension/PRIVACY.md",
    "extension/LICENSE.txt",
    "extension/THIRD_PARTY_NOTICES",
  ])
    text(path);
  text("extension.vsixmanifest", '<Identity TargetPlatform="linux-x64" />');
  text(
    "extension/package.json",
    JSON.stringify({
      name: "saltbox-lint",
      publisher: "saltyorg",
      version: manifest.version,
      main: "./dist/extension.js",
    }),
  );
  text("extension/SOURCE.json", '{"licenses":{}}');
  text("extension/licenses/inventory.json", "{}");
  text("extension/bin/saltbox-lint", "native x64 binary", 0o100755);
  return files;
}
const source = { licenses: {} };
const expected = Buffer.from("native x64 binary");
test("only the audited runtime allowlist and matching executable are accepted", () => {
  verifyEntries(fixture(), "linux-x64", source, expected);
  for (const unexpected of [
    "extension/bin/process-fixture",
    "extension/node_modules/keytar/index.js",
    "extension/.env",
    "extension/examples.yaml",
    "extension/dist/test/host.js",
    "extension/bin/second-platform",
  ]) {
    const files = fixture();
    files.set(unexpected, { bytes: Buffer.from("unexpected"), mode: 0o100644 });
    assert.throws(
      () => verifyEntries(files, "linux-x64", source, expected),
      /allowlist/,
    );
  }
  const wrong = fixture();
  wrong.get("extension/bin/saltbox-lint").bytes =
    Buffer.from("native ARM binary");
  assert.throws(
    () => verifyEntries(wrong, "linux-x64", source, expected),
    /Wrong platform binary/,
  );
});
test("executable permissions, source identity and explicit target cannot drift", () => {
  const missing = fixture();
  missing.get("extension/bin/saltbox-lint").mode = 0o100644;
  assert.throws(
    () => verifyEntries(missing, "linux-x64", source, expected),
    /executable/,
  );
  const symlink = fixture();
  symlink.get("extension/readme.md").mode = 0o120644;
  assert.throws(
    () => verifyEntries(symlink, "linux-x64", source, expected),
    /symlinks/,
  );
  const stale = fixture();
  stale.get("extension/SOURCE.json").bytes = Buffer.from(
    '{"licenses":{},"source_sha256":"stale"}',
  );
  assert.throws(() => verifyEntries(stale, "linux-x64", source, expected));
  assert.throws(
    () => verifyEntries(fixture(), "web", source, expected),
    /Unsupported target/,
  );
  assert.throws(
    () => verifyEntries(fixture(), "linux-arm64", source, expected),
    /TargetPlatform/,
  );
});
