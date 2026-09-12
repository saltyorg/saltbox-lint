import assert from "node:assert/strict";
import { test } from "node:test";
import { Scheduler } from "../../src/scheduler.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("scheduler runs latest pending snapshot and cancels superseded active work", async () => {
  const scheduler = new Scheduler();
  const started = latch();
  const seen: string[] = [];
  let aborted = false;
  const first = scheduler.submit("a", 1, async (signal) => {
    started.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return "old";
  });
  // Stub must fail behaviorally without hanging the RED run.
  await Promise.race([started.promise, first]);
  const second = scheduler.submit("a", 1, async () => {
    seen.push("middle");
    return "middle";
  });
  const third = scheduler.submit("a", 1, async () => {
    seen.push("latest");
    return "latest";
  });
  assert.equal(await third, "latest");
  assert.equal(await first, undefined);
  assert.equal(await second, undefined);
  assert.equal(aborted, true);
  assert.deepEqual(seen, ["latest"]);
  scheduler.dispose();
});
test("canceled queued formatter never executes", async () => {
  const scheduler = new Scheduler();
  const gate = latch();
  const first = scheduler.submit("a", 1, async () => {
    await gate.promise;
    return 1;
  });
  const abort = new AbortController();
  const second = scheduler.submit("b", 1, async () => 2, abort.signal);
  abort.abort();
  gate.resolve();
  assert.equal(await first, 1);
  assert.equal(await second, undefined);
  scheduler.dispose();
});
test("bounded queue evicts old background work and runs interactive work first", async () => {
  const scheduler = new Scheduler(2);
  const gate = latch();
  const seen: string[] = [];
  const active = scheduler.submit("active", 0, async () => {
    await gate.promise;
    return "active";
  });
  const dropped = scheduler.submit("old", 0, async () => {
    seen.push("old");
    return "old";
  });
  const background = scheduler.submit("background", 0, async () => {
    seen.push("background");
    return "background";
  });
  const interactive = scheduler.submit("format", 2, async () => {
    seen.push("format");
    return "format";
  });
  gate.resolve();
  await active;
  assert.equal(await dropped, undefined);
  assert.equal(await interactive, "format");
  await background;
  assert.deepEqual(seen, ["format", "background"]);
  scheduler.dispose();
});
test("cancelAll joins active cancellation and prevents queued root work", async () => {
  const scheduler = new Scheduler();
  const started = latch();
  let completed = false;
  const active = scheduler.submit("active", 0, async (signal) => {
    started.resolve();
    await new Promise<void>((r) =>
      signal.addEventListener("abort", () => r(), { once: true }),
    );
    completed = true;
  });
  await started.promise;
  const queued = scheduler.submit("queued", 0, async () => {
    throw new Error("must not run");
  });
  scheduler.cancelAll();
  await active;
  assert.equal(await queued, undefined);
  assert.equal(completed, true);
  assert.equal(await scheduler.submit("new-root", 1, async () => 3), 3);
  scheduler.dispose();
});
test("a superseded request's token cannot cancel its replacement", async () => {
  const scheduler = new Scheduler();
  const oldToken = new AbortController();
  const releaseOld = latch();
  const first = scheduler.submit(
    "document",
    1,
    async () => {
      await releaseOld.promise;
      return "old";
    },
    oldToken.signal,
  );
  const replacement = scheduler.submit(
    "document",
    1,
    async () => "replacement",
  );
  oldToken.abort();
  releaseOld.resolve();
  await first;
  assert.equal(await replacement, "replacement");
  scheduler.dispose();
});
