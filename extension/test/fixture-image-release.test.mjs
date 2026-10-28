import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { removeExecutedFixtureDirectory } from "./support/executed-fixture-directory.ts";
import { withTestResources } from "./support/test-resources.ts";

const windows = process.platform === "win32";
// The Windows diagnostics workflow raises this to sample more image releases.
const requested = process.env.SALTBOX_IMAGE_RELEASE_ITERATIONS;
const iterations = requested ? Number(requested) : windows ? 30 : 5;
assert.ok(
  Number.isInteger(iterations) && iterations >= 1 && iterations <= 500,
  `SALTBOX_IMAGE_RELEASE_ITERATIONS must be 1-500, got ${requested}`,
);
const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Attempt one removal. A Windows image lock is reported, not thrown, so each
 * stage can be counted; any other failure ends the test.
 * @param {string} directory
 * @returns {string | undefined} the lock code, or undefined once removed
 */
function attemptRemoval(directory) {
  try {
    rmSync(directory, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (windows && (code === "EPERM" || code === "EBUSY")) return code;
    throw error;
  }
}

// Each iteration runs a freshly written fixture executable until Node's output
// cap kills it, exactly as the native group query does, then removes its
// directory. The stage that succeeds separates a libuv process handle closed
// one loop turn after 'close' from a longer-lived holder such as a scanner.
test("closed overflow fixture images are released before their directories are removed", async (t) => {
  await withTestResources({ cleanupTimeoutMs: 10000 }, async (resources) => {
    const build = mkdtempSync(join(tmpdir(), "saltbox-image-release-build-"));
    resources.defer("image release fixture build", () =>
      rmSync(build, { recursive: true, force: true }),
    );
    const binary = join(build, "process-fixture" + (windows ? ".exe" : ""));
    await ownedCommand(
      "go",
      [
        "build",
        "-o",
        binary,
        fileURLToPath(new URL("testdata/process_fixture.go", import.meta.url)),
      ],
      {
        phase: "image release fixture build",
        timeoutMs: 60000,
        env: { ...process.env, CGO_ENABLED: "0" },
      },
    );
    const stages = { immediate: 0, afterTurn: 0, observed: 0 };
    /** @type {string[]} */
    const locks = [];
    let longestObservedMs = 0;
    for (let i = 0; i < iterations; i++) {
      const directory = mkdtempSync(join(tmpdir(), "saltbox-image-release-"));
      let removed = false;
      resources.defer(`image release directory ${i}`, () =>
        removed ? undefined : removeExecutedFixtureDirectory(directory, 3000),
      );
      const executable = join(directory, basename(binary));
      copyFileSync(binary, executable);
      /** @type {(error: Error | null) => void} */
      let deliver = () => undefined;
      /** @type {Promise<Error | null>} */
      const result = new Promise((resolve) => {
        deliver = resolve;
      });
      const child = execFile(
        executable,
        ["query-overflow"],
        { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error) => deliver(error),
      );
      // A callback does not prove native close; join both before removal.
      const [error] = await Promise.all([result, once(child, "close")]);
      assert.equal(
        /** @type {NodeJS.ErrnoException | null} */ (error)?.code,
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      );
      const immediate = attemptRemoval(directory);
      if (immediate === undefined) {
        stages.immediate++;
        removed = true;
        continue;
      }
      locks.push(immediate);
      await turn();
      if (attemptRemoval(directory) === undefined) {
        stages.afterTurn++;
        removed = true;
        continue;
      }
      const started = Date.now();
      await removeExecutedFixtureDirectory(directory, 3000);
      longestObservedMs = Math.max(longestObservedMs, Date.now() - started);
      stages.observed++;
      removed = true;
    }
    t.diagnostic(
      `fixture image release ${process.platform}-${process.arch}: ${JSON.stringify(
        {
          iterations,
          ...stages,
          locks: [...new Set(locks)],
          longestObservedMs,
        },
      )}`,
    );
    assert.equal(
      stages.immediate + stages.afterTurn + stages.observed,
      iterations,
    );
  });
});
