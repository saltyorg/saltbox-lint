import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceFixtureDirectory } from "../support/workspace-fixture.ts";

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "saltbox-workspace-owner-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const profile = join(base, "profile");
  const workspace = join(profile, "workspace");
  const parent = join(workspace, "one", "roles", "example", "templates");
  await mkdir(parent, { recursive: true });
  const environment = {
    SALTBOX_TEST_PROFILE_ROOT: profile,
    SALTBOX_TEST_WORKSPACE_PATH: workspace,
  };
  return { base, profile, workspace, parent, environment };
}

test("nested workspace fixtures remain for their external owner and have unique inputs", async (t) => {
  const f = await fixture(t);
  const first = await workspaceFixtureDirectory(
    f.parent,
    "saltbox-source-",
    f.environment,
  );
  const second = await workspaceFixtureDirectory(
    f.parent,
    "saltbox-source-",
    f.environment,
  );
  assert.notEqual(first, second);
  assert.ok(first.startsWith(join(f.parent, "saltbox-source-")));
  await writeFile(join(first, "config.yaml"), "fixture bytes\n");
  assert.deepEqual(
    (await readdir(f.parent)).sort(),
    [first, second].map((path) => path.slice(f.parent.length + 1)).sort(),
  );
  assert.deepEqual(await readdir(first), ["config.yaml"]);
  // No case remover is returned. The known external owner removes its whole
  // container after the SDK closes, including partial or failed-case inputs.
  await rm(f.profile, { recursive: true });
  await assert.rejects(realpath(first), { code: "ENOENT" });
});

test("a real public parent alias retains its spelling and verified native ownership", async (t) => {
  const f = await fixture(t);
  const publicProfile = join(f.base, "public-profile");
  await symlink(f.profile, publicProfile, "junction");
  const publicWorkspace = join(publicProfile, "workspace");
  const publicParent = join(
    publicWorkspace,
    "one",
    "roles",
    "example",
    "templates",
  );
  const environment = {
    SALTBOX_TEST_PROFILE_ROOT: publicProfile,
    SALTBOX_TEST_WORKSPACE_PATH: publicWorkspace,
  };
  const allocated = await workspaceFixtureDirectory(
    publicParent,
    "saltbox-alias-",
    environment,
  );
  assert.ok(allocated.startsWith(publicParent));
  assert.equal(
    await realpath(allocated),
    join(await realpath(f.parent), allocated.slice(publicParent.length + 1)),
  );
  assert.notEqual(allocated, await realpath(allocated));
});

test("missing external ownership rejects before fixture creation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    workspaceFixtureDirectory(f.parent, "saltbox-source-", {
      SALTBOX_TEST_WORKSPACE_PATH: f.workspace,
    }),
    /external profile owner/,
  );
  await assert.rejects(
    workspaceFixtureDirectory(f.parent, "saltbox-source-", {
      SALTBOX_TEST_PROFILE_ROOT: f.profile,
    }),
    /owned workspace/,
  );
  assert.deepEqual(await readdir(f.parent), []);
});

test("an outside or unverified public parent cannot allocate inputs", async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, "outside");
  await mkdir(outside);
  await assert.rejects(
    workspaceFixtureDirectory(outside, "saltbox-source-", f.environment),
    /verified workspace spelling/,
  );
  const unverified = join(f.base, "unverified-alias");
  await symlink(f.parent, unverified, "junction");
  await assert.rejects(
    workspaceFixtureDirectory(unverified, "saltbox-source-", f.environment),
    /verified workspace spelling/,
  );
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(f.parent), []);
});

test("a nested symlink escape rejects before creating anything outside the owner", async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, "foreign");
  await mkdir(outside);
  const escape = join(f.workspace, "escape");
  await symlink(outside, escape, "junction");
  await assert.rejects(
    workspaceFixtureDirectory(escape, "saltbox-source-", f.environment),
    /inside its native workspace/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("a substituted workspace and traversal prefix cannot claim external ownership", async (t) => {
  const f = await fixture(t);
  const foreign = join(f.base, "foreign-workspace");
  await mkdir(foreign);
  await assert.rejects(
    workspaceFixtureDirectory(foreign, "saltbox-source-", {
      ...f.environment,
      SALTBOX_TEST_WORKSPACE_PATH: foreign,
    }),
    /exact workspace directory/,
  );
  await assert.rejects(
    workspaceFixtureDirectory(f.parent, "../escape", f.environment),
  );
  await assert.rejects(
    workspaceFixtureDirectory("relative", "saltbox-source-", f.environment),
    /must be absolute/,
  );
  assert.deepEqual(await readdir(f.parent), []);
  assert.deepEqual(await readdir(foreign), []);
});

test("retargeting a public junction at allocation never creates outside the owner", async (t) => {
  const f = await fixture(t);
  const publicParent = join(f.workspace, "selected-parent");
  const outside = join(f.base, "foreign-retarget");
  await mkdir(outside);
  await symlink(f.parent, publicParent, "junction");
  let allocated: string | undefined;
  await assert.rejects(
    workspaceFixtureDirectory(
      publicParent,
      "saltbox-retarget-",
      f.environment,
      {
        createDirectory: async (prefix) => {
          await rm(publicParent, { recursive: true });
          await symlink(outside, publicParent, "junction");
          allocated = await mkdtemp(prefix);
          return allocated;
        },
      },
    ),
  );
  assert.ok(allocated);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(f.parent), [
    allocated.slice((await realpath(f.parent)).length + 1),
  ]);
  assert.equal(await realpath(allocated), allocated);
});
