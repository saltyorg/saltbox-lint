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
test("independent live-checking evidence retains every original sample and control", () => {
  const value = { ...record(), mode: "live-checking" as const };
  validateLiveCheckRecord(value);
  value.fixtures[1].samples.pop();
  assert.throws(() => validateLiveCheckRecord(value));
});

test("component performance evidence preserves workloads and cannot claim installed event ownership", () => {
  const value = record();
  value.mode = "live-performance";
  value.boundary = "component-cli-runner-spawn-and-close";
  delete value.assertions.actualInstalled;
  value.assertions.actualInstalledBackend = true;
  for (const checkpoint of value.checkpoints)
    checkpoint.requests = {
      admitted: checkpoint.launches + 1,
      settled: checkpoint.launches + 1,
      cancelledBeforeSpawn: 1,
    };
  validateLiveCheckRecord(value);
  value.assertions.actualInstalled = true;
  assert.throws(() => validateLiveCheckRecord(value));
  delete value.assertions.actualInstalled;
  value.boundary = "installed-cli-spawn-and-close";
  assert.throws(() => validateLiveCheckRecord(value));
});

for (const mutation of [
  (value: LiveCheckRecord) => {
    delete value.checkpoints[0].requests;
  },
  (value: LiveCheckRecord) => {
    Reflect.set(value.checkpoints[0], "requests", undefined);
  },
  (value: LiveCheckRecord) => {
    Reflect.set(value.checkpoints[0], "requests", null);
  },
  (value: LiveCheckRecord) => {
    value.checkpoints[0].requests!.settled--;
  },
  (value: LiveCheckRecord) => {
    value.checkpoints[0].requests!.cancelledBeforeSpawn++;
  },
  (value: LiveCheckRecord) => {
    value.checkpoints[0].requests!.admitted = NaN;
  },
  (value: LiveCheckRecord) => {
    Object.assign(value.checkpoints[0].requests!, { ignoredRequests: 1 });
  },
  (value: LiveCheckRecord) => {
    Object.assign(value.checkpoints[0], { ignoredNativeCloses: 1 });
  },
  (value: LiveCheckRecord) => {
    value.checkpoints[1].requests = {
      admitted: value.checkpoints[1].launches,
      settled: value.checkpoints[1].launches,
      cancelledBeforeSpawn: 0,
    };
  },
]) {
  test("component checkpoints reject missing, pending or unaccounted request admission", () => {
    const value = record();
    value.mode = "live-performance";
    value.boundary = "component-cli-runner-spawn-and-close";
    delete value.assertions.actualInstalled;
    value.assertions.actualInstalledBackend = true;
    for (const checkpoint of value.checkpoints)
      checkpoint.requests = {
        admitted: checkpoint.launches + 1,
        settled: checkpoint.launches + 1,
        cancelledBeforeSpawn: 1,
      };
    validateLiveCheckRecord(value);
    mutation(value);
    assert.throws(() => validateLiveCheckRecord(value));
  });
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
