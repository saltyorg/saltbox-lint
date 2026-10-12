import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Preserve the reference leaf under either verified spelling of its root. */
export function referencePathFromRoot(
  reference: { scheme: string; fsPath: string },
  sourceRoot: string,
): string | undefined {
  if (
    reference.scheme !== "file" ||
    !isAbsolute(reference.fsPath) ||
    !isAbsolute(sourceRoot)
  )
    return;
  const spellings = new Set([
    resolve(sourceRoot),
    realpathSync.native(sourceRoot),
  ]);
  for (const root of spellings) {
    const path = relative(root, reference.fsPath);
    if (
      !path ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path)
    )
      continue;
    // Canonicalize the root only. Resolving the reference would erase the
    // admitted alias leaf and incorrectly accept its defaults owner instead.
    return path.split(sep).join("/");
  }
}
