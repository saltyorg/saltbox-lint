import { cleanupLiveControls } from "../support/live-controls.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

for (const failure of [
  "none",
  "deactivate",
  "join",
  "restore",
  "unsubscribe",
] as const) {
  test(`actual live host restores observer and releases listener after ${failure}`, async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const original = new Error("owned cleanup failure");
    const control = (name: string) => {
      calls.push(name);
      if (name === failure) throw original;
    };
    errors.push(
      ...(await cleanupLiveControls({
        stopLaunch() {},
        deactivate: async () => control("deactivate"),
        join: async () => control("join"),
        restore: () => control("restore"),
        unsubscribe: () => control("unsubscribe"),
      })),
    );
    assert.ok(calls.includes("restore"));
    assert.ok(calls.includes("unsubscribe"));
    assert.deepEqual(errors, failure === "none" ? [] : [original]);
  });
}
