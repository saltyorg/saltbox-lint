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

for (const count of [40, 100]) {
  test(`retaining queue executes all ${count} distinct requests with one active operation`, async () => {
    const scheduler = new Scheduler("retain");
    const gate = latch();
    let active = 0;
    let maximum = 0;
    const seen: number[] = [];
    const first = scheduler.submit("held", 0, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active--;
    });
    const pending = Array.from({ length: count }, (_, index) =>
      scheduler.submit(String(index), 1, async () => {
        active++;
        maximum = Math.max(maximum, active);
        seen.push(index);
        await Promise.resolve();
        active--;
        return index;
      }),
    );
    assert.deepEqual(seen, [], "pending operations must remain lazy");
    gate.resolve();
    await first;
    assert.deepEqual(
      await Promise.all(pending),
      Array.from({ length: count }, (_, i) => i),
    );
    assert.deepEqual(
      seen,
      Array.from({ length: count }, (_, i) => i),
    );
    assert.equal(maximum, 1);
    scheduler.dispose();
  });
}

test("retaining queue coalesces keys and preserves priority and FIFO", async () => {
  const scheduler = new Scheduler("retain");
  const gate = latch();
  const seen: string[] = [];
  const first = scheduler.submit("held", 0, async () => gate.promise);
  const submit = (key: string, priority: number, value = key) =>
    scheduler.submit(key, priority, async () => {
      seen.push(value);
      return value;
    });
  const background = submit("background", 0);
  const old = submit("document", 1, "old");
  const peer = submit("peer", 1);
  const latest = submit("document", 1, "latest");
  const manual = submit("manual", 2);
  const canceled = submit("canceled", 2);
  scheduler.cancel("canceled");
  gate.resolve();
  await Promise.all([first, background, old, peer, latest, manual, canceled]);
  assert.equal(await old, undefined);
  assert.equal(await canceled, undefined);
  assert.deepEqual(seen, ["manual", "peer", "latest", "background"]);
  scheduler.dispose();
});

test("disposing a retaining queue cancels all pending work and joins its active operation", async () => {
  const scheduler = new Scheduler("retain");
  const gate = latch();
  let joined = false;
  let signal!: AbortSignal;
  const first = scheduler.submit("held", 1, async (token) => {
    signal = token;
    await gate.promise;
    joined = true;
  });
  const pending = Array.from({ length: 100 }, (_, index) =>
    scheduler.submit(String(index), 1, async () =>
      assert.fail("disposed work ran"),
    ),
  );
  scheduler.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(joined, false);
  gate.resolve();
  await first;
  assert.equal(joined, true);
  assert.ok((await Promise.all(pending)).every((value) => value === undefined));
  assert.equal(
    await scheduler.submit("late", 1, async () => assert.fail("late work ran")),
    undefined,
  );
});
