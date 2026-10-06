// Fixed labels for an optional invocation-owned rejection observer. No error,
// exit value, source content or process identity is exposed.
export const processFailureCategories = [
  "setup",
  "spawn",
  "stdin",
  "termination",
  "cancelled",
  "timeout",
  "output-limit",
  "stderr",
  "exit-status",
  "utf8",
] as const;
export type ProcessFailureCategory = (typeof processFailureCategories)[number];
export type ProcessFailureObserver = (category: ProcessFailureCategory) => void;
