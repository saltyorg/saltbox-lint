// @ts-check
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishVSIX } from "@vscode/vsce";
import { manifest, targets, sha256, sourceName } from "./release-inputs.mjs";
import { readVSIX, verifyEntries } from "./verify-package.mjs";

/**
 * Validate the entire qualified batch before admitting any Marketplace upload.
 * @param {string} directory
 * @param {string} tag
 * @param {string} commit
 * @param {{readPackage?: typeof readVSIX, publish?: typeof publishVSIX}} [adapters]
 * @returns {Promise<string[]>}
 */
export async function publishMarketplace(
  directory,
  tag,
  commit,
  { readPackage = readVSIX, publish = publishVSIX } = {},
) {
  assert.equal(
    tag,
    `v${manifest.version}`,
    "Release tag must match the manifest",
  );
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(commit, /^[a-f0-9]{40}$/);
  const source = JSON.parse(
    readFileSync(join(directory, "SOURCE.json"), "utf8"),
  );
  assert.equal(source.version, manifest.version);
  assert.equal(source.commit, commit, "Source must match the release commit");
  assert.equal(
    source.build_kind,
    "stable",
    "Only stable artifacts can publish",
  );
  assert.equal(source.tracked_worktree_dirty, false);
  assert.equal(source.source_archive, sourceName);
  assert.equal(
    source.source_url,
    `https://github.com/saltyorg/saltbox-lint/releases/download/${tag}/${sourceName}`,
  );
  assert.equal(
    sha256(readFileSync(join(directory, sourceName))),
    source.source_sha256,
    "Corresponding source archive hash must match",
  );
  /** @type {{packages: {target: string, filename: string, sha256: string, binary_sha256: string}[]}} */
  const record = JSON.parse(
    readFileSync(join(directory, "vsix-artifacts.json"), "utf8"),
  );
  const { packages, ...recordSource } = record;
  assert.deepEqual(
    recordSource,
    source,
    "Package and source provenance differ",
  );
  assert.deepEqual(
    packages.map((entry) => entry.target).sort(),
    Object.keys(targets).sort(),
    "Exactly one package for each supported target is required",
  );
  const filenames = [];
  for (const entry of packages) {
    assert.equal(
      entry.filename,
      `saltbox-lint-${manifest.version}-${entry.target}.vsix`,
      "Package filename must match its target and version",
    );
    const path = join(directory, entry.filename);
    assert.equal(sha256(readFileSync(path)), entry.sha256, "VSIX hash changed");
    const files = await readPackage(path);
    const binary = files.get(
      `extension/bin/saltbox-lint${entry.target.startsWith("win32") ? ".exe" : ""}`,
    );
    assert.ok(binary, "Bundled CLI is missing");
    assert.equal(sha256(binary.bytes), entry.binary_sha256);
    verifyEntries(files, entry.target, source, binary.bytes);
    filenames.push(path);
  }
  assert.deepEqual(
    readdirSync(directory)
      .filter((name) => name.endsWith(".vsix"))
      .sort(),
    packages.map((entry) => entry.filename).sort(),
    "Unexpected VSIX outside the qualified package manifest",
  );
  await publish(filenames, { azureCredential: true });
  return filenames;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await publishMarketplace(
    resolve(process.argv[2] ?? "dist"),
    process.env.RELEASE_TAG ?? "",
    process.env.RELEASE_COMMIT ?? "",
  );
}
