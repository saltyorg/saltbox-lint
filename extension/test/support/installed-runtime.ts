import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";

export interface CachedRuntimeModule {
  filename?: string;
  exports: unknown;
}

export interface InstalledRuntime {
  deactivate(): void | PromiseLike<void>;
}

export interface RuntimeFileAdapters {
  realpath(filename: string): string;
  identity(filename: string): {
    device: bigint;
    inode: bigint;
    regular: boolean;
  };
}

const nativeFiles: RuntimeFileAdapters = {
  realpath: (filename) => realpathSync.native(filename),
  identity(filename) {
    const stat = statSync(filename, { bigint: true });
    return { device: stat.dev, inode: stat.ino, regular: stat.isFile() };
  },
};

function missing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR"),
  );
}

export function installedRuntime(
  filename: string,
  cache: Readonly<Record<string, CachedRuntimeModule | undefined>>,
  files: RuntimeFileAdapters = nativeFiles,
): InstalledRuntime {
  const canonical = files.realpath(filename);
  const identity = files.identity(filename);
  assert.equal(
    identity.regular,
    true,
    "installed entrypoint is a regular file",
  );
  const instances = new Set<unknown>();
  for (const [key, module] of Object.entries(cache)) {
    if (!module) continue;
    const candidate = module.filename ?? key;
    if (!isAbsolute(candidate) && !win32.isAbsolute(candidate)) continue;
    try {
      const actualPath = files.realpath(candidate);
      const actual = files.identity(candidate);
      if (
        actual.regular &&
        (actualPath === canonical ||
          (identity.inode > 0n &&
            actual.inode > 0n &&
            actual.device === identity.device &&
            actual.inode === identity.inode))
      )
        instances.add(module.exports);
    } catch (error) {
      if (!missing(error))
        throw new Error("Loaded module identity could not be observed", {
          cause: error,
        });
    }
  }
  assert.equal(
    instances.size,
    1,
    instances.size === 0
      ? "the installed product has no loaded CommonJS instance"
      : "the installed product has ambiguous loaded CommonJS instances",
  );
  const [runtime] = instances;
  assert.ok(
    runtime &&
      typeof runtime === "object" &&
      "deactivate" in runtime &&
      typeof runtime.deactivate === "function",
    "the loaded product exposes its standard deactivation hook",
  );
  return runtime as InstalledRuntime;
}

/** Synchronous lookup starts deactivation before the first await. */
export async function joinInstalledRuntime(
  filename: string,
  cache: Readonly<Record<string, CachedRuntimeModule | undefined>>,
  files?: RuntimeFileAdapters,
): Promise<void> {
  await installedRuntime(filename, cache, files).deactivate();
}
