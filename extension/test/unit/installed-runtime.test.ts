import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  installedRuntime,
  joinInstalledRuntime,
  type CachedRuntimeModule,
  type RuntimeFileAdapters,
} from "../support/installed-runtime.ts";
import { withTestResources } from "../support/test-resources.ts";

interface FixtureRuntime {
  readonly calls: number;
  hold(): void;
  release(): void;
  deactivate(): Promise<void>;
}

async function withRuntime(
  body: (fixture: {
    filename: string;
    alias: string;
    other: string;
    runtime: FixtureRuntime;
    cache: Readonly<Record<string, CachedRuntimeModule | undefined>>;
  }) => Promise<void>,
) {
  await withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
    const directory = await mkdtemp(join(tmpdir(), "saltbox-runtime-"));
    resources.defer("runtime fixture", () =>
      rm(directory, { recursive: true, force: true }),
    );
    const product = join(directory, "product");
    await mkdir(product);
    const filename = join(product, "extension.cjs");
    await writeFile(
      filename,
      "let calls = 0, held, release; module.exports = { get calls() { return calls; }, hold() { held = new Promise(done => { release = done; }); }, release() { release?.(); }, deactivate() { calls++; return held ?? Promise.resolve(); } };\n",
    );
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(filename);
    const loaded: unknown = require(filename);
    resources.defer("owned fixture module", () => {
      delete require.cache[resolved];
    });
    assert.ok(
      loaded &&
        typeof loaded === "object" &&
        "deactivate" in loaded &&
        typeof loaded.deactivate === "function" &&
        "calls" in loaded &&
        typeof loaded.calls === "number",
    );
    const runtime = loaded as FixtureRuntime;
    resources.defer("fixture deactivation gate", () => runtime.release());
    const aliasDirectory = join(directory, "alias");
    await symlink(
      product,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const alias = join(aliasDirectory, "extension.cjs");
    const other = join(directory, "extension.cjs");
    await writeFile(other, "module.exports = {};\n");
    await body({
      filename,
      alias,
      other,
      runtime,
      cache: { [resolved]: { filename: resolved, exports: runtime } },
    });
  });
}

test("the already loaded runtime is found through a real filesystem alias without loading another instance", async () => {
  await withRuntime(async (f) => {
    const loaded = installedRuntime(f.filename, {
      [f.alias]: { filename: f.alias, exports: f.runtime },
    });
    assert.equal(loaded, f.runtime);
    await loaded.deactivate();
    assert.equal(f.runtime.calls, 1);
  });
});

test("distinct canonical names with the same real inode identify the loaded runtime", async () => {
  await withRuntime(async (f) => {
    const hardlink = join(dirname(f.filename), "cached-runtime.cjs");
    await link(f.filename, hardlink);
    assert.notEqual(
      realpathSync.native(hardlink),
      realpathSync.native(f.filename),
      "this exercises physical identity rather than canonical spelling",
    );
    assert.equal(
      installedRuntime(f.filename, {
        [hardlink]: { filename: hardlink, exports: f.runtime },
      }),
      f.runtime,
    );
    assert.equal(f.runtime.calls, 0, "lookup never activates another module");
  });
});

test("zero inode identities cannot equate distinct canonical files", async () => {
  await withRuntime(async (f) => {
    assert.notEqual(
      realpathSync.native(f.filename),
      realpathSync.native(f.other),
    );
    assert.throws(
      () =>
        installedRuntime(
          f.filename,
          { [f.other]: { filename: f.other, exports: f.runtime } },
          {
            realpath: realpathSync.native,
            identity: () => ({ device: 0n, inode: 0n, regular: true }),
          },
        ),
      /no loaded CommonJS instance/,
    );
    assert.equal(f.runtime.calls, 0);
  });
});

test("synchronous disposal admission still waits for the actual deactivation promise", async () => {
  await withRuntime(async (f) => {
    f.runtime.hold();
    let settled = false;
    const joining = joinInstalledRuntime(f.filename, f.cache).then(() => {
      settled = true;
    });
    try {
      assert.equal(f.runtime.calls, 1, "deactivation starts before returning");
      await Promise.resolve();
      assert.equal(settled, false);
      f.runtime.release();
      await joining;
      assert.equal(settled, true);
    } finally {
      f.runtime.release();
      await joining;
    }
  });
});

