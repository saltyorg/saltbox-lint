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
  "save-preparation-edit",
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
