import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import {
  TestResourceError,
  TestResources,
  withTestResources,
} from "../support/test-resources.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function deadlines() {
  const scheduled: {
    expire: () => void;
    milliseconds: number;
    active: boolean;
  }[] = [];
  return {
    scheduled,
    schedule(expire: () => void, milliseconds: number) {
      const deadline = { expire, milliseconds, active: true };
      scheduled.push(deadline);
      return () => {
        deadline.active = false;
      };
    },
    expire() {
      const deadline = scheduled.find((entry) => entry.active);
      assert.ok(deadline, "a cleanup deadline has been registered");
      deadline.expire();
    },
  };
}

function assertClosed(resources: TestResources) {
  assert.deepEqual(resources.snapshot(), {
    phase: "closed",
    operations: [],
    cleanups: [],
  });
}

function resourceErrors(error: unknown): TestResourceError[] {
  assert.ok(error instanceof AggregateError);
  const errors: unknown[] = error.errors;
  for (const failure of errors) assert.ok(failure instanceof TestResourceError);
  return errors as TestResourceError[];
}

test("parent cancellation stops nested work while restoration uses an independent signal", async () => {
  const parent = new AbortController();
  const entered = deferred(),
    release = deferred();
  let nested: TestResources | undefined;
  const work = withTestResources(
    { cleanupTimeoutMs: 1000, operationSignal: parent.signal },
    async (resources) => {
      nested = resources;
      resources.defer("restore", (signal) => {
        assert.equal(signal.aborted, false);
        assert.equal(resources.signal.aborted, true);
      });
      await resources.operation("controlled work", async (signal) => {
        signal.addEventListener("abort", () => release.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
      });
    },
  );
  await entered.promise;
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  const reason = new Error("outer operation failed");
  parent.abort(reason);
  assert.equal(nested?.signal.reason, reason);
  await work;
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("an already-aborted parent prevents nested setup and releases its listener", async () => {
  const parent = new AbortController();
  const reason = new Error("outer operation already failed");
  parent.abort(reason);
  let started = false;
  await assert.rejects(
    withTestResources(
      { cleanupTimeoutMs: 1000, operationSignal: parent.signal },
      () => {
        started = true;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [reason]);
      return true;
    },
  );
  assert.equal(started, false);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("the parent listener remains owned through failed restoration and is then removed", async () => {
  const parent = new AbortController();
  const resources = new TestResources({
    cleanupTimeoutMs: 1000,
    operationSignal: parent.signal,
  });
  const entered = deferred(),
    release = deferred();
  const failure = new Error("restoration failed");
  resources.defer("held restoration", async () => {
    entered.resolve();
    await release.promise;
    throw failure;
  });
  const closing = resources.close();
  await entered.promise;
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  release.resolve();
  await assert.rejects(closing, (error: unknown) => {
    assert.equal(resourceErrors(error)[0].cause, failure);
    return true;
  });
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("operations are named and admitted before their callback runs", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const finished = deferred<number>();
  const started = deferred();
  const operation = resources.operation("document write", async (signal) => {
    assert.equal(signal, resources.signal);
    assert.deepEqual(resources.snapshot().operations, ["document write"]);
    started.resolve();
    return finished.promise;
  });
  assert.deepEqual(resources.snapshot().operations, ["document write"]);
  await started.promise;
  finished.resolve(42);
  assert.equal(await operation, 42);
  await resources.close();
  assertClosed(resources);
});

test("half-completed setup registers restoration before the next acquisition fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-test-owner-"));
  const filename = join(directory, "selected.yaml");
  const original = Buffer.from("original\r\nbytes\n");
  await writeFile(filename, original);
  const setupFailure = new Error("second resource acquisition failed");
  let resources: TestResources | undefined;
  try {
    await assert.rejects(
      withTestResources({ cleanupTimeoutMs: 1000 }, async (owner) => {
        resources = owner;
        owner.defer("restore source", () => writeFile(filename, original));
        await owner.operation("first acquisition", () =>
          writeFile(filename, "changed"),
        );
        throw setupFailure;
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [setupFailure]);
        return true;
      },
    );
    assert.deepEqual(await readFile(filename), original);
    assert.ok(resources);
    assertClosed(resources);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing seals operation admission before callbacks can create late work", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  let invoked = false;
  const closed = resources.close();
  assert.equal(resources.signal.aborted, true);
  assert.throws(
    () =>
      resources.operation("late write", () => {
        invoked = true;
      }),
    /Cannot admit.*late write.*joining/,
  );
  await closed;
  assert.equal(invoked, false);
  assert.throws(() => resources.defer("too late", () => {}), /while closed/);
  assertClosed(resources);
});

test("admitted acquisition may register its newly owned resource while closing joins it", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const acquired = deferred();
  const started = deferred();
  const order: string[] = [];
  resources.defer("earlier resource", () => {
    order.push("earlier resource restored");
  });
  const acquisition = resources.operation("late acquisition", async () => {
    started.resolve();
    await acquired.promise;
    resources.defer("late resource", () => {
      order.push("late resource restored");
    });
    order.push("acquired");
  });
  await started.promise;
  const closed = resources.close();
  assert.equal(resources.snapshot().phase, "joining");
  acquired.resolve();
  await acquisition;
  await closed;
  assert.deepEqual(order, [
    "acquired",
    "late resource restored",
    "earlier resource restored",
  ]);
  assertClosed(resources);
});

test("restoration joins deferred writes before restoring the exact original bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-test-write-"));
  const filename = join(directory, "selected.yaml");
  const original = Buffer.from("original\r\nbytes\n");
  await writeFile(filename, original);
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const partial = deferred();
  const release = deferred();
  let restored = false;
  resources.defer("restore file", async () => {
    await writeFile(filename, original);
    restored = true;
  });
  const operation = resources.operation("deferred write", async () => {
    await writeFile(filename, "partial");
    partial.resolve();
    await release.promise;
    await writeFile(filename, "late complete write");
  });
  try {
    await partial.promise;
    const closed = resources.close();
    assert.equal(restored, false);
    assert.deepEqual(resources.snapshot().operations, ["deferred write"]);
    release.resolve();
    await operation;
    await closed;
    assert.equal(restored, true);
    assert.deepEqual(await readFile(filename), original);
    assertClosed(resources);
  } finally {
    release.resolve();
    await resources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rejected partial write remains a failure after the original file is restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-test-partial-"));
  const filename = join(directory, "selected.yaml");
  const original = Buffer.from("unchanged original\n");
  await writeFile(filename, original);
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const writeFailure = new Error("write rejected after partial output");
  resources.defer("restore file", () => writeFile(filename, original));
  try {
    const operation = resources.operation("partial write", async () => {
      await writeFile(filename, "partial");
      throw writeFailure;
    });
    await assert.rejects(operation, (error: unknown) => error === writeFailure);
    await assert.rejects(resources.close(), (error: unknown) => {
      const errors = resourceErrors(error);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].phase, "operation");
      assert.equal(errors[0].resource, "partial write");
      assert.equal(errors[0].cause, writeFailure);
      return true;
    });
    assert.deepEqual(await readFile(filename), original);
    assertClosed(resources);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation before readiness reaches admitted work without aborting restoration", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  let cleanupSignal: AbortSignal | undefined;
  resources.defer("restore setting", (signal) => {
    cleanupSignal = signal;
    assert.equal(signal.aborted, false);
  });
  const result = resources.operation("start producer", (signal) => {
    assert.equal(signal.aborted, true);
    return "canceled before readiness";
  });
  resources.cancel(new Error("setup stopped"));
  assert.equal(await result, "canceled before readiness");
  await resources.close();
  assert.notEqual(cleanupSignal, resources.signal);
  assertClosed(resources);
});

