import assert from "node:assert/strict";
import {
  liveControlNames,
  liveControlStages,
  liveOperationNames,
  liveControlEvidenceLimit,
  liveOperationCountLimit,
  liveCloseObservations,
  liveInvocationCountLimit,
  type LiveCloseObservation,
  type LiveControlName,
  type LiveControlStage,
  type LiveOperationName,
  type LiveOperationEvent,
} from "./live-control-vocabulary.ts";

interface OperationCount {
  entered: number;
  completed: number;
}
export interface LiveControlEvidence {
  operations: OperationCount[];
  controls: LiveControlStage[];
  deadline: LiveOperationName | "unknown";
  overflow: boolean;
}
interface CompletedCounts {
  fixtures: number;
  checkpoints: number;
}
interface InvocationCounts {
  launches: number;
  closes: number;
  pendingCloses: number;
  controls: { control: LiveControlName; close: LiveCloseObservation }[];
}
interface HeldInvocation {
  closed?: number;
}

// Uses only invocations retained by the existing launch and close callbacks.
// Unknown close is never a claim about cancellation or command completion.
export function captureLiveInvocationFailure(
  invocations: readonly HeldInvocation[],
  controlled: ReadonlyMap<LiveControlName, HeldInvocation>,
  overflow: boolean,
): InvocationCounts | "unknown" {
  try {
    if (overflow || invocations.length > liveInvocationCountLimit)
      return "unknown";
    const closes = invocations.filter(
      (item) => item.closed !== undefined,
    ).length;
    return {
      launches: invocations.length,
      closes,
      pendingCloses: invocations.length - closes,
      controls: liveControlNames.map((control) => ({
        control,
        close:
          controlled.get(control)?.closed === undefined
            ? "unknown"
            : "observed",
      })),
    };
  } catch {
    return "unknown";
  }
}

interface LiveControlFailureRecord {
  schemaVersion: 1;
  boundary: "existing-live-control-hooks";
  deadline: LiveOperationName | "unknown";
  operations: {
    operation: LiveOperationName;
    entered: number;
    completed: number;
    completion: "observed" | "unknown";
  }[];
  controls: { control: LiveControlName; stage: LiveControlStage }[];
  completed: CompletedCounts;
  invocations: InvocationCounts | "unknown";
}
export function createLiveControlEvidence(): LiveControlEvidence | undefined {
  try {
    return {
      operations: liveOperationNames.map(() => ({ entered: 0, completed: 0 })),
      controls: liveControlNames.map(() => "unknown"),
      deadline: "unknown",
      overflow: false,
    };
  } catch {
    return undefined;
  }
}

// Observation is synchronous, bounded and best effort. It never settles an
// operation, attaches a callback, or changes the original error.
export function noteLiveOperation(
  evidence: LiveControlEvidence | undefined,
  operation: LiveOperationName,
  event: LiveOperationEvent,
): void {
  try {
    if (!evidence) return;
    const count = evidence.operations[liveOperationNames.indexOf(operation)];
    if (event === "deadline") evidence.deadline = operation;
    else if (count[event] < liveOperationCountLimit) count[event]++;
    else evidence.overflow = true;
  } catch {
    // A failed collector cannot alter the control being observed.
  }
}
export function noteLiveControlStage(
  evidence: LiveControlEvidence | undefined,
  control: LiveControlName,
  stage: LiveControlStage,
): void {
  try {
    if (evidence) evidence.controls[liveControlNames.indexOf(control)] = stage;
  } catch {
    // A failed collector cannot alter the control being observed.
  }
}

