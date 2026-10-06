type Control = "manual_impact_failure" | "manual_marker_refresh";
type ControlStage = "unknown" | "started" | "returned" | "failed";
type RestorationStage = "unknown" | "held" | "write_started" | "write_returned";
type Equality = boolean | "unknown";

function safe(operation: () => void) {
  try {
    operation();
  } catch {
    // Evidence cannot replace a control's result or its original failure.
  }
}

/** References only buffers already held by this invocation's test controls. */
export function navigationEqualityProjection(original?: Buffer) {
  let restoration: Buffer | undefined;
  let active: Control | undefined;
  const controls: Record<Control, ControlStage> = {
    manual_impact_failure: "unknown",
    manual_marker_refresh: "unknown",
  };
  let restorationStage: RestorationStage = "unknown";
  let restorationMatchesOriginal: Equality = "unknown";
  let clean: Equality = "unknown";
  let diskMatchesOriginal: Equality = "unknown";
  let diskMatchesRestoration: Equality = "unknown";
  const facts = {
    controlStarted(control: Control) {
      if (
        control !== "manual_impact_failure" &&
        control !== "manual_marker_refresh"
      )
        return;
      active = control;
      controls[control] = "started";
    },
    controlReturned(control: Control) {
      if (
        control !== "manual_impact_failure" &&
        control !== "manual_marker_refresh"
      )
        return;
      controls[control] = "returned";
      active = undefined;
    },
    restorationHeld(bytes: Buffer) {
      restoration = bytes;
      restorationStage = "held";
      safe(() => {
        if (original) restorationMatchesOriginal = bytes.equals(original);
      });
    },
    restorationWriteStarted() {
      restorationStage = "write_started";
    },
    restorationWriteReturned() {
      restorationStage = "write_returned";
    },
    cleanObserved(value: boolean) {
      if (typeof value === "boolean") clean = value;
    },
    diskObserved(bytes: Buffer, matchesOriginal: boolean) {
      if (original && typeof matchesOriginal === "boolean")
        diskMatchesOriginal = matchesOriginal;
      safe(() => {
        if (restoration) diskMatchesRestoration = bytes.equals(restoration);
      });
    },
    snapshot() {
      return {
        fixture: "navtarget_defaults",
        manual_impact_failure: controls.manual_impact_failure,
        manual_marker_refresh: controls.manual_marker_refresh,
        restoration_stage: restorationStage,
        restoration_matches_original: restorationMatchesOriginal,
        target_buffer_clean: clean,
        disk_matches_original: diskMatchesOriginal,
        disk_matches_restoration: diskMatchesRestoration,
      };
    },
    rethrow(
      error: unknown,
      write: (message: string) => void = console.error,
    ): never {
      if (active) controls[active] = "failed";
      safe(() => {
        const snapshot = facts.snapshot();
        const equality = (value: unknown): Equality =>
          typeof value === "boolean" ? value : "unknown";
        const controlStage = (value: unknown) =>
          ["started", "returned", "failed"].find((stage) => stage === value) ??
          "unknown";
        const evidence = {
          fixture: "navtarget_defaults",
          manual_impact_failure: controlStage(snapshot.manual_impact_failure),
          manual_marker_refresh: controlStage(snapshot.manual_marker_refresh),
          restoration_stage:
            ["held", "write_started", "write_returned"].find(
              (stage) => stage === snapshot.restoration_stage,
            ) ?? "unknown",
          restoration_matches_original: equality(
            snapshot.restoration_matches_original,
          ),
          target_buffer_clean: equality(snapshot.target_buffer_clean),
          disk_matches_original: equality(snapshot.disk_matches_original),
          disk_matches_restoration: equality(snapshot.disk_matches_restoration),
        };
        const message = "NAVIGATION_EQUALITY " + JSON.stringify(evidence);
        if (Buffer.byteLength(message, "utf8") <= 1024) write(message);
      });
      throw error;
    },
    dispose() {
      original = undefined;
      restoration = undefined;
    },
  };
  return facts;
}