test("cancellation after readiness is delivered before joining actual completion", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const ready = deferred();
  const aborted = deferred();
  const exited = deferred();
  const order: string[] = [];
  resources.defer("restore state", () => {
    order.push("restored");
  });
  const producer = resources.operation("ready producer", async (signal) => {
    const onAbort = () => aborted.resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      ready.resolve();
      await exited.promise;
      order.push("closed");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  });
  await ready.promise;
  const closed = resources.close();
  await aborted.promise;
  assert.deepEqual(order, []);
  assert.deepEqual(resources.snapshot().operations, ["ready producer"]);
  exited.resolve();
  await producer;
  await closed;
  assert.deepEqual(order, ["closed", "restored"]);
  assertClosed(resources);
});

test("body failure and reverse-order cleanup failures are preserved together", async () => {
  const bodyFailure = new Error("assertion failed");
  const closeFailure = new Error("owned pipe failed to close");
  const restoreFailure = new Error("setting restoration failed");
  const order: string[] = [];
  let resources: TestResources | undefined;
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 1000 }, (owner) => {
      resources = owner;
      owner.defer("restore setting", () => {
        order.push("restore setting");
        throw restoreFailure;
      });
      owner.defer("close pipe", () => {
        order.push("close pipe");
        throw closeFailure;
      });
      throw bodyFailure;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], bodyFailure);
      const cleanup = resourceErrors(new AggregateError(error.errors.slice(1)));
      assert.deepEqual(
        cleanup.map((failure) => [failure.resource, failure.cause]),
        [
          ["close pipe", closeFailure],
          ["restore setting", restoreFailure],
        ],
      );
      return true;
    },
  );
  assert.deepEqual(order, ["close pipe", "restore setting"]);
  assert.ok(resources);
  assertClosed(resources);
});

