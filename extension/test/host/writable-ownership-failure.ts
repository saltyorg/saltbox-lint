type Mode = "canonical" | "lint-fixes" | "fixAll";

interface WritableOwnershipFailure {
  control: `${Mode}:stable` | `${Mode}:retarget`;
  completed: number;
  settled: boolean;
  acceptedReady: boolean;
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
