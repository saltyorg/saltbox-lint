import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Crash cleanup belongs to the external owner of this fresh host profile. */
export async function hostTemporaryDirectory(
  prefix: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<string> {
  assert.match(prefix, /^saltbox-[a-z-]+-$/);
  const root = environment.SALTBOX_TEST_WORKSPACE_PATH;
  assert.ok(root, "host temporary fixtures require the external profile owner");
  return mkdtemp(join(await realpath(root), prefix));
}
