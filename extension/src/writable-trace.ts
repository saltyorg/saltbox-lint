// Fixed labels for the optional test-owned invocation callback. Guard labels
// identify existing decline branches and carry no source or response values.
export const writableStages = [
  "root-refresh-returned",
  "snapshot-present",
  "snapshot-declined",
  "submission-entered",
  "submission-refused",
  "operation-returned",
  "operation-failed",
  "operation-cancelled",
  "parser-accepted",
  "parser-failed",
  "final-authority-accepted",
  "final-authority-declined",
] as const;
export const writableGuards = [
  "fixall-document",
  "fixall-folder",
  "format-preflight",
  "snapshot-admission",
  "disk-utf8",
  "before-submission",
  "after-submission",
  "format-result-authority",
  "format-return-authority",
  "fixall-result",
  "fixall-write-authority",
] as const;
export type WritableStage = (typeof writableStages)[number];
export type WritableGuard = (typeof writableGuards)[number];
