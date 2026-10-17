import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { diagnosticTransition } from "../support/diagnostic-transition.ts";

function fixture() {
  const controller = new AbortController();
  let notify = () => {};
  let expire = () => {};
  let listeners = 0;
  let deadlines = 0;
  let ready = false;
  const options = {
    signal: controller.signal,
    subscribe(observe: () => void) {
      notify = observe;
      listeners++;
      return {
        dispose() {
          listeners--;
        },
      };
    },
    ready: () => ready,
    async trigger() {
      assert.equal(listeners, 1, "observe before triggering");
      ready = true;
      notify();
    },
    scheduleDeadline(callback: () => void) {
      expire = callback;
      deadlines++;
      return () => {
        deadlines--;
      };
    },
  };
  return {
    controller,
    options,
    notify: () => notify(),
    expire: () => expire(),
    released() {
      assert.equal(listeners, 0);
      assert.equal(deadlines, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    },
  };
}

test("diagnostic transition observes readiness and releases every listener and deadline", async () => {
  const f = fixture();
  await diagnosticTransition(f.options);
  f.released();
});

test("diagnostic transition retains trigger and cleanup failures", async () => {
  const f = fixture();
  const trigger = new Error("write failed");
  const cleanup = new Error("listener cleanup failed");
  const subscribe = f.options.subscribe;
  f.options.subscribe = (observe) => {
    const listener = subscribe(observe);
    return {
      dispose() {
        listener.dispose();
        throw cleanup;
      },
    };
  };
  f.options.trigger = async () => {
    throw trigger;
  };
  await assert.rejects(diagnosticTransition(f.options), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [trigger, cleanup]);
    return true;
  });
  f.released();
});

for (const failure of ["cancel", "deadline", "predicate"] as const) {
  test(`diagnostic ${failure} failure joins admitted work before releasing resources`, async () => {
    const f = fixture();
    const original = new Error(failure);
    let release!: () => void;
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.options.trigger = async () => {
      admitted();
      await held;
    };
    let settled = false;
    const running = diagnosticTransition(f.options);
    const result = assert
      .rejects(running, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        if (failure !== "deadline") assert.ok(error.errors.includes(original));
        return true;
      })
      .then(() => {
        settled = true;
      });
    await started;
    if (failure === "cancel") f.controller.abort(original);
    else if (failure === "deadline") f.expire();
    else {
      f.options.ready = () => {
        throw original;
      };
      f.notify();
    }
    await Promise.resolve();
    assert.equal(settled, false, "failure cannot abandon the trigger");
    release();
    await result;
    f.released();
  });
}

test("pre-cancel and failed deadline setup admit no trigger and release acquired listeners", async () => {
  for (const preCancel of [true, false]) {
    const f = fixture();
    const original = new Error("setup failure");
    let invoked = false;
    f.options.trigger = async () => {
      invoked = true;
    };
    if (preCancel) f.controller.abort(original);
    else
      f.options.scheduleDeadline = () => {
        throw original;
      };
    await assert.rejects(diagnosticTransition(f.options));
    assert.equal(invoked, false);
    f.released();
  }
});
