import assert from "node:assert/strict";

export function primaryRequests<T extends { primary?: string }>(
  requests: readonly T[],
  filename: string,
): T[] {
  return requests.filter((request) => request.primary === filename);
}

export interface LiveFixture {
  kind: "small" | "context-heavy";
  primaryBytes: number;
  contextBytes: number;
  samples: { requestLatencyMs: number; acceptedLatencyMs: number }[];
  requestMedianMs: number;
  requestP95Ms: number;
  acceptedMedianMs: number;
  acceptedP95Ms: number;
}
export const liveCheckpointNames = [
  "baseline",
  "default-off-save",
  "idle",
  "sustained",
  "superseded",
  "manual",
  "save",
  "setting-off",
  "marker-removed",
  "marker-restored",
  "template-baseline",
  "before-deactivate",
  "deactivated",
] as const;
export interface LiveCheckRecord {
  schemaVersion: 1;
  target: string;
  expectedVersion: string;
  actualVersion: string;
  mode: "normal";
  boundary: "installed-cli-spawn-and-close";
  bounds: { debounceMs: 300; maxDocuments: 32 };
  fixtures: LiveFixture[];
  sustained: {
    edits: number;
    elapsedMs: number;
    launches: number;
    launchesPerSecond: number;
  };
  defaultOff: { typingLaunches: 0; saveLaunches: 1 };
  cancellation: {
    supersededCloseMs: number;
    manualCloseMs: number;
    saveCloseMs: number;
    settingOffCloseMs: number;
    markerRemovalCloseMs: number;
    deactivateCloseMs: number;
  };
  checkpoints: {
    name: string;
    launches: number;
    closes: number;
    active: number;
  }[];
  preservation: { diskSourcesUnchanged: true; bufferUnchanged: boolean };
  assertions: {
    actualInstalled: true;
    latestUnicodeCRLF: true;
    burstCoalesced: true;
    manualPriority: true;
    savePriority: true;
    templateExcluded: true;
  };
}
export function quantile(values: number[], q: number): number {
  assert.ok(values.length > 0 && values.length <= 20);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
}
export function validateLiveCheckRecord(record: LiveCheckRecord): void {
  assert.equal(record.schemaVersion, 1);
  assert.match(record.target, /^(linux|darwin|win32)-(x64|arm64)$/);
  assert.ok(["1.100.0", "1.137.0"].includes(record.expectedVersion));
  assert.equal(record.actualVersion, record.expectedVersion);
  assert.equal(record.mode, "normal");
  assert.equal(record.boundary, "installed-cli-spawn-and-close");
  assert.deepEqual(record.bounds, { debounceMs: 300, maxDocuments: 32 });
  assert.deepEqual(
    record.fixtures.map((fixture) => fixture.kind),
    ["small", "context-heavy"],
  );
  for (const fixture of record.fixtures) {
    assert.ok(
      Number.isSafeInteger(fixture.primaryBytes) && fixture.primaryBytes > 0,
    );
    assert.ok(
      Number.isSafeInteger(fixture.contextBytes) && fixture.contextBytes >= 0,
    );
    assert.equal(fixture.samples.length, 20);
    const requests = fixture.samples.map((sample) => sample.requestLatencyMs);
    const accepted = fixture.samples.map((sample) => sample.acceptedLatencyMs);
    assert.equal(fixture.requestMedianMs, quantile(requests, 0.5));
    assert.equal(fixture.requestP95Ms, quantile(requests, 0.95));
    assert.equal(fixture.acceptedMedianMs, quantile(accepted, 0.5));
    assert.equal(fixture.acceptedP95Ms, quantile(accepted, 0.95));
    assert.ok(
      fixture.samples.every(
        (sample) => sample.acceptedLatencyMs >= sample.requestLatencyMs,
      ),
    );
  }
  assert.ok(record.fixtures[1].contextBytes > record.fixtures[0].contextBytes);
  assert.equal(record.sustained.edits, 20);
  assert.equal(record.sustained.launches, 1);
  assert.ok(
    Number.isFinite(record.sustained.elapsedMs) &&
      record.sustained.elapsedMs > 0,
  );
  assert.equal(
    record.sustained.launchesPerSecond,
    1000 / record.sustained.elapsedMs,
  );
  assert.deepEqual(record.defaultOff, { typingLaunches: 0, saveLaunches: 1 });
  assert.deepEqual(
    Object.keys(record.cancellation).sort(),
    [
      "supersededCloseMs",
      "manualCloseMs",
      "saveCloseMs",
      "settingOffCloseMs",
      "markerRemovalCloseMs",
      "deactivateCloseMs",
    ].sort(),
  );
  assert.ok(
    Object.values(record.cancellation).every(
      (value) => Number.isFinite(value) && value >= 0 && value < 15000,
    ),
  );
  assert.deepEqual(
    record.checkpoints.map((checkpoint) => checkpoint.name),
    [...liveCheckpointNames],
  );
  let previous = 0;
  for (const checkpoint of record.checkpoints) {
    assert.ok(
      Number.isSafeInteger(checkpoint.launches) &&
        checkpoint.launches >= previous,
    );
    assert.equal(checkpoint.closes, checkpoint.launches);
    assert.equal(checkpoint.active, 0);
    previous = checkpoint.launches;
  }
  assert.ok(previous > 40 && previous <= 256);
  assert.deepEqual(record.preservation, {
    diskSourcesUnchanged: true,
    bufferUnchanged: true,
  });
  assert.deepEqual(record.assertions, {
    actualInstalled: true,
    latestUnicodeCRLF: true,
    burstCoalesced: true,
    manualPriority: true,
    savePriority: true,
    templateExcluded: true,
  });
}