test("aliases of the same exports object deduplicate but different instances fail closed", async () => {
  await withRuntime(async (f) => {
    const aliases = {
      [f.filename]: { filename: f.filename, exports: f.runtime },
      [f.alias]: { filename: f.alias, exports: f.runtime },
    };
    assert.equal(installedRuntime(f.filename, aliases), f.runtime);
    const otherInstance = { deactivate() {} };
    assert.throws(
      () =>
        installedRuntime(f.filename, {
          ...aliases,
          [f.alias]: { filename: f.alias, exports: otherInstance },
        }),
      /ambiguous loaded CommonJS instances/,
    );
    assert.equal(f.runtime.calls, 0);
  });
});

test("a same-named different physical file cannot supply the product runtime", async () => {
  await withRuntime(async (f) => {
    assert.throws(
      () =>
        installedRuntime(f.filename, {
          [f.filename]: { filename: f.other, exports: f.runtime },
        }),
      /no loaded CommonJS instance/,
    );
  });
});

test("native case aliases follow actual filesystem identity on every platform", async () => {
  await withRuntime(async (f) => {
    const uppercase = f.filename.toUpperCase();
    const cache = {
      [uppercase]: { filename: uppercase, exports: f.runtime },
    };
    if (existsSync(uppercase))
      assert.equal(installedRuntime(f.filename, cache), f.runtime);
    else
      assert.throws(
        () => installedRuntime(f.filename, cache),
        /no loaded CommonJS instance/,
      );
  });
});

test("Windows short-path and drive-case spellings use observed file identity", async () => {
  await withRuntime(async (f) => {
    const short = "C:\\Users\\RUNNER~1\\product\\extension.cjs";
    const long = "c:\\Users\\runneradmin\\product\\extension.cjs";
    const fileFor = (filename: string) =>
      filename === short || filename === long ? f.filename : filename;
    const files: RuntimeFileAdapters = {
      realpath: (filename) => realpathSync.native(fileFor(filename)),
      identity(filename) {
        const stat = statSync(fileFor(filename), { bigint: true });
        return { device: stat.dev, inode: stat.ino, regular: stat.isFile() };
      },
    };
    assert.equal(
      installedRuntime(
        short,
        { [long]: { filename: long, exports: f.runtime } },
        files,
      ),
      f.runtime,
    );
  });
});

test("unknown filesystem observation failures retain their original cause", async () => {
  await withRuntime(async (f) => {
    const failure = Object.assign(new Error("identity denied"), {
      code: "EPERM",
    });
    assert.throws(
      () =>
        installedRuntime(
          f.filename,
          { [f.alias]: { filename: f.alias, exports: f.runtime } },
          {
            realpath: realpathSync.native,
            identity(filename) {
              if (filename === f.alias) throw failure;
              const stat = statSync(filename, { bigint: true });
              return {
                device: stat.dev,
                inode: stat.ino,
                regular: stat.isFile(),
              };
            },
          },
        ),
      (error: unknown) => error instanceof Error && error.cause === failure,
    );
  });
});

test("a missing obsolete cache entry cannot hide the current loaded instance", async () => {
  await withRuntime(async (f) => {
    assert.equal(
      installedRuntime(f.filename, {
        missing: { filename: f.filename + ".gone", exports: {} },
        ...f.cache,
      }),
      f.runtime,
    );
  });
});

test("missing standard hooks and original hook rejection remain failures", async () => {
  await withRuntime(async (f) => {
    assert.throws(
      () =>
        installedRuntime(f.filename, {
          [f.filename]: { filename: f.filename, exports: {} },
        }),
      /standard deactivation hook/,
    );
    const original = new Error("deactivation rejected");
    await assert.rejects(
      joinInstalledRuntime(f.filename, {
        [f.filename]: {
          filename: f.filename,
          exports: { deactivate: () => Promise.reject(original) },
        },
      }),
      (error: unknown) => error === original,
    );
  });
});