test("awaited operation failure is not duplicated as both body and operation failure", async () => {
  const failure = new Error("operation rejected");
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 1000 }, async (owner) => {
      await owner.operation("expected result", () => Promise.reject(failure));
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    },
  );
});

test("an unawaited rejected operation stays owned and fails closure", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const failure = new Error("background write failed");
  const background = resources.operation("background write", () =>
    Promise.reject(failure),
  );
  assert.ok(background instanceof Promise);
  await assert.rejects(resources.close(), (error: unknown) => {
    assert.equal(resourceErrors(error)[0].cause, failure);
    return true;
  });
  assertClosed(resources);
});

test("the joining deadline retains admitted acquisitions until actual settlement and preserves restoration failures", async () => {
  const clock = deadlines();
  const resources = new TestResources({
    cleanupTimeoutMs: 123,
    scheduleDeadline: clock.schedule,
  });
  const entered = deferred(),
    release = deferred();
  const failure = new Error("late acquired resource restoration failed");
  let restored = false,
    settled = false;
  const operation = resources.operation("late acquisition", async () => {
    entered.resolve();
    await release.promise;
    resources.defer("late acquired resource", () => {
      restored = true;
      throw failure;
    });
  });
  await entered.promise;
  const closing = resources.close();
  const outcome = closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await Promise.resolve();
    assert.equal(clock.scheduled.length, 1);
    clock.expire();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(restored, false);
    assert.deepEqual(resources.snapshot().operations, ["late acquisition"]);
  } finally {
    release.resolve();
    await operation;
    await outcome;
  }
  await assert.rejects(closing, (error: unknown) => {
    const failures = resourceErrors(error);
    assert.deepEqual(
      failures.map((item) => item.resource),
      ["admitted operations", "late acquired resource"],
    );
    assert.match(String(failures[0].cause), /exceeded 123ms/);
    assert.equal(failures[1].cause, failure);
    return true;
  });
  await outcome;
  assert.equal(restored, true);
  assert.equal(settled, true);
  assertClosed(resources);
});

test("each cleanup deadline is separate and abort does not substitute for settlement", async () => {
  const clock = deadlines();
  const resources = new TestResources({
    cleanupTimeoutMs: 123,
    scheduleDeadline: clock.schedule,
  });
  const entered = deferred();
  const settled = deferred();
  const nextCleanup = deferred();
  let cleanupSignal: AbortSignal | undefined;
  resources.defer("later restoration", (signal) => {
    assert.equal(signal.aborted, false);
    nextCleanup.resolve();
  });
  resources.defer("slow child close", async (signal) => {
    cleanupSignal = signal;
    entered.resolve();
    await settled.promise;
  });
  const closed = resources.close();
  await entered.promise;
  assert.equal(resources.snapshot().phase, "cleaning");
  assert.deepEqual(resources.snapshot().cleanups, [
    "later restoration",
    "slow child close",
  ]);
  clock.expire();
  assert.equal(cleanupSignal?.aborted, true);
  assert.deepEqual(resources.snapshot().cleanups, [
    "later restoration",
    "slow child close",
  ]);
  settled.resolve();
  await nextCleanup.promise;
  await assert.rejects(closed, (error: unknown) => {
    const errors = resourceErrors(error);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].resource, "slow child close");
    assert.match(String(errors[0].cause), /exceeded 123ms/);
    return true;
  });
  assert.deepEqual(
    clock.scheduled.map((deadline) => [deadline.milliseconds, deadline.active]),
    [
      [123, false],
      [123, false],
    ],
  );
  assertClosed(resources);
});

