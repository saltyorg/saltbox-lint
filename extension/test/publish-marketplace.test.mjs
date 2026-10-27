// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { publishMarketplace } from "../scripts/publish-marketplace.mjs";
import {
  isReleaseAsset,
  remoteTagCommit,
  resolveStableTag,
  verifyRelease,
} from "../scripts/verify-release.mjs";
import {
  manifest,
  targets,
  sha256,
  sourceName,
} from "../scripts/release-inputs.mjs";

const commit = "1".repeat(40);
const tag = `v${manifest.version}`;
/** @param {string} target @returns {(tag: string) => string} */
const remoteAt = (target) => (name) =>
  `${"9".repeat(40)}\trefs/tags/${name}\n${target}\trefs/tags/${name}^{}\n`;
const lsRemote = remoteAt(commit);

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
    writeChecksums();
  };
  const writeChecksums = () => {
    writeFileSync(
      join(directory, "checksums.txt"),
      readdirSync(directory)
        .filter(isReleaseAsset)
        .sort()
        .map(
          (name) => `${sha256(readFileSync(join(directory, name)))}  ${name}\n`,
        )
        .join(""),
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
    writeChecksums,
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
    lsRemote,
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
          lsRemote,
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
          lsRemote,
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
          lsRemote,
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

test("release verification rejects checksum records that do not cover the exact release assets", async (t) => {
  /** @type {[string, (f: ReturnType<typeof fixture>) => void][]} */
  const cases = [
    [
      "changed asset after checksums",
      (f) => {
        writeFileSync(join(f.directory, "SOURCE.json"), "{}");
      },
    ],
    [
      "uncovered asset",
      (f) => {
        writeFileSync(join(f.directory, "extra.zip"), "extra");
      },
    ],
    [
      "missing record line",
      (f) => {
        const path = join(f.directory, "checksums.txt");
        const lines = readFileSync(path, "utf8").split("\n");
        writeFileSync(path, lines.slice(1).join("\n"));
      },
    ],
    [
      "duplicate record line",
      (f) => {
        const path = join(f.directory, "checksums.txt");
        const text = readFileSync(path, "utf8");
        writeFileSync(path, text + text.split("\n")[0] + "\n");
      },
    ],
    [
      "path outside the release directory",
      (f) => {
        const path = join(f.directory, "checksums.txt");
        writeFileSync(
          path,
          readFileSync(path, "utf8") + `${"0".repeat(64)}  ../SOURCE.json\n`,
        );
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      mutate(f);
      let remoteReads = 0;
      await assert.rejects(
        verifyRelease(f.directory, tag, commit, {
          readPackage: f.readPackage,
          lsRemote: (name) => {
            remoteReads++;
            return lsRemote(name);
          },
        }),
      );
      assert.equal(remoteReads, 0);
    });
  }
});

test("a moved, missing or unreadable remote tag never admits publication", async (t) => {
  const failure = new Error("ls-remote failed");
  /** @type {[string, (tag: string) => string | Promise<string>, RegExp | ((error: unknown) => boolean)][]} */
  const cases = [
    ["moved annotated tag", remoteAt("2".repeat(40)), /Remote tag/],
    [
      "moved lightweight tag",
      (name) => `${"2".repeat(40)}\trefs/tags/${name}\n`,
      /Remote tag/,
    ],
    ["missing tag", () => "", /Remote tag/],
    [
      "duplicate tag",
      (name) => `${commit}\trefs/tags/${name}\n${commit}\trefs/tags/${name}\n`,
      /Remote tag/,
    ],
    [
      "remote failure",
      async () => {
        throw failure;
      },
      (error) => error === failure,
    ],
  ];
  for (const [name, remote, matches] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      let uploads = 0;
      await assert.rejects(
        publishMarketplace(f.directory, tag, commit, {
          readPackage: f.readPackage,
          lsRemote: remote,
          publish: async () => {
            uploads++;
          },
        }),
        matches,
      );
      assert.equal(uploads, 0);
    });
  }
  await t.test("lightweight tag at the release commit", async (t) => {
    const f = fixture(t);
    const paths = await verifyRelease(f.directory, tag, commit, {
      readPackage: f.readPackage,
      lsRemote: (name) => `${commit}\trefs/tags/${name}\n`,
    });
    assert.equal(paths.length, 8);
  });
});

test("remote tag resolution peels annotated tags and ignores other refs", () => {
  const annotated = "a".repeat(40);
  assert.equal(
    remoteTagCommit(
      `${annotated}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n${"b".repeat(40)}\trefs/tags/${tag}-rc\n`,
      tag,
    ),
    commit,
  );
  assert.equal(remoteTagCommit(`${commit}\trefs/tags/${tag}\n`, tag), commit);
  assert.throws(() => remoteTagCommit(`${commit}\trefs/tags/${tag}-rc\n`, tag));
});

test("stable packaging selects the triggering tag among several tags on one commit", () => {
  const head = "c".repeat(40);
  /**
   * @param {Record<string, string>} refs
   * @param {string[]} pointsAt
   * @returns {(args: string[]) => string}
   */
  const vcs = (refs, pointsAt) => (args) => {
    if (args[0] === "rev-parse") {
      const ref = args[2];
      if (ref === "HEAD^{commit}") return `${head}\n`;
      const target = refs[ref];
      if (!target) throw new Error(`unknown ref ${ref}`);
      return `${target}\n`;
    }
    assert.deepEqual(args, ["tag", "--points-at", "HEAD"]);
    return pointsAt.map((name) => `${name}\n`).join("");
  };
  const tagged = vcs({ [`refs/tags/${tag}^{commit}`]: head }, [
    "v0.0.1",
    tag,
    "v99.0.0",
  ]);
  const workflow = { GITHUB_REF_TYPE: "tag", GITHUB_REF: `refs/tags/${tag}` };
  assert.equal(
    resolveStableTag({ ...workflow, GITHUB_REF_NAME: tag }, tagged),
    tag,
  );
  assert.throws(() =>
    resolveStableTag({ ...workflow, GITHUB_REF_NAME: "v99.0.0" }, tagged),
  );
  assert.throws(() =>
    resolveStableTag(
      { ...workflow, GITHUB_REF_NAME: tag },
      vcs({ [`refs/tags/${tag}^{commit}`]: "d".repeat(40) }, [tag]),
    ),
  );
  assert.equal(resolveStableTag({}, tagged), tag);
  assert.equal(
    resolveStableTag(
      { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
      tagged,
    ),
    tag,
  );
  assert.throws(() => resolveStableTag({}, vcs({}, ["v0.0.1", "v99.0.0"])));
});
