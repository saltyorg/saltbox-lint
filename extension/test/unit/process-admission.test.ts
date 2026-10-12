import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ProcessRequest, runProcess } from "../../src/process.ts";
import {
  holdProcessAdmission,
  observeDocumentChange,
} from "../support/process-admission.ts";
import { withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request: ProcessRequest = {
  executable: "tested-backend",
  cwd: "/tested-root",
  args: ["query", "--operation", "definition"],
  input: "captured original source",
};

test("query admission exposes the captured request before releasing the actual runner", async () => {
  let calls = 0;
  const run: typeof runProcess = async (actual) => {
    calls++;
    assert.equal(actual, request);
    return "actual response";
  };
  const gate = holdProcessAdmission(run, "query");
  const work = gate.runProcess(request, new AbortController().signal);
  try {
    assert.equal(await gate.admission(), request);
    assert.equal(calls, 0, "runner admission is not native spawn");
    gate.release();
    assert.equal(await work, "actual response");
    assert.equal(calls, 1);
  } finally {
    gate.dispose();
    await Promise.allSettled([work]);
    await gate.join();
  }
});

test("non-query traffic remains transparent and joining waits for admitted runner settlement", async () => {
  const entered = deferred<void>(),
    finished = deferred<string>();
  const gate = holdProcessAdmission(async (actual) => {
    assert.equal(actual.args[0], "rules");
    entered.resolve();
    return finished.promise;
  }, "query");
  const work = gate.runProcess(
    { ...request, args: ["rules"] },
    new AbortController().signal,
  );
  let joined = false;
  const joining = gate.join().then(() => {
    joined = true;
  });
  try {
    await entered.promise;
    gate.dispose();
    await setImmediate();
    assert.equal(joined, false);
    finished.resolve("actual registry");
    assert.equal(await work, "actual registry");
    await joining;
    assert.equal(joined, true);
  } finally {
    finished.resolve("cleanup registry");
    gate.dispose();
    await Promise.allSettled([work, joining]);
    await gate.join();
  }
});

test("owner disposal settles missing admission and refuses a future query without a runner call", async () => {
  let calls = 0;
  const gate = holdProcessAdmission(async () => {
    calls++;
    return "unexpected";
  }, "query");
  const wait = assert.rejects(gate.admission(), /owner closed/);
  gate.dispose();
  await wait;
  await assert.rejects(
    gate.runProcess(request, new AbortController().signal),
    /owner closed/,
  );
  await gate.join();
  assert.equal(calls, 0);
});

test("source cancellation can settle a held request without inventing a native launch", async () => {
  const abort = new AbortController();
  let calls = 0;
  const failure = new Error("actual runner canceled before spawn");
  const gate = holdProcessAdmission(
    async (_request, signal, observeFailure) => {
      calls++;
      assert.equal(signal.aborted, true);
      observeFailure?.("cancelled");
      throw failure;
    },
    "query",
  );
  const work = gate.runProcess(request, abort.signal);
  const rejected = assert.rejects(work, (error: unknown) => error === failure);
  await gate.admission();
  abort.abort();
  gate.release();
  await rejected;
  gate.dispose();
  await gate.join();
  assert.equal(calls, 1);
});

test("unexpected runner failure preserves its identity and is reported by ownership join", async () => {
  const failure = new Error("actual runner failed");
  const gate = holdProcessAdmission(async () => {
    throw failure;
  }, "query");
  const work = gate.runProcess(request, new AbortController().signal);
  const rejected = assert.rejects(work, (error: unknown) => error === failure);
  await gate.admission();
  gate.release();
  await rejected;
  gate.dispose();
  await assert.rejects(gate.join(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, failure);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
});

test("format admission is held independently while query and registry calls retain their actual responses", async () => {
  const calls: string[] = [];
  const gate = holdProcessAdmission(async (actual) => {
    calls.push(actual.args[0]);
    return actual.args[0] + " response";
  }, "format");
  assert.equal(
    await gate.runProcess(request, new AbortController().signal),
    "query response",
  );
  const formatted = gate.runProcess(
    { ...request, args: ["format"] },
    new AbortController().signal,
  );
  try {
    assert.equal((await gate.admission()).input, request.input);
    assert.deepEqual(calls, ["query"]);
    assert.equal(
      await gate.runProcess(
        { ...request, args: ["rules"] },
        new AbortController().signal,
      ),
      "rules response",
    );
    gate.release();
    assert.equal(await formatted, "format response");
    assert.deepEqual(calls, ["query", "rules", "format"]);
  } finally {
    gate.dispose();
    await Promise.allSettled([formatted]);
    await gate.join();
  }
});

test("document change readiness observes the exact document before edit completion and ignores unrelated or empty events", async () => {
  const document = { name: "source" },
    unrelated = { name: "other" };
  let change!: (event: {
    document: typeof document;
    contentChanges: readonly unknown[];
  }) => void;
  let disposals = 0;
  const observer = observeDocumentChange(document, (listener) => {
    change = listener;
    return {
      dispose() {
        disposals++;
      },
    };
  });
  let completed = false;
  const pending = observer.changed().then(() => {
    completed = true;
  });
  try {
    change({ document: unrelated, contentChanges: [{}] });
    change({ document, contentChanges: [] });
    await setImmediate();
    assert.equal(completed, false);
    change({ document, contentChanges: [{}] });
    await pending;
    assert.equal(completed, true);
  } finally {
    observer.dispose();
    await Promise.allSettled([pending]);
    await observer.join();
  }
  observer.dispose();
  assert.equal(disposals, 1);
});

test("disposing an unobserved document change settles its wait and preserves subscription disposal failure", async () => {
  const failure = new Error("subscription disposal denied");
  const observer = observeDocumentChange({}, () => ({
    dispose() {
      throw failure;
    },
  }));
  const wait = assert.rejects(observer.changed(), /before its event/);
  assert.throws(
    () => observer.dispose(),
    (error: unknown) => error === failure,
  );
  await wait;
  await observer.join();
});

test("resource failure releases a held admission before joining its request and disposes event readiness", async () => {
  const primary = new Error("body failed after snapshot admission");
  let calls = 0,
    eventDisposals = 0,
    requestSettled = false;
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 1000 }, async (owner) => {
      const gate = ownJoinedResource(
        owner,
        "controlled runner",
        holdProcessAdmission(async () => {
          calls++;
          return "unexpected native response";
        }, "query"),
      );
      ownJoinedResource(
        owner,
        "controlled document event",
        observeDocumentChange({}, () => ({
          dispose() {
            eventDisposals++;
          },
        })),
      );
      const pending = owner.operation("held admitted query", async (signal) => {
        try {
          await gate.runProcess(request, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        } finally {
          requestSettled = true;
        }
      });
      await gate.admission();
      assert.equal(calls, 0);
      pending.catch(() => undefined);
      throw primary;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary]);
      return true;
    },
  );
  assert.equal(calls, 0);
  assert.equal(requestSettled, true);
  assert.equal(eventDisposals, 1);
});

