import assert from "node:assert/strict";
import { test } from "node:test";
import { removeExecutedFixtureDirectory } from "../support/executed-fixture-directory.ts";

function busy(code: string) {
  return Object.assign(new Error(`${code}, locked`), { code });
}

function clock() {
  let time = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    wait: async (milliseconds: number) => {
      waits.push(milliseconds);
      time += milliseconds;
    },
  };
}

test("windows removal waits asynchronously for a released fixture image", async () => {
  const c = clock();
  let attempts = 0;
  const released = await removeExecutedFixtureDirectory("fixture", 3000, {
    platform: "win32",
    now: c.now,
    wait: c.wait,
    remove: () => {
      if (++attempts < 3) throw busy(attempts === 1 ? "EPERM" : "EBUSY");
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(c.waits, [50, 50]);
  assert.deepEqual(released, { attempts: 3, waitedMs: 100 });
});

test("windows removal reports the first lock as the cause after the deadline", async () => {
  const c = clock();
  const errors: Error[] = [];
  await assert.rejects(
    removeExecutedFixtureDirectory("fixture", 200, {
      platform: "win32",
      now: c.now,
      wait: c.wait,
      remove: () => {
        const error = busy("EPERM");
        errors.push(error);
        throw error;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not released within 200ms after 5 attempts/);
      assert.equal(error.cause, errors[0]);
      return true;
    },
  );
  assert.equal(errors.length, 5);
});

test("other platforms and other errors fail on the first attempt", async () => {
  for (const [platform, code] of [
    ["linux", "EPERM"],
    ["darwin", "EBUSY"],
    ["win32", "EACCES"],
    ["win32", "ENOTDIR"],
  ] as const) {
    const c = clock();
    const error = busy(code);
    let attempts = 0;
    await assert.rejects(
      removeExecutedFixtureDirectory("fixture", 3000, {
        platform,
        now: c.now,
        wait: c.wait,
        remove: () => {
          attempts++;
          throw error;
        },
      }),
      (failure: unknown) => failure === error,
    );
    assert.equal(attempts, 1, `${platform} ${code}`);
    assert.deepEqual(c.waits, []);
  }
});