export function validateLiveControlFailureRecord(
  value: unknown,
): asserts value is LiveControlFailureRecord {
  assert.ok(value && typeof value === "object");
  const record = value as LiveControlFailureRecord;
  assert.deepEqual(Object.keys(record).sort(), [
    "boundary",
    "completed",
    "controls",
    "deadline",
    "invocations",
    "operations",
    "schemaVersion",
  ]);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.boundary, "existing-live-control-hooks");
  assert.ok(
    record.deadline === "unknown" ||
      liveOperationNames.includes(record.deadline),
  );
  assert.deepEqual(
    record.operations.map((item) => item.operation),
    [...liveOperationNames],
  );
  for (const item of record.operations) {
    assert.deepEqual(Object.keys(item).sort(), [
      "completed",
      "completion",
      "entered",
      "operation",
    ]);
    assert.ok(
      Number.isSafeInteger(item.entered) &&
        item.entered >= 0 &&
        item.entered <= liveOperationCountLimit,
    );
    assert.ok(
      Number.isSafeInteger(item.completed) &&
        item.completed >= 0 &&
        item.completed <= item.entered,
    );
    assert.equal(
      item.completion,
      item.entered > 0 && item.completed === item.entered
        ? "observed"
        : "unknown",
    );
  }
  assert.deepEqual(
    record.controls.map((item) => item.control),
    [...liveControlNames],
  );
  for (const item of record.controls) {
    assert.deepEqual(Object.keys(item).sort(), ["control", "stage"]);
    assert.ok(liveControlStages.includes(item.stage));
  }
  if (record.invocations !== "unknown") {
    const counts = record.invocations;
    assert.ok(counts && typeof counts === "object");
    assert.deepEqual(Object.keys(counts).sort(), [
      "closes",
      "controls",
      "launches",
      "pendingCloses",
    ]);
    for (const count of [counts.launches, counts.closes, counts.pendingCloses])
      assert.ok(
        Number.isSafeInteger(count) &&
          count >= 0 &&
          count <= liveInvocationCountLimit,
      );
    assert.equal(counts.closes + counts.pendingCloses, counts.launches);
    assert.deepEqual(
      counts.controls.map((item) => item.control),
      [...liveControlNames],
    );
    for (const item of counts.controls) {
      assert.deepEqual(Object.keys(item).sort(), ["close", "control"]);
      assert.ok(liveCloseObservations.includes(item.close));
    }
  }
  assert.deepEqual(Object.keys(record.completed).sort(), [
    "checkpoints",
    "fixtures",
  ]);
  assert.ok(
    Number.isSafeInteger(record.completed.fixtures) &&
      record.completed.fixtures >= 0 &&
      record.completed.fixtures <= 2,
  );
  assert.ok(
    Number.isSafeInteger(record.completed.checkpoints) &&
      record.completed.checkpoints >= 0 &&
      record.completed.checkpoints <= 13,
  );
}

// Called only by the existing primary failure hook. Counters describe observed
// completion; absent completion and unentered controls remain unknown.
export function reportLiveControlFailure(
  evidence: LiveControlEvidence | undefined,
  completed: CompletedCounts,
  write?: (message: string) => void,
  invocations: InvocationCounts | "unknown" = "unknown",
): void {
  try {
    if (!evidence || evidence.overflow) return;
    const record: LiveControlFailureRecord = {
      schemaVersion: 1,
      boundary: "existing-live-control-hooks",
      deadline: evidence.deadline,
      operations: liveOperationNames.map((operation, index) => {
        const { entered, completed } = evidence.operations[index];
        return {
          operation,
          entered,
          completed,
          completion:
            entered > 0 && entered === completed ? "observed" : "unknown",
        };
      }),
      controls: liveControlNames.map((control, index) => ({
        control,
        stage: evidence.controls[index],
      })),
      invocations,
      completed: {
        fixtures: completed.fixtures,
        checkpoints: completed.checkpoints,
      },
    };
    validateLiveControlFailureRecord(record);
    const message = "SALTBOX_LIVE_CONTROL_FAILURE " + JSON.stringify(record);
    if (Buffer.byteLength(message) <= liveControlEvidenceLimit)
      (write ?? console.error)(message);
  } catch {
    // Collection, validation, serialization and logging preserve the failure.
  }
}
