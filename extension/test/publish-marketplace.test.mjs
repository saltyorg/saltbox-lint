// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { publishMarketplace } from "../scripts/publish-marketplace.mjs";
import {
  manifest,
  targets,
  sha256,
  sourceName,
} from "../scripts/release-inputs.mjs";

const commit = "1".repeat(40);
const tag = `v${manifest.version}`;

/** @param {import("node:test").TestContext} t */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "saltbox-marketplace-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const sourceBytes = Buffer.from("corresponding source archive fixture");
  const source = {
    version: manifest.version,
    commit,
    build_kind: "stable",
    tracked_worktree_dirty: false,
    source_archive: sourceName,
    source_sha256: sha256(sourceBytes),
    source_url: `https://github.com/saltyorg/saltbox-lint/releases/download/${tag}/${sourceName}`,
    licenses: {},
  };
  writeFileSync(join(directory, sourceName), sourceBytes);
  const packages = Object.keys(targets).map((target) => {
    const filename = `saltbox-lint-${manifest.version}-${target}.vsix`;
    const bytes = Buffer.from(`qualified VSIX fixture for ${target}`);
    writeFileSync(join(directory, filename), bytes);
    return {
      target,
      filename,
      sha256: sha256(bytes),
      binary_sha256: sha256(Buffer.from(`native ${target}`)),
    };
  });
  const record = { ...source, packages };
  const save = () => {
    writeFileSync(join(directory, "SOURCE.json"), JSON.stringify(source));
    writeFileSync(
      join(directory, "vsix-artifacts.json"),
      JSON.stringify(record),
    );
  };
  save();
  /** @type {Map<string, Map<string, {bytes: Buffer, mode: number}>>} */
  const contents = new Map();
  for (const entry of packages) {
    /** @type {Map<string, {bytes: Buffer, mode: number}>} */
    const files = new Map();
    /** @param {string} path @param {string} [text] @param {number} [mode] */
    const put = (path, text = "fixture", mode = 0o100644) => {
      files.set(path, { bytes: Buffer.from(text), mode });
    };
    for (const name of [
      "[Content_Types].xml",
      "extension/dist/extension.js",
      "extension/readme.md",
      "extension/changelog.md",
      "extension/SUPPORT.md",
      "extension/PRIVACY.md",
      "extension/LICENSE.txt",
      "extension/THIRD_PARTY_NOTICES",
    ])
      put(name);
    put(
      "extension/package.json",
      JSON.stringify({
        name: "saltbox-lint",
        publisher: "saltyorg",
        version: manifest.version,
        main: "./dist/extension.js",
      }),
    );
    put(
      "extension.vsixmanifest",
      `<Identity TargetPlatform="${entry.target}" />`,
    );
    put("extension/SOURCE.json", JSON.stringify(source));
    put("extension/licenses/inventory.json", "{}");
    put(
      `extension/bin/saltbox-lint${entry.target.startsWith("win32") ? ".exe" : ""}`,
      `native ${entry.target}`,
      0o100755,
    );
    contents.set(entry.filename, files);
  }
  let reads = 0;
  /** @param {string} path */
  const readPackage = async (path) => {
    const files = contents.get(basename(path));
    assert.ok(files);
    reads++;
    return files;
  };
  return {
    directory,
    source,
    record,
    save,
    contents,
    readPackage,
    reads: () => reads,
  };
}

test("all eight artifacts are validated before the public publisher receives their exact paths", async (t) => {
  const f = fixture(t);
  let published = 0;
  const paths = await publishMarketplace(f.directory, tag, commit, {
    readPackage: f.readPackage,
    publish: async (paths, options) => {
      published++;
      assert.equal(f.reads(), 8);
      assert.deepEqual(options, { azureCredential: true });
      assert.deepEqual(
        paths,
        f.record.packages.map((entry) => join(f.directory, entry.filename)),
      );
    },
  });
  assert.equal(published, 1);
  assert.equal(paths.length, 8);
});

test("invalid release provenance and package sets never admit an upload", async (t) => {
  /** @type {[string, (f: ReturnType<typeof fixture>) => void][]} */
  const cases = [
    [
      "snapshot",
      (f) => {
        f.source.build_kind = "snapshot";
      },
    ],
    [
      "dirty worktree",
      (f) => {
        f.source.tracked_worktree_dirty = true;
      },
    ],
    [
      "wrong commit",
      (f) => {
        f.source.commit = "2".repeat(40);
      },
    ],
    [
      "wrong version",
      (f) => {
        f.source.version = "99.0.0";
      },
    ],
    [
      "wrong source URL",
      (f) => {
        f.source.source_url = "https://example.com/source";
      },
    ],
    [
      "changed source archive",
      (f) => {
        writeFileSync(join(f.directory, sourceName), "changed");
      },
    ],
    [
      "missing target",
      (f) => {
        f.record.packages.pop();
      },
    ],
    [
      "duplicate target",
      (f) => {
        f.record.packages.push({ ...f.record.packages[0] });
      },
    ],
    [
      "unexpected target",
      (f) => {
        f.record.packages[0].target = "web";
      },
    ],
    [
      "filename traversal",
      (f) => {
        f.record.packages[0].filename = "../other.vsix";
      },
    ],
    [
      "unexpected VSIX",
      (f) => {
        writeFileSync(join(f.directory, "other.vsix"), "extra");
      },
    ],
    [
      "changed final VSIX",
      (f) => {
        writeFileSync(
          join(f.directory, f.record.packages[7].filename),
          "changed",
        );
      },
    ],
    [
      "wrong binary hash",
      (f) => {
        f.record.packages[7].binary_sha256 = "0".repeat(64);
      },
    ],
    [
      "different package provenance",
      (f) => {
        f.record.commit = "3".repeat(40);
      },
    ],
    [
      "wrong packaged identity",
      (f) => {
        const files = f.contents.get(f.record.packages[7].filename);
        assert.ok(files);
        files.set("extension/package.json", {
          bytes: Buffer.from("{}"),
          mode: 0o100644,
        });
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      mutate(f);
      f.save();
      let uploads = 0;
      await assert.rejects(
        publishMarketplace(f.directory, tag, commit, {
          readPackage: f.readPackage,
          publish: async () => {
            uploads++;
          },
        }),
      );
      assert.equal(uploads, 0);
    });
  }
  for (const [name, badTag, badCommit] of [
    ["wrong tag", "v99.0.0", commit],
    ["branch reference", "main", commit],
    ["invalid commit", tag, "main"],
  ]) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      let uploads = 0;
      await assert.rejects(
        publishMarketplace(f.directory, badTag, badCommit, {
          readPackage: f.readPackage,
          publish: async () => {
            uploads++;
          },
        }),
      );
      assert.equal(uploads, 0);
    });
  }
});

test("package read and remote upload failures preserve the original error", async (t) => {
  for (const phase of ["read", "publish"]) {
    await t.test(phase, async (t) => {
      const f = fixture(t);
      const failure = new Error(`${phase} failed`, {
        cause: new Error("original cause"),
      });
      let uploads = 0;
      await assert.rejects(
        publishMarketplace(f.directory, tag, commit, {
          readPackage:
            phase === "read"
              ? async () => {
                  throw failure;
                }
              : f.readPackage,
          publish: async () => {
            uploads++;
            throw failure;
          },
        }),
        (error) => error === failure,
      );
      assert.equal(uploads, phase === "publish" ? 1 : 0);
    });
  }
});
