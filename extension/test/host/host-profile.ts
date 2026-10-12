import assert from "node:assert/strict";

export const hostProfileNames = [
  "normal",
  "navigation",
  "templates",
  "help-status",
  "editing",
  "diagnostics",
  "live-checking",
  "live-performance",
  "dependencies",
  "queue",
  "active-project",
  "active-project-cache",
  "save-scope",
  "disabled",
  "markers",
  "profile",
  "qualification",
  "regressions",
  "untrusted",
] as const;
export type HostProfileName = (typeof hostProfileNames)[number];

/** The launcher must identify the profile before any controller work begins. */
export function getHostProfile(
  environment: Readonly<NodeJS.ProcessEnv>,
): HostProfileName {
  const name = environment.SALTBOX_TEST_HOST_MODE;
  assert.ok(
    hostProfileNames.some((profile) => profile === name),
    `Unknown host profile ${JSON.stringify(name)}`,
  );
  return name as HostProfileName;
}