test("cleanup cancellation has a separate signal and still joins restoration", async () => {
  const cleanup = new AbortController();
  const resources = new TestResources({
    cleanupTimeoutMs: 1000,
    cleanupSignal: cleanup.signal,
  });
  const entered = deferred();
  const complete = deferred();
  let signal: AbortSignal | undefined;
  resources.defer("restore state", async (cleanupSignal) => {
    signal = cleanupSignal;
    entered.resolve();
    await complete.promise;
  });
  resources.cancel(new Error("work canceled"));
  const closed = resources.close();
  await entered.promise;
  assert.equal(signal?.aborted, false);
  cleanup.abort(new Error("external cleanup budget exhausted"));
  assert.equal(signal?.aborted, true);
  assert.equal(resources.snapshot().phase, "cleaning");
  complete.resolve();
  await assert.rejects(closed, (error: unknown) => {
    assert.match(String(resourceErrors(error)[0].cause), /canceled/);
    return true;
  });
  assertClosed(resources);
});

test("already-canceled cleanup is attempted and fails even if callback returns", async () => {
  const cleanup = new AbortController();
  cleanup.abort(new Error("launcher is terminating"));
  const resources = new TestResources({
    cleanupTimeoutMs: 1000,
    cleanupSignal: cleanup.signal,
  });
  let attempted = false;
  resources.defer("restore state", (signal) => {
    assert.equal(signal.aborted, true);
    attempted = true;
  });
  await assert.rejects(resources.close(), (error: unknown) => {
    assert.match(String(resourceErrors(error)[0].cause), /canceled/);
    return true;
  });
  assert.equal(attempted, true);
  assertClosed(resources);
});

test("cleanup preserves its cancellation and independently rejected join", async () => {
  const clock = deadlines();
  const entered = deferred();
  const join = deferred();
  const failure = new Error("pipe close failed after abort");
  const resources = new TestResources({
    cleanupTimeoutMs: 100,
    scheduleDeadline: clock.schedule,
  });
  resources.defer("close pipe", async () => {
    entered.resolve();
    await join.promise;
  });
  const closed = resources.close();
  await entered.promise;
  clock.expire();
  join.reject(failure);
  await assert.rejects(closed, (error: unknown) => {
    const cause = resourceErrors(error)[0].cause;
    assert.ok(cause instanceof AggregateError);
    assert.match(String(cause.errors[0]), /exceeded 100ms/);
    assert.equal(cause.errors[1], failure);
    return true;
  });
  assertClosed(resources);
});

test("deadline adapter failures cannot prevent restoration of subsequent resources", async () => {
  for (const phase of ["schedule", "cancel"] as const) {
    const failure = new Error(`deadline ${phase} failed`);
    const restored: string[] = [];
    const resources = new TestResources({
      cleanupTimeoutMs: 1000,
      scheduleDeadline() {
        if (phase === "schedule") throw failure;
        return () => {
          throw failure;
        };
      },
    });
    resources.defer("source", () => {
      restored.push("source");
    });
    resources.defer("setting", () => {
      restored.push("setting");
    });
    await assert.rejects(resources.close(), (error: unknown) => {
      const failures = resourceErrors(error);
      assert.deepEqual(
        failures.map((error) => [error.resource, error.cause]),
        [
          ["setting", failure],
          ["source", failure],
        ],
      );
      return true;
    });
    assert.deepEqual(restored, ["setting", "source"]);
    assertClosed(resources);
  }
});

test("cleanup may not register new work or restoration during state restoration", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  resources.defer("restore state", () => {
    assert.throws(
      () => resources.operation("late operation", () => {}),
      /while cleaning/,
    );
    assert.throws(
      () => resources.defer("late cleanup", () => {}),
      /while cleaning/,
    );
  });
  await resources.close();
  assertClosed(resources);
});

