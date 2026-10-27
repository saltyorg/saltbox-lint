import assert from "node:assert/strict";
import { test } from "node:test";
import { fileClock, settleFiles } from "../support/file-clock.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("settleFiles waits for admitted work that outlasts the delivery budget in idle turns", async () => {
  const timer = fileClock();
  let finished = false;
  // Admitted file I/O can stay in flight for many event-loop turns on a busy
  // host without re-arming any timer; that is progress, not a livelock.
  const work = (async () => {
    for (let i = 0; i < 5000; i++) await turn();
    finished = true;
  })();
  await settleFiles({ join: () => work }, timer);
  assert.equal(finished, true);
});

test("settleFiles fails when a producer keeps re-queueing timers", async () => {
  const timer = fileClock();
  let release!: () => void;
  const join = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rearm = () => timer.schedule(rearm, 100);
  rearm();
  await assert.rejects(
    settleFiles({ join: () => join }, timer),
    /kept re-queueing timers/,
  );
  release();
});
