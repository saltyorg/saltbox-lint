import { rmSync } from "node:fs";

export interface ExecutedFixtureRemoval {
  platform: NodeJS.Platform;
  remove(directory: string): void;
  wait(milliseconds: number): Promise<void>;
  now(): number;
}

const defaults: ExecutedFixtureRemoval = {
  platform: process.platform,
  remove: (directory) => rmSync(directory, { recursive: true, force: true }),
  wait: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
};

/**
 * Remove a directory holding a fixture executable whose process has closed.
 *
 * On Windows a directory holding a just-closed, freshly built executable has
 * intermittently refused removal with EPERM under release-suite load. The same
 * removal succeeded immediately in 2,000 isolated samples per target, so the
 * holder is not the closed child alone; a scanner or concurrent process opening
 * the new image is the remaining candidate. That release has no public
 * acknowledgement, so on Windows an EPERM or EBUSY removal is observed again
 * asynchronously until the deadline, and the first error is then reported as
 * the cause. Other platforms and other errors fail on the first attempt. The
 * returned counts let callers report any release they actually waited for.
 */
export async function removeExecutedFixtureDirectory(
  directory: string,
  deadlineMs: number,
  removal: Partial<ExecutedFixtureRemoval> = {},
): Promise<{ attempts: number; waitedMs: number }> {
  const { platform, remove, wait, now } = { ...defaults, ...removal };
  const started = now();
  let first: unknown;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      remove(directory);
      return { attempts, waitedMs: now() - started };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (platform !== "win32" || (code !== "EPERM" && code !== "EBUSY"))
        throw error;
      first ??= error;
      if (now() - started >= deadlineMs)
        throw new Error(
          `Executed fixture directory was not released within ${deadlineMs}ms after ${attempts} attempts`,
          { cause: first },
        );
      await wait(50);
    }
  }
}
