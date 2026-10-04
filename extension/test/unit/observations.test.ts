import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  realpath,
  symlink,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, type AnalysisRecord } from "../../src/protocol.ts";
import { contentFingerprint, observeAnalysis } from "../../src/observations.ts";
import { Dependencies } from "../../src/dependencies.ts";

async function fixture(directory = tmpdir()) {
  // Load and the editor publish canonical roots, even when tmpdir is an alias.
  const root = await realpath(
    await mkdtemp(join(directory, "saltbox-observe-")),
  );
  await mkdir(join(root, "roles/a/tasks"), { recursive: true });
  await mkdir(join(root, "roles/a/templates"), { recursive: true });
  await writeFile(join(root, "roles/a/tasks/main.yml"), "[]\n");
  await writeFile(join(root, "roles/a/templates/router.conf"), "good");
  const record: AnalysisRecord = {
    schema_version: 1,
    root,
    generation: hash("generation"),
    complete: true,
    sources: [
      {
        path: "roles/a/tasks/main.yml",
        source_sha256: hash("[]\n"),
        files: [
          {
            path: "roles/a/tasks/main.yml",
            state: "read",
            sha256: hash("[]\n"),
          },
          {
            path: "roles/a/templates/router.conf",
            state: "read",
            sha256: hash("good"),
          },
        ],
        identity: [],
        discovery: [],
        directories: [
          {
            path: "roles/a/templates",
            state: "directory",
            members: ["roles/a/templates/router.conf"],
          },
        ],
      },
    ],
  };
  return {
    root,
    record,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("aliased temporary directories produce canonical analysis roots and retain containment", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-observe-alias-")),
  );
  const alias = join(directory, "alias");
  await mkdir(join(directory, "actual"));
  await symlink(join(directory, "actual"), alias, "junction");
  const { root, record, cleanup } = await fixture(alias);
  try {
    assert.equal((await observeAnalysis(record)).changed.size, 0);
    assert.equal(root, await realpath(root));
    const external = join(directory, "private.txt");
    const escaped = "roles/a/templates/escaped.conf";
    await writeFile(external, "external bytes");
    await symlink(external, join(root, escaped));
    record.sources[0].files.push({
      path: escaped,
      state: "read",
      sha256: hash("external bytes"),
    });
    const reads: string[] = [];
    const observed = await observeAnalysis(
      record,
      new Set(),
      async (filename) => {
        reads.push(filename);
        return readFile(filename);
      },
    );
    assert.deepEqual([...observed.changed], [escaped]);
    assert.equal(reads.includes(external), false);
    assert.equal(observed.fingerprints.has(escaped), false);
  } finally {
    await cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
test("verified bytes coalesce late unchanged echoes while same-size restored-mtime writes invalidate", async () => {
  const { root, record, cleanup } = await fixture();
  try {
    const graph = new Dependencies();
    const token = graph.begin();
    const filename = join(root, "roles/a/templates/router.conf");
    const before = await lstat(filename, { bigint: true });
    const stamp = contentFingerprint(before, await readFile(filename));
    graph.event("one", root, "roles/a/templates/router.conf", stamp);
    const observed = await observeAnalysis(record);
    assert.equal(observed.changed.size, 0);
    assert.equal(
      graph.accept("one", record, token, true, [], observed.fingerprints),
      true,
      "verified same content can reconcile an already delivered late echo",
    );
    assert.equal(
      graph.event("one", root, "roles/a/templates/router.conf", stamp),
      undefined,
    );
    // Even identical metadata cannot make different bytes share a fingerprint.
    assert.notEqual(
      contentFingerprint(before, Buffer.from("good")),
      contentFingerprint(before, Buffer.from("evil")),
    );
    await writeFile(filename, "evil");
    await utimes(
      filename,
      Number(before.atimeMs) / 1000,
      Number(before.mtimeMs) / 1000,
    );
    const changedStamp = contentFingerprint(
      await lstat(filename, { bigint: true }),
      await readFile(filename),
    );
    assert.equal(
      graph
        .event("one", root, "roles/a/templates/router.conf", changedStamp)!
        .has(record.sources[0].path),
      true,
    );
    assert.ok(
      (await observeAnalysis(record)).changed.has(
        "roles/a/templates/router.conf",
      ),
    );
  } finally {
    await cleanup();
  }
});
test("a write during verification cannot pair old bytes with a newer identity", async () => {
  const { root, record, cleanup } = await fixture();
  try {
    const changed = await observeAnalysis(
      record,
      new Set(),
      async (filename) => {
        const bytes = await readFile(filename);
        if (filename.endsWith("router.conf")) await writeFile(filename, "evil");
        return bytes;
      },
    );
    assert.ok(changed.changed.has("roles/a/templates/router.conf"));
    assert.equal(
      changed.fingerprints.has("roles/a/templates/router.conf"),
      false,
    );
  } finally {
    await cleanup();
  }
});
test("dirty overlays skip only their own disk bytes and still verify required context", async () => {
  const { root, record, cleanup } = await fixture();
  try {
    record.sources[0].source_sha256 = hash("dirty: true\n");
    record.sources[0].files[0].sha256 = record.sources[0].source_sha256;
    const observed = await observeAnalysis(
      record,
      new Set([record.sources[0].path]),
    );
    assert.equal(observed.changed.size, 0);
    assert.equal(observed.fingerprints.has(record.sources[0].path), true);
    await writeFile(join(root, "roles/a/templates/router.conf"), "evil");
    assert.ok(
      (
        await observeAnalysis(record, new Set([record.sources[0].path]))
      ).changed.has("roles/a/templates/router.conf"),
    );
  } finally {
    await cleanup();
  }
});
test("unavailable inputs and symlink project markers expose metadata without external byte reads", async () => {
  const { root, record, cleanup } = await fixture(),
    outside = await mkdtemp(join(tmpdir(), "saltbox-observe-outside-"));
  try {
    const secret = join(outside, "private.txt");
    await writeFile(secret, "private external bytes");
    await symlink(secret, join(root, "roles/a/templates/ignored.conf"));
    await symlink(secret, join(root, "saltbox.yml"));
    record.sources[0].files.push({
      path: "roles/a/templates/ignored.conf",
      state: "unavailable",
    });
    record.sources[0].identity = [{ path: "saltbox.yml", state: "regular" }];
    const reads: string[] = [];
    const observed = await observeAnalysis(
      record,
      new Set(),
      async (filename) => {
        reads.push(filename);
        return readFile(filename);
      },
    );
    assert.equal(observed.changed.size, 0);
    assert.deepEqual(
      reads.sort(),
      [
        join(root, "roles/a/tasks/main.yml"),
        join(root, "roles/a/templates/router.conf"),
      ].sort(),
    );
    record.sources[0].files[2] = {
      path: "roles/a/templates/ignored.conf",
      state: "read",
      sha256: hash("private external bytes"),
    };
    reads.length = 0;
    const escaped = await observeAnalysis(
      record,
      new Set(),
      async (filename) => {
        reads.push(filename);
        return readFile(filename);
      },
    );
    assert.ok(escaped.changed.has("roles/a/templates/ignored.conf"));
    assert.equal(
      reads.includes(join(root, "roles/a/templates/ignored.conf")),
      false,
    );
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("one refreshed primary cannot suppress context invalidation for another primary", async () => {
  const { root, record, cleanup } = await fixture();
  try {
    const graph = new Dependencies();
    const old = await observeAnalysis(record);
    graph.accept("one", record, graph.begin(), true, [], old.fingerprints);
    const changed = structuredClone(record);
    changed.sources[0].path = "roles/a/tasks/other.yml";
    changed.sources[0].source_sha256 = hash("[]\n");
    changed.sources[0].files[0] = {
      path: changed.sources[0].path,
      state: "read",
      sha256: hash("[]\n"),
    };
    await writeFile(join(root, changed.sources[0].path), "[]\n");
    await writeFile(join(root, "roles/a/templates/router.conf"), "evil");
    changed.sources[0].files[1].sha256 = hash("evil");
    const fresh = await observeAnalysis(changed);
    graph.accept("one", changed, graph.begin(), false, [], fresh.fingerprints);
    const affected = graph.event(
      "one",
      root,
      "roles/a/templates/router.conf",
      fresh.fingerprints.get("roles/a/templates/router.conf"),
    )!;
    assert.ok(affected.has(record.sources[0].path));
    assert.equal(
      affected.has(changed.sources[0].path),
      false,
      "already verified consumer retains its actions",
    );
  } finally {
    await cleanup();
  }
});
