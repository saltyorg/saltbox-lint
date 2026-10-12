import assert from "node:assert/strict";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix)
  );
}

/** Declare SDK-visible inputs whose external host owner removes them after exit. */
export async function workspaceFixtureDirectory(
  parent: string,
  prefix: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  dependencies: { createDirectory?: (prefix: string) => Promise<string> } = {},
): Promise<string> {
  assert.match(prefix, /^saltbox-[a-z-]+-$/);
  const profile = environment.SALTBOX_TEST_PROFILE_ROOT;
  const workspace = environment.SALTBOX_TEST_WORKSPACE_PATH;
  assert.ok(profile, "workspace fixtures require the external profile owner");
  assert.ok(workspace, "workspace fixtures require the owned workspace");
  assert.ok(isAbsolute(parent), "workspace fixture parent must be absolute");
  const [nativeProfile, nativeWorkspace, nativeParent] = await Promise.all([
    realpath(profile),
    realpath(workspace),
    realpath(parent),
  ]);
  assert.equal(
    nativeWorkspace,
    join(nativeProfile, "workspace"),
    "workspace must be the external owner's exact workspace directory",
  );
  assert.ok(
    contained(resolve(workspace), resolve(parent)) ||
      contained(nativeWorkspace, resolve(parent)),
    "workspace fixture parent must use a verified workspace spelling",
  );
  assert.ok(
    contained(nativeWorkspace, nativeParent),
    "workspace fixture parent must remain inside its native workspace",
  );
  assert.equal((await stat(nativeParent)).isDirectory(), true);
  // Allocate through the verified native parent, so a retargeted public
  // junction cannot redirect creation outside the external owner's tree.
  const directory = await (dependencies.createDirectory ?? mkdtemp)(
    join(nativeParent, prefix),
  );
  const nativeDirectory = await realpath(directory);
  assert.ok(
    contained(nativeWorkspace, nativeDirectory),
    "allocated workspace fixture must remain inside its external owner",
  );
  const publicDirectory = join(parent, basename(directory));
  assert.equal(
    await realpath(publicDirectory),
    nativeDirectory,
    "public fixture spelling must still identify the allocated native child",
  );
  return publicDirectory;
}
