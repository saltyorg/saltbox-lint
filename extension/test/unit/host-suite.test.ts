import assert from "node:assert/strict";
import { test } from "node:test";
import Mocha from "mocha";
import { runHostSuite } from "../support/host-suite.ts";
import {
  withTestResources,
  type TestResources,
} from "../support/test-resources.ts";

class SilentReporter extends Mocha.reporters.Base {}

test("named Mocha cases await their reverse cleanup before the next case", async () => {
  const events: string[] = [];
  await runHostSuite(
    "component",
    async () => {
      events.push("preflight");
    },
    [
      {
        name: "first scenario",
        async exercise(resources) {
          resources.defer("first", () => {
            events.push("first restored");
          });
          resources.defer("second", () => {
            events.push("second restored");
          });
          events.push("first case");
        },
      },
      {
        name: "second scenario",
        async exercise() {
          events.push("second case");
        },
      },
    ],
    { reporter: SilentReporter },
  );
  assert.deepEqual(events, [
    "preflight",
    "first case",
    "second restored",
    "first restored",
    "second case",
  ]);
});

test("a failed artifact preflight prevents behavior and resource acquisition", async () => {
  let exercised = false;
  const failure = new Error("wrong installed backend");
  await assert.rejects(
    runHostSuite(
      "component",
      async () => {
        throw failure;
      },
      [
        {
          name: "blocked scenario",
          async exercise() {
            exercised = true;
          },
        },
      ],
      { reporter: SilentReporter },
    ),
    (error: AggregateError) => error.errors.includes(failure),
  );
  assert.equal(exercised, false);
});

test("a body failure preserves an independently failed cleanup and joins admitted writes", async () => {
  const body = new Error("assertion");
  const cleanup = new Error("restore");
  let written = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  await assert.rejects(
    runHostSuite(
      "component",
      async () => {},
      [
        {
          name: "failed scenario",
          async exercise(resources) {
            resources.defer("restore", () => {
              assert.equal(written, true);
              events.push("restore");
              throw cleanup;
            });
            const pending = resources.operation(
              "late write",
              async (signal) => {
                signal.addEventListener("abort", () => release?.(), {
                  once: true,
                });
                await gate;
                written = true;
                events.push("write");
              },
            );
            assert.ok(pending instanceof Promise);
            await Promise.resolve();
            throw body;
          },
        },
      ],
      { reporter: SilentReporter },
    ),
    (error: AggregateError) => {
      const nested = error.errors[0] as AggregateError;
      assert.equal(nested.errors[0], body);
      assert.equal(nested.errors[1].cause, cleanup);
      return true;
    },
  );
  assert.deepEqual(events, ["write", "restore"]);
});

test("a Mocha timeout cannot release an unfinished async body", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let restored = false;
  class TimeoutReporter extends Mocha.reporters.Base {
    constructor(runner: Mocha.Runner) {
      super(runner);
      runner.on("fail", () => {
        assert.equal(restored, false);
        release?.();
      });
    }
  }
  await assert.rejects(
    runHostSuite(
      "component",
      async () => {},
      [
        {
          name: "held scenario",
          async exercise(resources) {
            resources.defer("restoration", () => {
              restored = true;
            });
            await gate;
          },
        },
      ],
      { reporter: TimeoutReporter, timeoutMs: 20 },
    ),
    /extension host tests failed/,
  );
  assert.equal(restored, true);
});

test("a Mocha timeout cancels its current resource owner and joins the losing operation", async () => {
  let release: (() => void) | undefined;
  let fallback: NodeJS.Immediate | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let canceled = false,
    written = false,
    restored = false;
  class TimeoutReporter extends Mocha.reporters.Base {
    constructor(runner: Mocha.Runner) {
      super(runner);
      runner.on("fail", () => {
        // Keep the regression bounded when timeout cancellation is removed.
        // This fallback releases the controlled loser, without marking it canceled.
        fallback = setImmediate(() => release?.());
      });
    }
  }
  try {
    await assert.rejects(
      runHostSuite(
        "component",
        async () => {},
        [
          {
            name: "held owned operation",
            async exercise(resources) {
              resources.defer("restore after writer", () => {
                assert.equal(written, true);
                restored = true;
              });
              resources.signal.addEventListener(
                "abort",
                () => {
                  canceled = true;
                  release?.();
                },
                { once: true },
              );
              await resources.operation(
                "write after cancellation",
                async () => {
                  await gate;
                  assert.equal(canceled, true);
                  written = true;
                },
              );
            },
          },
        ],
        { reporter: TimeoutReporter, timeoutMs: 20 },
      ),
      /extension host tests failed/,
    );
  } finally {
    if (fallback) clearImmediate(fallback);
  }
  assert.equal(canceled, true);
  assert.equal(written, true);
  assert.equal(restored, true);
});

test("a Mocha timeout reaches a nested cohort before its body settles and still joins restoration", async () => {
  let nested: TestResources | undefined;
  let releaseWork: (() => void) | undefined;
  let releaseCleanup: (() => void) | undefined;
  const work = new Promise<void>((resolve) => {
    releaseWork = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let fallback: NodeJS.Immediate | undefined;
  let canceledBeforeFallback = false,
    restored = false;
  class TimeoutReporter extends Mocha.reporters.Base {
    constructor(runner: Mocha.Runner) {
      super(runner);
      runner.on("fail", () => {
        fallback = setImmediate(() => {
          canceledBeforeFallback = nested?.signal.aborted ?? false;
          releaseWork?.();
          releaseCleanup?.();
        });
      });
    }
  }
  try {
    await assert.rejects(
      runHostSuite(
        "component",
        async () => {},
        [
          {
            name: "nested cohort",
            async exercise(outer) {
              await withTestResources(
                { cleanupTimeoutMs: 1000, operationSignal: outer.signal },
                async (inner) => {
                  nested = inner;
                  inner.defer("join nested restoration", async (signal) => {
                    assert.equal(signal.aborted, false);
                    await cleanup;
                    restored = true;
                  });
                  await inner.operation("nested work", async (signal) => {
                    signal.addEventListener("abort", () => releaseWork?.(), {
                      once: true,
                    });
                    await work;
                  });
                },
              );
            },
          },
        ],
        { reporter: TimeoutReporter, timeoutMs: 20 },
      ),
      /extension host tests failed/,
    );
  } finally {
    if (fallback) clearImmediate(fallback);
  }
  assert.equal(canceledBeforeFallback, true);
  assert.equal(restored, true);
});