for (const cleanupFailed of [false, true]) {
  test(`aborted delegated work ${cleanupFailed ? "retains original and cleanup failures" : "joins an observed cancellation"}`, async () => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const abort = new AbortController();
    const cancellation = new Error("Canceled");
    const cleanup = new Error("native ownership cleanup failed");
    const failure = cleanupFailed
      ? new AggregateError(
          [cancellation, cleanup],
          "process and cleanup failed",
          { cause: cancellation },
        )
      : cancellation;
    const gate = holdProcessAdmission(
      async (_request, _signal, observeFailure) => {
        entered.resolve();
        await release.promise;
        observeFailure?.("cancelled");
        throw failure;
      },
      "query",
    );
    const work = gate.runProcess(request, abort.signal);
    const rejected = assert.rejects(
      work,
      (error: unknown) => error === failure,
    );
    await gate.admission();
    gate.release();
    await entered.promise;
    abort.abort();
    release.resolve();
    await rejected;
    gate.dispose();
    if (cleanupFailed)
      await assert.rejects(gate.join(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, failure);
        assert.deepEqual(error.errors, [failure]);
        return true;
      });
    else await gate.join();
  });
}

for (const category of ["setup", "termination", undefined] as const) {
  test(`pre-delegation abort preserves ${category ?? "unclassified"} runner failure`, async () => {
    const abort = new AbortController();
    const fault = Object.assign(new Error("unexpected delegated failure"), {
      code: "EPERM",
    });
    const gate = holdProcessAdmission(
      async (_request, _signal, observeFailure) => {
        if (category) observeFailure?.(category);
        throw fault;
      },
      "query",
    );
    const work = gate.runProcess(request, abort.signal);
    const rejected = assert.rejects(work, (error: unknown) => error === fault);
    await gate.admission();
    abort.abort();
    gate.release();
    await rejected;
    gate.dispose();
    await assert.rejects(gate.join(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, fault);
      assert.deepEqual(error.errors, [fault]);
      return true;
    });
  });
}

test("pre-delegation abort retains aggregate cleanup failure even with cancellation metadata", async () => {
  const abort = new AbortController();
  const cancellation = new Error("Canceled");
  const cleanup = new Error("native cleanup failed");
  const fault = new AggregateError(
    [cancellation, cleanup],
    "process and cleanup failed",
    { cause: cancellation },
  );
  const gate = holdProcessAdmission(
    async (_request, _signal, observeFailure) => {
      observeFailure?.("cancelled");
      throw fault;
    },
    "query",
  );
  const work = gate.runProcess(request, abort.signal);
  const rejected = assert.rejects(work, (error: unknown) => error === fault);
  await gate.admission();
  abort.abort();
  gate.release();
  await rejected;
  gate.dispose();
  await assert.rejects(gate.join(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, fault);
    assert.deepEqual(error.errors, [fault]);
    return true;
  });
});
