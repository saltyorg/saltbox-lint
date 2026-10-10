// Fixed test-only labels. No value is derived from a source, editor or child.
export const liveControlNames = [
  "superseded",
  "manual",
  "save",
  "setting-off",
  "marker-removal",
  "deactivate",
] as const;
export type LiveControlName = (typeof liveControlNames)[number];
export const liveControlStages = [
  "unknown",
  "waiting-for-launch",
  "action-pending",
  "waiting-for-close",
  "close-completed",
] as const;
export type LiveControlStage = (typeof liveControlStages)[number];
export const liveOperationNames = [
  "default-off-edit",
  "default-off-save",
  "enable-setting",
  "small-sample-edit",
  "context-heavy-sample-edit",
  "sustained-edit",
  "control-launch-edit",
  "superseded-edit",
  "manual-restored-edit",
  "save-preparation-edit",
  "save-restored-edit",
  "template-edit",
  "restored-edit",
  "superseded",
  "manual",
  "save",
  "setting-off",
  "marker-removal",
  "deactivate",
  "cleanup-deactivate",
] as const;
export type LiveOperationName = (typeof liveOperationNames)[number];
export type LiveOperationEvent = "entered" | "completed" | "deadline";
export const liveControlEvidenceLimit = 8192;
export const liveOperationCountLimit = 64;

// These describe held spawn/close observations, not descendant or action state.
export const liveCloseObservations = ["observed", "unknown"] as const;
export type LiveCloseObservation = (typeof liveCloseObservations)[number];
export const liveInvocationCountLimit = 256;
export const livePendingInvocationLimit = 16;
export const livePrimaryCategories = [
  "small",
  "context-heavy",
  "unknown",
] as const;
export type LivePrimaryCategory = (typeof livePrimaryCategories)[number];
