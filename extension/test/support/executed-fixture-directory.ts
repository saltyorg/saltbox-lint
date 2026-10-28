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
 * Windows keeps a terminated image locked until every handle to its process
 * object closes. libuv closes a child's process handle in a later event-loop
 * phase than Node's 'close' event, and scanners may briefly open a freshly
 * built image. Neither release has a public acknowledgement, so on Windows an
 * EPERM or EBUSY removal is observed again asynchronously, which lets the loop
 * close the handle, until the deadline. The first error is then reported as the
 * cause. Other platforms and other errors fail on the first attempt.
 */
export async function removeExecutedFixtureDirectory(
  directory: string,
  deadlineMs: number,
  removal: Partial<ExecutedFixtureRemoval> = {},
): Promise<void> {
  const { platform, remove, wait, now } = { ...defaults, ...removal };
  const started = now();
  let first: unknown;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      remove(directory);
      return;
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
