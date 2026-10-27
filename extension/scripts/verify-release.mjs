// @ts-check
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  manifest,
  targets,
  sha256,
  sourceName,
  run,
} from "./release-inputs.mjs";
import { readVSIX, verifyEntries } from "./verify-package.mjs";

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Select the stable tag being packaged. A tag-triggered workflow names its exact
 * ref; local packaging must find the manifest tag among every tag on HEAD.
 * @param {Record<string, string | undefined>} env
 * @param {(args: string[]) => string} git
 * @returns {string}
 */
export function resolveStableTag(env, git) {
  const expected = `v${manifest.version}`;
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (
    env.GITHUB_REF_TYPE === "tag" ||
    env.GITHUB_REF?.startsWith("refs/tags/")
  ) {
    const tag = env.GITHUB_REF_NAME ?? "";
    assert.equal(tag, expected, "Stable tag must match extension/package.json");
    assert.equal(
      git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).trim(),
      head,
      "Stable tag must point at the checked-out commit",
    );
    return tag;
  }
  const tags = git(["tag", "--points-at", "HEAD"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(
    tags.includes(expected),
    `Stable tag ${expected} must point at HEAD (found: ${tags.join(", ") || "none"})`,
  );
  return expected;
}

/**
 * Resolve the commit a remote tag currently names, peeling annotated tags.
 * @param {string} lsRemoteOutput output of git ls-remote for the tag refs
 * @param {string} tag
 * @returns {string}
 */
export function remoteTagCommit(lsRemoteOutput, tag) {
  const direct = [];
  const peeled = [];
  for (const line of lsRemoteOutput.split("\n")) {
    if (!line.trim()) continue;
    const [sha, ref, ...rest] = line.split("\t");
    assert.equal(rest.length, 0, `Unexpected ls-remote line: ${line}`);
    if (ref === `refs/tags/${tag}`) direct.push(sha);
    else if (ref === `refs/tags/${tag}^{}`) peeled.push(sha);
  }
  assert.equal(direct.length, 1, `Remote tag ${tag} must exist exactly once`);
  assert.ok(peeled.length <= 1, `Remote tag ${tag} peels ambiguously`);
  const commit = peeled[0] ?? direct[0];
  assert.match(commit, /^[a-f0-9]{40}$/, "Remote tag must name a commit");
  return commit;
}

/** @param {string} tag @returns {string} */
function lsRemote(tag) {
  return run("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
}

/** @param {string} name */
export function isReleaseAsset(name) {
  return (
    !name.includes("/") &&
    (name.endsWith(".vsix") ||
      name.endsWith(".tar.gz") ||
      name.endsWith(".zip") ||
      name === "SOURCE.json" ||
      name === "vsix-artifacts.json")
  );
}

/**
 * Require checksums.txt to cover exactly the release assets in the directory.
 * @param {string} directory
 */
export function verifyChecksums(directory) {
  /** @type {Map<string, string>} */
  const recorded = new Map();
  for (const line of readFileSync(join(directory, "checksums.txt"), "utf8")
    .split("\n")
    .filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
    assert.ok(match, `Malformed checksum line: ${line}`);
    const [, hash, name] = match;
    assert.ok(!recorded.has(name), `Duplicate checksum for ${name}`);
    recorded.set(name, hash);
  }
  assert.deepEqual(
    [...recorded.keys()].sort(),
    readdirSync(directory).filter(isReleaseAsset).sort(),
    "checksums.txt must cover exactly the release assets",
  );
  for (const [name, hash] of recorded)
    assert.equal(
      sha256(readFileSync(join(directory, name))),
      hash,
      `Checksum mismatch for ${name}`,
    );
}

/**
 * Validate the complete qualified batch and the live tag before any publication.
 * @param {string} directory
 * @param {string} tag
 * @param {string} commit
 * @param {{readPackage?: typeof readVSIX, lsRemote?: (tag: string) => string | Promise<string>}} [adapters]
 * @returns {Promise<string[]>} the verified VSIX paths in package-record order
 */
export async function verifyRelease(
  directory,
  tag,
  commit,
  { readPackage = readVSIX, lsRemote: listRemote = lsRemote } = {},
) {
  assert.equal(
    tag,
    `v${manifest.version}`,
    "Release tag must match the manifest",
  );
  assert.match(tag, stableTag);
  assert.match(commit, /^[a-f0-9]{40}$/);
  verifyChecksums(directory);
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
  // Last, so a tag moved during verification cannot pass on an earlier read.
  assert.equal(
    remoteTagCommit(await listRemote(tag), tag),
    commit,
    "Remote tag must still point at the release commit",
  );
  return filenames;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? "dist");
  await verifyRelease(
    directory,
    process.env.RELEASE_TAG ?? "",
    process.env.RELEASE_COMMIT ?? "",
  );
  console.log(`Verified release ${process.env.RELEASE_TAG} in ${directory}`);
}
