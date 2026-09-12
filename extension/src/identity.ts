import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { sourcePath } from "./protocol.ts";
export interface Identity {
  root: string;
  filename: string;
  path: string;
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
  const relative = path.relative(root, canonical).split(path.sep).join("/");
  sourcePath(relative);
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
