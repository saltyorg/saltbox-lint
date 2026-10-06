import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LiveChecks,
  typingDebounceMs,
  typingDocumentLimit,
} from "../../src/live-checks.ts";
import { Scheduler } from "../../src/scheduler.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a burst keeps one latest document request and cancels and joins before its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = latch();
  const runs: { version: number; signal: AbortSignal }[] = [];
  const document = { version: 1 };
  const live = new LiveChecks(
    async (value: typeof document, signal) => {
      runs.push({ version: value.version, signal });
      if (runs.length === 1) await held.promise;
    },
    (error) => {
      throw error;
    },
  );
  for (let index = 0; index < 20; index++) {
    document.version++;
    live.schedule(document);
    t.mock.timers.tick(20);
  }
  assert.equal(runs.length, 0);
  t.mock.timers.tick(typingDebounceMs);
  assert.deepEqual(
    runs.map((run) => run.version),
    [21],
  );
  document.version++;
  live.schedule(document);
  assert.equal(runs[0].signal.aborted, true);
  t.mock.timers.tick(typingDebounceMs);
  assert.equal(runs.length, 1, "a ready replacement waits for complete join");
  const joined = live.join();
  held.resolve();
  await joined;
  await live.join();
  assert.deepEqual(
    runs.map((run) => run.version),
    [21, 22],
  );
  live.dispose();
});

test("document objects do not share debounce ownership even when their URI strings match", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = { uri: "same" };
  const second = { uri: "same" };
  const seen: object[] = [];
  const live = new LiveChecks(
    async (value) => {
      seen.push(value);
    },
    (error) => {
      throw error;
    },
  );
  live.schedule(first);
  live.schedule(second);
  live.cancel(first);
  t.mock.timers.tick(typingDebounceMs);
  await live.join();
  assert.deepEqual(seen, [second]);
  live.dispose();
});

test("overflow evicts the oldest waiting timer, never a running slot before join", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = latch();
  const documents = Array.from(
    { length: typingDocumentLimit + 2 },
    (_, id) => ({ id }),
  );
  const runs: number[] = [];
  const live = new LiveChecks(
    async (value: { id: number }) => {
      runs.push(value.id);
      await held.promise;
    },
    (error) => {
      throw error;
    },
  );
  for (const document of documents.slice(0, typingDocumentLimit + 1))
    live.schedule(document);
  t.mock.timers.tick(typingDebounceMs);
  assert.deepEqual(
    runs,
    documents.slice(1, typingDocumentLimit + 1).map((value) => value.id),
  );
  live.cancel(documents[1]);
  live.schedule(documents.at(-1)!);
  t.mock.timers.tick(typingDebounceMs);
  assert.equal(
    runs.length,
    typingDocumentLimit,
    "canceled active slot stays charged",
  );
  live.dispose();
  const joined = live.join();
  held.resolve();
  await joined;
  live.schedule(documents[0]);
  t.mock.timers.tick(typingDebounceMs);
  assert.equal(runs.length, typingDocumentLimit);
});

for (const control of [
  "close",
  "root removal",
  "setting off",
  "dispose",
] as const) {
  test(`${control} clears waiting timers and cancels active work through join`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const held = latch();
    const signals: AbortSignal[] = [];
    const live = new LiveChecks(
      async (_document, signal) => {
        signals.push(signal);
        await held.promise;
      },
      (error) => {
        throw error;
      },
    );
    const active = {};
    live.schedule(active);
    t.mock.timers.tick(typingDebounceMs);
    live.schedule({});
    if (control === "dispose") live.dispose();
    else live.cancelWhere(() => true);
    assert.equal(signals[0].aborted, true);
    t.mock.timers.tick(typingDebounceMs);
    assert.equal(signals.length, 1);
    const joined = live.join();
    held.resolve();
    await joined;
    live.dispose();
  });
}

test("manual and save work preempt typing and join it; retained startup and dependencies run before typing", async () => {
  const scheduler = new Scheduler("retain");
  const held = latch();
  const entered = latch();
  const seen: string[] = [];
  let signal!: AbortSignal;
  const active = scheduler.submit("typing-active", -1, async (token) => {
    signal = token;
    entered.resolve();
    await held.promise;
    seen.push("joined");
  });
  await entered.promise;
  const typing = Array.from({ length: 32 }, (_, id) =>
    scheduler.submit(`typing-${id}`, -1, async () => {
      seen.push(`typing-${id}`);
    }),
  );
  const startup = scheduler.submit("workspace", 0, async () => {
    seen.push("startup");
  });
  const dependency = scheduler.submit("files", 0, async () => {
    seen.push("dependency");
  });
  const save = scheduler.submit("save", 1, async () => {
    seen.push("save");
  });
  const manual = scheduler.submit("manual", 2, async () => {
    seen.push("manual");
  });
  assert.equal(signal.aborted, true);
  assert.deepEqual(seen, []);
  held.resolve();
  await Promise.all([active, manual, save, startup, dependency, ...typing]);
  assert.deepEqual(seen.slice(0, 5), [
    "joined",
    "manual",
    "save",
    "startup",
    "dependency",
  ]);
  assert.equal(seen.length, 37);
  scheduler.dispose();
});
