import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRoot, identify, resolveSource } from "../../src/identity.ts";
test("canonical disk identity stays inside root across workspace symlinks", async () => {
  const base = await mkdtemp(join(tmpdir(), "saltbox-identity-"));
  try {
    const root = join(base, "root");
    await mkdir(root);
    await writeFile(join(root, "a.yml"), "a: 1");
    await symlink(
      root,
      join(base, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const canonical = await canonicalRoot(join(base, "alias"), "");
    assert.deepEqual(await identify(canonical, join(base, "alias/a.yml")), {
      root: canonical,
      filename: join(canonical, "a.yml"),
      path: "a.yml",
    });
    await assert.rejects(resolveSource(canonical, "../outside.yml"));
    await writeFile(join(base, "outside.yml"), "x: 1");
    await assert.rejects(identify(canonical, join(base, "outside.yml")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("conventional templates remain read-only regardless of extension", async () => {
  const { templatePath } = await import("../../src/identity.ts");
  for (const filename of [
    "roles/a/templates/router.yaml",
    "resources/roles/a/templates/config.txt",
    "resources/templates/config.yml",
    "/absolute/roles/a/templates/config.conf",
    "router.j2",
  ])
    assert.equal(templatePath(filename), true);
  assert.equal(templatePath("roles/a/tasks/template.yml"), false);
  assert.equal(templatePath("roles/a/defaults/main.yml"), false);
});
