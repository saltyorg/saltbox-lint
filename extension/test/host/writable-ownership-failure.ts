import {
  writableStages as stages,
  writableGuards as guards,
  type WritableStage,
  type WritableGuard,
} from "../../src/writable-trace.ts";

type Mode = "canonical" | "lint-fixes" | "fixAll";

interface PublicPreconditions {
  stage: "fixAll:call";
  documentURIEqual: boolean;
  bufferUTF8BytesEqual: boolean;
  documentClosed: boolean;
  documentDirty: boolean;
}

// Read only the public document already held at the existing Fix All call.
// Failed evidence collection must neither block nor change that call.
export function captureWritableOwnershipPreconditions(
  document: {
    readonly uri: { toString(): string };
    getText(): string;
    readonly isClosed: boolean;
    readonly isDirty: boolean;
  },
  requestedURI: { toString(): string },
  intendedBytes: Buffer,
): PublicPreconditions | undefined {
  try {
    const text = document.getText();
    return {
      stage: "fixAll:call",
      documentURIEqual: document.uri.toString() === requestedURI.toString(),
      bufferUTF8BytesEqual: Buffer.from(text, "utf8").equals(intendedBytes),
      documentClosed: document.isClosed,
      documentDirty: document.isDirty,
    };
  } catch {
    return undefined;
  }
}

type StageRecord = { stage: WritableStage; guard?: WritableGuard };
export function collectWritableOwnershipStages() {
  const records: StageRecord[] = [];
  return {
    collect(stage: WritableStage, guard?: WritableGuard) {
      try {
        if (
          records.length >= 24 ||
          !stages.includes(stage) ||
          (guard !== undefined && !guards.includes(guard))
        )
          return;
        records.push(guard === undefined ? { stage } : { stage, guard });
      } catch {
        // A failed collector leaves the invocation unchanged.
      }
    },
    records,
  };
}
function stageRecords(records?: StageRecord[]) {
  try {
    if (!Array.isArray(records)) return "unknown";
    return records
      .slice(0, 24)
      .flatMap(({ stage, guard }) =>
        stages.includes(stage) &&
        (guard === undefined || guards.includes(guard))
          ? [guard === undefined ? { stage } : { stage, guard }]
          : [],
      );
  } catch {
    return "unknown";
  }
}

interface WritableOwnershipFailure {
  control: `${Mode}:stable` | `${Mode}:retarget`;
  completed: number;
  settled: boolean;
  acceptedReady: boolean;
  publicPreconditions?: PublicPreconditions;
  stages?: StageRecord[];
}

function preconditionRecord(state: WritableOwnershipFailure) {
  const unknown = {
    precondition_stage: "unknown",
    document_uri_equal: "unknown",
    buffer_utf8_bytes_equal: "unknown",
    document_closed: "unknown",
    document_dirty: "unknown",
  };
  try {
    const captured = state.publicPreconditions;
    if (
      !state.control.startsWith("fixAll:") ||
      captured?.stage !== "fixAll:call"
    )
      return unknown;
    const boolean = (value: boolean) =>
      typeof value === "boolean" ? value : "unknown";
    return {
      precondition_stage: "fixAll:call",
      document_uri_equal: boolean(captured.documentURIEqual),
      buffer_utf8_bytes_equal: boolean(captured.bufferUTF8BytesEqual),
      document_closed: boolean(captured.documentClosed),
      document_dirty: boolean(captured.documentDirty),
    };
  } catch {
    return unknown;
  }
}

// The host promise exposes edits/void, not complete child stdout. Do not infer
// child completion or formatter contract results from readiness or settlement.
export function reportWritableOwnershipFailure(
  error: unknown,
  state: WritableOwnershipFailure,
  write: (record: string) => void = console.error,
): never {
  try {
    write(
      "WRITABLE_OWNERSHIP_FAILURE " +
        JSON.stringify({
          control: state.control,
          completed_controls: state.completed,
          expected_controls: 6,
          pending_settled: state.settled,
          accepted_ready: state.acceptedReady,
          ...preconditionRecord(state),
          invocation_stages: stageRecords(state.stages),
          child_completion: "unknown",
          response_contract_valid: "unknown",
          response_schema_equal: "unknown",
          response_path_equal: "unknown",
          response_source_hash_equal: "unknown",
          response_ready: "unknown",
          response_unchanged: "unknown",
          response_skipped: "unknown",
          response_has_edits: "unknown",
        }),
    );
  } catch {
    // Evidence output must preserve the original assertion or operation error.
  }
  throw error;
}
