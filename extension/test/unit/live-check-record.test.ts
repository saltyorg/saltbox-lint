import assert from "node:assert/strict";
import { test } from "node:test";
import {
  liveCheckpointNames,
  quantile,
  primaryRequests,
  validateLiveCheckRecord,
  type LiveCheckRecord,
} from "../host/live-check-record.ts";

test("unrelated marker refreshes cannot be attributed to a template typing request", () => {
  const before = [{ primary: "declared-template" }];
  const after = [
    ...before,
    ...Array.from({ length: 8 }, () => ({ primary: "other-primary" })),
  ];
  assert.equal(
    after.length - before.length,
    8,
    "old global count includes unrelated work",
  );
  assert.equal(
    primaryRequests(after, "declared-template").length -
      primaryRequests(before, "declared-template").length,
    0,
  );
  assert.equal(
    primaryRequests(
      [...after, { primary: "declared-template" }],
      "declared-template",
    ).length - primaryRequests(before, "declared-template").length,
    1,
    "a real template invocation still fails exclusion",
  );
});

function record(): LiveCheckRecord {
  const samples = Array.from({ length: 20 }, (_, index) => ({
    requestLatencyMs: 300 + index,
    acceptedLatencyMs: 400 + index,
  }));
  return {
    schemaVersion: 1,
    target: "linux-x64",
    expectedVersion: "1.100.0",
    actualVersion: "1.100.0",
    mode: "normal",
    boundary: "installed-cli-spawn-and-close",
    bounds: { debounceMs: 300, maxDocuments: 32 },
    fixtures: (["small", "context-heavy"] as const).map((kind) => ({
      kind,
      primaryBytes: 100,
      contextBytes: kind === "small" ? 0 : 10000,
      samples: structuredClone(samples),
      requestMedianMs: 309,
      requestP95Ms: 318,
      acceptedMedianMs: 409,
      acceptedP95Ms: 418,
    })),
    sustained: {
      edits: 20,
      elapsedMs: 1000,
      launches: 1,
      launchesPerSecond: 1,
    },
    defaultOff: { typingLaunches: 0, saveLaunches: 1 },
    cancellation: {
      supersededCloseMs: 10,
      manualCloseMs: 10,
      saveCloseMs: 10,
      settingOffCloseMs: 10,
      markerRemovalCloseMs: 10,
      deactivateCloseMs: 10,
    },
    checkpoints: liveCheckpointNames.map((name, index) => ({
      name,
      launches: (index + 1) * 5,
      closes: (index + 1) * 5,
      active: 0,
    })),
    preservation: { diskSourcesUnchanged: true, bufferUnchanged: true },
    assertions: {
      actualInstalled: true,
      latestUnicodeCRLF: true,
      burstCoalesced: true,
      manualPriority: true,
      savePriority: true,
      templateExcluded: true,
    },
  };
}
test("complete installed qualification recomputes nearest-rank median and p95", () => {
  validateLiveCheckRecord(record());
  assert.equal(
    quantile(
      Array.from({ length: 20 }, (_, index) => index + 1),
      0.5,
    ),
    10,
  );
  assert.equal(
    quantile(
      Array.from({ length: 20 }, (_, index) => index + 1),
      0.95,
    ),
    19,
  );
});
for (const mutation of [
  (value: LiveCheckRecord) => {
    value.fixtures = [];
  },
  (value: LiveCheckRecord) => {
    value.fixtures[0].samples = [];
  },
  (value: LiveCheckRecord) => {
    value.fixtures[0].samples[0].requestLatencyMs = NaN;
  },
  (value: LiveCheckRecord) => {
    value.fixtures[0].samples[0].acceptedLatencyMs = Infinity;
  },
  (value: LiveCheckRecord) => {
    value.fixtures[0].acceptedP95Ms = 0;
  },
  (value: LiveCheckRecord) => {
    Reflect.deleteProperty(value, "cancellation");
  },
  (value: LiveCheckRecord) => {
    value.checkpoints.pop();
  },
  (value: LiveCheckRecord) => {
    value.checkpoints[0].active = 1;
  },
  (value: LiveCheckRecord) => {
    value.checkpoints[0].closes--;
  },
  (value: LiveCheckRecord) => {
    value.actualVersion = "1.137.0";
  },
  (value: LiveCheckRecord) => {
    value.sustained.launches++;
  },
  (value: LiveCheckRecord) => {
    value.preservation.bufferUnchanged = false;
  },
]) {
  test("partial, unavailable or inconsistent live qualification cannot emit success", () => {
    const value = record();
    mutation(value);
    assert.throws(() => validateLiveCheckRecord(value));
  });
}
