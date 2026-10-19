import assert from "node:assert/strict";
import { test } from "node:test";
import { initialCodeAction } from "../support/initial-code-action.ts";

test("initial action setup waits for its action after an incomplete SDK cohort", async () => {
  const action = { command: "saltboxLint.applySharedFix" };
  let queries = 0;
  const result = await initialCodeAction({
    signal: new AbortController().signal,
    read: async () => (++queries === 1 ? undefined : action),
    guard() {},
    isCancellation: () => false,
  });
  assert.equal(result.value, action);
  assert.equal(result.queries, 2);
  assert.equal(queries, 2);
});

test("initial action setup observes SDK cancellation without hiding an unexpected failure", async () => {
  const cancelled = new Error("native request invalidated");
  const failure = new Error("operation failed");
  let queries = 0;
  await assert.rejects(
    initialCodeAction({
      signal: new AbortController().signal,
      read: async () => {
        throw ++queries === 1 ? cancelled : failure;
      },
      guard() {},
      isCancellation: (error) => error === cancelled,
    }),
    (error) => error === failure,
  );
  assert.equal(queries, 2);
});

test("initial action setup returns the real action after an SDK cancellation", async () => {
  const cancelled = new Error("native request invalidated");
  const action = {};
  let queries = 0;
  const result = await initialCodeAction({
    signal: new AbortController().signal,
    read: async () => {
      if (++queries === 1) throw cancelled;
      return action;
    },
    guard() {},
    isCancellation: (error) => error === cancelled,
  });
  assert.equal(result.value, action);
  assert.equal(result.queries, 2);
  assert.equal(result.cancellations, 1);
});

test("initial action setup rejects changed source even when an action arrives", async () => {
  const failure = new Error("fixture changed");
  let changed = false;
  let queries = 0;
  await assert.rejects(
    initialCodeAction({
      signal: new AbortController().signal,
      read: async () => {
        queries++;
        changed = true;
        return {};
      },
      guard() {
        if (changed) throw failure;
      },
      isCancellation: () => false,
    }),
    (error) => error === failure,
  );
  assert.equal(queries, 1);
});

test("initial action setup joins an admitted request before propagating owner cancellation", async (t) => {
  const controller = new AbortController();
  const cancelled = new Error("owner cancelled");
  let release!: (value: object) => void;
  let admitted!: () => void;
  const entered = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const held = new Promise<object>((resolve) => {
    release = resolve;
  });
  let settled = false;
  const pending = initialCodeAction({
    signal: controller.signal,
    read: async () => {
      admitted();
      return held;
    },
    guard() {},
    isCancellation: () => false,
  });
  const joined = pending.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  t.after(async () => {
    controller.abort(cancelled);
    release({});
    const outcome = await joined;
    if (!outcome.ok && outcome.error !== cancelled) throw outcome.error;
  });
  await Promise.race([
    entered,
    pending.then(() =>
      assert.fail("request must remain pending after admission"),
    ),
  ]);
  controller.abort(cancelled);
  await Promise.resolve();
  assert.equal(settled, false);
  release({});
  await assert.rejects(pending, (error) => error === cancelled);
});

test("initial action setup times out without accepting a late action and retains cancellation cause", async () => {
  const cancelled = new Error("SDK cancellation");
  let now = 0;
  let queries = 0;
  await assert.rejects(
    initialCodeAction({
      signal: new AbortController().signal,
      read: async () => {
        now += 5;
        if (++queries === 1) throw cancelled;
        return {};
      },
      guard() {},
      isCancellation: (error) => error === cancelled,
      timeoutMs: 10,
      clock: () => now,
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.cause === cancelled &&
      /2 queries/.test(error.message),
  );
  assert.equal(queries, 2);
});

test("initial action setup preserves an original error when classification also fails", async () => {
  const failure = new Error("SDK failed"),
    classification = new Error("classification failed");
  await assert.rejects(
    initialCodeAction({
      signal: new AbortController().signal,
      read: async () => {
        throw failure;
      },
      guard() {},
      isCancellation: () => {
        throw classification;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, classification]);
      assert.equal(error.cause, failure);
      return true;
    },
  );
});

test("initial action setup admits no work for an already cancelled owner", async () => {
  const controller = new AbortController(),
    cancelled = new Error("owner cancelled");
  controller.abort(cancelled);
  await assert.rejects(
    initialCodeAction({
      signal: controller.signal,
      read: async () => assert.fail("no admission after cancellation"),
      guard() {},
      isCancellation: () => false,
    }),
    (error) => error === cancelled,
  );
});
