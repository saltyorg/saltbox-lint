import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { open } from "yauzl";
import { manifest, targets, sha256 } from "./release-inputs.mjs";

export function readVSIX(path) {
  return new Promise((resolve, reject) => {
    open(path, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map();
      zip.on("error", reject);
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry) => {
        if (files.has(entry.fileName)) {
          zip.close();
          reject(new Error(`Duplicate entry: ${entry.fileName}`));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = [];
          stream.on("error", reject);
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            files.set(entry.fileName, {
              bytes: Buffer.concat(chunks),
              mode: entry.externalFileAttributes >>> 16,
            });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
export function verifyEntries(files, target, source, expectedBinary) {
  assert.ok(targets[target], `Unsupported target: ${target}`);
  const binary = `extension/bin/saltbox-lint${target.startsWith("win32") ? ".exe" : ""}`;
  const required = [
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/dist/extension.js",
    binary,
    ...[
      "readme.md",
      "changelog.md",
      "SUPPORT.md",
      "PRIVACY.md",
      "LICENSE.txt",
      "THIRD_PARTY_NOTICES",
      "SOURCE.json",
    ].map((name) => `extension/${name}`),
    "extension/licenses/inventory.json",
    ...Object.keys(source.licenses).map((name) => `extension/licenses/${name}`),
  ];
  assert.deepEqual(
    [...files.keys()].sort(),
    required.sort(),
    "VSIX must contain exactly the audited runtime allowlist",
  );
  for (const [name, entry] of files) {
    assert.notEqual(entry.mode & 0o170000, 0o120000, `No symlinks: ${name}`);
    if (name !== binary)
      assert.equal(entry.mode & 0o111, 0, `Unexpected executable: ${name}`);
  }
  assert.ok(
    files.get(binary).mode & 0o111,
    "Bundled binary must be executable in the ZIP",
  );
  assert.equal(
    sha256(files.get(binary).bytes),
    sha256(expectedBinary),
    "Wrong platform binary",
  );
  const packaged = JSON.parse(files.get("extension/package.json").bytes);
  assert.equal(packaged.version, manifest.version);
  assert.equal(
    `${packaged.publisher}.${packaged.name}`,
    "saltyorg.saltbox-lint",
  );
  assert.equal(packaged.main, "./dist/extension.js");
  assert.equal(packaged.browser, undefined);
  assert.equal(packaged.enabledApiProposals, undefined);
  assert.equal(packaged.dependencies, undefined);
  assert.equal(packaged.devDependencies, undefined);
  assert.match(
    files.get("extension.vsixmanifest").bytes.toString(),
    new RegExp(`TargetPlatform="${target}"`),
  );
  assert.deepEqual(
    JSON.parse(files.get("extension/SOURCE.json").bytes),
    source,
  );
  assert.deepEqual(
    JSON.parse(files.get("extension/licenses/inventory.json").bytes),
    source.licenses,
  );
  for (const [path, hash] of Object.entries(source.licenses))
    assert.equal(
      sha256(files.get(`extension/licenses/${path}`).bytes),
      hash,
      `License changed: ${path}`,
    );
}
export async function verifyPackage(path, target, source, binaryPath) {
  const entries = await readVSIX(path);
  verifyEntries(entries, target, source, readFileSync(binaryPath));
  return entries;
}

// CLI archives carry the same license inventory and source identity as VSIXs.
export async function verifyCLIArchives(directory, source) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { run } = await import("./release-inputs.mjs");
  const unique = new Map(
    Object.values(targets).map(([os, arch]) => [`${os}_${arch}`, os]),
  );
  for (const [target, os] of unique) {
    const path = join(
      directory,
      `saltbox-lint_${manifest.version}_${target}.${os === "windows" ? "zip" : "tar.gz"}`,
    );
    const temp = mkdtempSync(join(tmpdir(), "saltbox-cli-archive-"));
    try {
      let read;
      if (os === "windows") {
        const entries = await readVSIX(path);
        read = (name) => {
          assert.ok(entries.has(name), `Missing CLI archive file ${name}`);
          return entries.get(name).bytes;
        };
      } else {
        run("tar", ["-xzf", path, "-C", temp]);
        read = (name) => readFileSync(join(temp, name));
      }
      assert.deepEqual(JSON.parse(read("SOURCE.json")), source);
      assert.deepEqual(
        JSON.parse(read("licenses/inventory.json")),
        source.licenses,
      );
      for (const [name, hash] of Object.entries(source.licenses))
        assert.equal(
          sha256(read(`licenses/${name}`)),
          hash,
          `CLI license ${target}/${name}`,
        );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}