test("concurrent owners keep cancellation, work and reverse cleanup independent", async () => {
  for (const order of ["first-second", "second-first"] as const) {
    const first = new TestResources({ cleanupTimeoutMs: 1000 });
    const second = new TestResources({ cleanupTimeoutMs: 1000 });
    const firstDone = deferred();
    const secondDone = deferred();
    const ready = [deferred(), deferred()];
    const restored = [[], []] as string[][];
    for (const [index, owner] of [first, second].entries()) {
      owner.defer("workspace", () => {
        restored[index].push("workspace");
      });
      owner.defer("setting", () => {
        restored[index].push("setting");
      });
    }
    const work = [
      first.operation("first operation", async () => {
        ready[0].resolve();
        await firstDone.promise;
      }),
      second.operation("second operation", async () => {
        ready[1].resolve();
        await secondDone.promise;
      }),
    ];
    await Promise.all(ready.map((entry) => entry.promise));
    first.cancel();
    assert.equal(second.signal.aborted, false);
    const closures = [first.close(), second.close()];
    const [firstGate, secondGate] =
      order === "first-second"
        ? [firstDone, secondDone]
        : [secondDone, firstDone];
    firstGate.resolve();
    secondGate.resolve();
    await Promise.all(work);
    await Promise.all(closures);
    assert.deepEqual(restored, [
      ["setting", "workspace"],
      ["setting", "workspace"],
    ]);
    assertClosed(first);
    assertClosed(second);
  }
});

test("repeated close returns the same completion and restores exactly once", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  let restored = 0;
  resources.defer("resource", () => {
    restored += 1;
  });
  const first = resources.close();
  const second = resources.close();
  assert.equal(first, second);
  await first;
  assert.equal(resources.close(), first);
  assert.equal(restored, 1);
  assertClosed(resources);
});

test("ownership remains independent in 20 recorded completion orders", async (context) => {
  const permutations = [
    [0, 1, 2, 3],
    [0, 1, 3, 2],
    [0, 2, 1, 3],
    [0, 2, 3, 1],
    [0, 3, 1, 2],
    [0, 3, 2, 1],
    [1, 0, 2, 3],
    [1, 0, 3, 2],
    [1, 2, 0, 3],
    [1, 2, 3, 0],
    [1, 3, 0, 2],
    [1, 3, 2, 0],
    [2, 0, 1, 3],
    [2, 0, 3, 1],
    [2, 1, 0, 3],
    [2, 1, 3, 0],
    [2, 3, 0, 1],
    [2, 3, 1, 0],
    [3, 0, 1, 2],
    [3, 0, 2, 1],
  ];
  for (const order of permutations) {
    await context.test(`completion order ${order.join(",")}`, async () => {
      const gates = order.map(() => deferred());
      const started = order.map(() => deferred());
      const restored = order.map(() => [] as string[]);
      const owners = order.map(
        () => new TestResources({ cleanupTimeoutMs: 1000 }),
      );
      const operations = owners.map((owner, index) => {
        owner.defer("source", () => {
          restored[index].push("source");
        });
        return owner.operation("setup", async () => {
          started[index].resolve();
          await gates[index].promise;
          owner.defer("late setting", () => {
            restored[index].push("setting");
          });
        });
      });
      await Promise.all(started.map((gate) => gate.promise));
      const closures = owners.map((owner) => owner.close());
      for (const index of order) {
        gates[index].resolve();
        await closures[index];
        assert.deepEqual(restored[index], ["setting", "source"]);
        assertClosed(owners[index]);
      }
      await Promise.all(operations);
      await Promise.all(closures);
    });
  }
});

test("invalid cleanup budgets fail before acquiring any resource", () => {
  for (const timeout of [0, -1, Infinity, NaN]) {
    assert.throws(
      () => new TestResources({ cleanupTimeoutMs: timeout }),
      /positive finite cleanup timeout/,
    );
  }
});

test("withTestResources returns the body result after restoration", async () => {
  let restored = false;
  const result = await withTestResources(
    { cleanupTimeoutMs: 1000 },
    (resources) => {
      resources.defer("resource", () => {
        restored = true;
      });
      return { answer: 42 };
    },
  );
  assert.deepEqual(result, { answer: 42 });
  assert.equal(restored, true);
});
