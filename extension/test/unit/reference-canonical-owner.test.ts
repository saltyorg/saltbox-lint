import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { assertReferenceCanonicalOwner } from "../host/navigation.ts";

const bundled = await build({
  entryPoints: ["test/host/navigation.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

function fixtureAssertion(resolver: typeof realpathSync) {
  const module = {
    exports: {} as {
      assertReferenceCanonicalOwner: typeof assertReferenceCanonicalOwner;
    },
  };
  const require = createRequire(import.meta.url);
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string): unknown =>
      name === "vscode"
        ? {}
        : name === "node:fs"
          ? {
              ...(require(name) as typeof import("node:fs")),
              realpathSync: resolver,
            }
          : (require(name) as unknown),
  });
  return module.exports.assertReferenceCanonicalOwner;
}

test("installed reference owner assertion shares native canonical spelling and rejects another owner", () => {
  const alias = "d:\\workspace\\roles\\readonly\\templates\\reverse.yaml";
  const expected = "d:\\workspace\\roles\\readonly\\defaults\\reverse.yml";
  const canonical = "D:\\workspace\\roles\\readonly\\defaults\\reverse.yml";
  const other = "D:\\workspace\\roles\\other\\defaults\\reverse.yml";
  let owner = canonical;
  const calls: string[] = [];
  // The JavaScript walker follows the alias target's spelling but preserves
  // the ordinary owner's lowercase URI drive. Native reads share one spelling.
  const javascript = (value: string) => {
    if (value === alias) return owner;
    assert.equal(value, expected);
    return expected;
  };
  const native = (value: string) => {
    calls.push(value);
    if (value === alias) return owner;
    assert.equal(value, expected);
    return canonical;
  };
  const resolver = Object.assign(javascript, { native });
  const check = fixtureAssertion(resolver as typeof realpathSync);
  check(alias, expected);
  assert.deepEqual(calls, [alias, expected]);
  owner = other;
  assert.throws(() => check(alias, expected), { code: "ERR_ASSERTION" });
  assert.deepEqual(calls, [alias, expected, alias, expected]);
});

test("installed reference owner assertion checks real aliases and refuses same-byte different files", async () => {
  const root = await mkdtemp(join(tmpdir(), "saltbox-reference-owner-"));
  try {
    const owners = join(root, "defaults");
    const aliases = join(root, "templates");
    await mkdir(owners);
    const expected = join(owners, "reverse.yml");
    const other = join(owners, "other.yml");
    await writeFile(expected, "same bytes\n");
    await writeFile(other, "same bytes\n");
    symlinkSync(
      owners,
      aliases,
      process.platform === "win32" ? "junction" : "dir",
    );
    const alias = join(aliases, "reverse.yml");
    const check = fixtureAssertion(realpathSync);
    assert.deepEqual(readFileSync(alias), readFileSync(expected));
    check(alias, expected);
    assert.deepEqual(readFileSync(alias), readFileSync(other));
    assert.throws(() => check(alias, other), { code: "ERR_ASSERTION" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
