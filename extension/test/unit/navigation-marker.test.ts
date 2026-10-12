import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import type { ProcessRequest } from "../../src/process.ts";
import {
  deferred,
  sourceText,
  withNavigationFixture,
} from "../support/navigation-fixture.ts";

for (const replacement of ["removed", "symlink", "directory"] as const) {
  test(`manual navigation rejects a ${replacement} marker without watcher delivery and accepts its first restoration`, async () => {
    let wire!: (request: ProcessRequest) => string;
    let calls = 0;
    await withNavigationFixture(
      {
        runProcess: async (request) => {
          calls++;
          return wire(request);
        },
      },
      async (f) => {
        wire = f.wire;
        assert.equal((await f.editor.navigation.impact())?.state, "resolved");
        assert.equal(calls, 1);
        const marker = join(f.root, ".saltbox-lint");
        await rm(marker);
        if (replacement === "symlink")
          await symlink(f.root, marker, "junction");
        if (replacement === "directory") await mkdir(marker);
        assert.equal(await f.editor.navigation.impact(), undefined);
        assert.equal(
          calls,
          1,
          "marker admission refuses before launching a query",
        );
        await rm(marker, { recursive: true, force: true });
        await writeFile(marker, "");
        assert.equal((await f.editor.navigation.impact())?.state, "resolved");
        assert.equal(
          calls,
          2,
          "the first restored request succeeds without an event or retry",
        );
      },
    );
  });
}

test("an edit during the actual manual marker probe declines the original cursor before backend submission", async () => {
  const entered = deferred<void>(),
    released = deferred<void>();
  let hold = false;
  let wire!: (request: ProcessRequest) => string;
  let calls = 0;
  await withNavigationFixture(
    {
      roots: {
        lstat: (async (...args: Parameters<typeof lstat>) => {
          if (hold) {
            entered.resolve();
            await released.promise;
          }
          return Reflect.apply(lstat, undefined, args);
        }) as typeof lstat,
      },
      runProcess: async (request) => {
        calls++;
        return wire(request);
      },
    },
    async (f) => {
      wire = f.wire;
      assert.equal((await f.editor.navigation.impact())?.state, "resolved");
      hold = true;
      const pending = f.resources.operation("manual marker query", () =>
        f.editor.navigation.impact(),
      );
      try {
        await entered.promise;
        f.document.edit("# changed while marker probe was held\n" + sourceText);
        f.editor.change(f.document.asDocument());
      } finally {
        released.resolve();
      }
      assert.equal(await pending, undefined);
      assert.equal(
        calls,
        1,
        "the old cursor never reaches the backend after its probe yields",
      );
    },
  );
});
