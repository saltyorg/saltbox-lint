import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { identify, identifyNow } from "../../src/identity.ts";
import {
  sourceOriginCurrent,
  sourceOriginCurrentNow,
} from "../../src/observations.ts";

const bundled = await build({
  entryPoints: ["src/observations.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});

test("native canonical capture and immediate original URI authority use the same Windows identity", async () => {
  const root = "D:\\workspace";
  const filename = win32.join(root, "roles/a/tasks/main.yml");
  const sourceFilename = "d:\\workspace\\roles\\a\\tasks\\main.yml";
  let owner = filename;
  const native = (value: string) => {
    if (win32.resolve(value).toLowerCase() === filename.toLowerCase())
      return owner;
    throw Object.assign(new Error("Source absent"), { code: "ENOENT" });
  };
  // On Windows the JavaScript walker preserves an ordinary path's spelling.
  // Native realpath resolves that spelling to the filesystem's canonical name.
  const immediate = Object.assign((value: string) => win32.resolve(value), {
    native,
  });
  const module = {
    exports: {} as {
      sourceOriginCurrent: typeof sourceOriginCurrent;
      sourceOriginCurrentNow: typeof sourceOriginCurrentNow;
    },
  };
  const require = createRequire(import.meta.url);
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    Buffer,
    require: (name: string): unknown =>
      name === "node:path"
        ? win32
        : name === "node:fs"
          ? { realpathSync: immediate }
          : name === "node:fs/promises"
            ? { realpath: async (value: string) => native(value) }
            : (require(name) as unknown),
  });
  const origin = {
    root,
    filename,
    path: "roles/a/tasks/main.yml",
    sourceFilename,
  };
  assert.equal(await module.exports.sourceOriginCurrent(origin), true);
  assert.equal(module.exports.sourceOriginCurrentNow(origin), true);
  owner = win32.join(root, "other.yml");
  assert.equal(await module.exports.sourceOriginCurrent(origin), false);
  assert.equal(module.exports.sourceOriginCurrentNow(origin), false);
});

test("native disk identity survives URI drive spelling in both authority modes", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-canonical-")),
  );
  try {
    await mkdir(join(root, "roles/a/tasks"), { recursive: true });
    const filename = join(root, "roles/a/tasks/main.yml");
    await writeFile(filename, "[]\n");
    const sourceFilename =
      process.platform === "win32"
        ? filename[0].toLowerCase() + filename.slice(1)
        : filename;
    const identity = await identify(root, sourceFilename);
    assert.deepEqual(identifyNow(root, sourceFilename), identity);
    const origin = { ...identity, sourceFilename };
    assert.equal(await sourceOriginCurrent(origin), true);
    assert.equal(sourceOriginCurrentNow(origin), true);
    const missing = join(sourceFilename, "..", "never-saved.yml");
    assert.deepEqual(identifyNow(root, missing), await identify(root, missing));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
