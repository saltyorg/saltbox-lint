import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { sourcePath } from "./protocol.ts";
export interface Identity {
  root: string;
  filename: string;
  path: string;
}
// Identity refusal is distinct from an unexpected filesystem or CLI failure.
export class SourceIdentityError extends Error {}
export function unavailableSource(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    error instanceof SourceIdentityError ||
    code === "ENOENT" ||
    code === "ENOTDIR"
  );
}
export async function canonicalRoot(
  folder: string,
  override: string,
): Promise<string> {
  return realpath(path.resolve(folder, override || "."));
}
export async function identify(
  root: string,
  filename: string,
): Promise<Identity> {
  let canonical: string;
  try {
    canonical = await realpath(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonical = path.join(
      await realpath(path.dirname(filename)),
      path.basename(filename),
    );
  }
  return sourceIdentity(root, canonical);
}
export function identifyNow(root: string, filename: string): Identity {
  let canonical: string;
  try {
    // Match promises.realpath's native spelling, including Windows drive case.
    canonical = realpathSync.native(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonical = path.join(
      realpathSync.native(path.dirname(filename)),
      path.basename(filename),
    );
  }
  return sourceIdentity(root, canonical);
}
function sourceIdentity(root: string, canonical: string): Identity {
  const relative = path.relative(root, canonical).split(path.sep).join("/");
  try {
    sourcePath(relative);
  } catch {
    throw new SourceIdentityError(
      "Source is outside the configured source root",
    );
  }
  return { root, filename: canonical, path: relative };
}
export async function resolveSource(
  root: string,
  relative: string,
): Promise<string> {
  sourcePath(relative);
  const identity = await identify(
    root,
    path.resolve(root, ...relative.split("/")),
  );
  if (identity.path !== relative) throw new Error("Source identity changed");
  return identity.filename;
}

export function templatePath(filename: string): boolean {
  // Classify native Windows filenames without changing their disk identity.
  filename = filename.replaceAll("\\", "/");
  return (
    /(?:^|\/)(?:resources\/)?roles\/[^/]+\/templates\//.test(filename) ||
    /(?:^|\/)resources\/templates\//.test(filename) ||
    filename.endsWith(".j2")
  );
}
