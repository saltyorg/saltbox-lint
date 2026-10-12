// @ts-check
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { resolve } from "node:path";
import { manifest } from "./release-inputs.mjs";
import { extensionDirectory, runHostProfile } from "./host-launcher.mjs";

export const hostVersions = Object.freeze(["1.100.0", "1.137.0"]);
export const hostModes = Object.freeze([
  "normal",
  "navigation",
  "templates",
  "help-status",
  "editing",
  "diagnostics",
  "live-checking",
  "live-performance",
  "regressions",
  "markers",
  "save-scope",
  "dependencies",
  "queue",
  "active-project",
  "active-project-cache",
  "untrusted",
  "disabled",
]);

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{version: string, mode: string, executable: string, vsix?: string}} profile
 */
export function profileEnvironment(env, { version, mode, executable, vsix }) {
  return {
    ...env,
    VSCODE_EXECUTABLE_PATH: executable,
    SALTBOX_TEST_EXPECTED_VSCODE_VERSION: version,
    SALTBOX_TEST_HOST_MODE: mode,
    SALTBOX_TEST_VSIX: vsix,
    SALTBOX_TEST_REGRESSIONS: mode === "regressions" ? "1" : "0",
    SALTBOX_TEST_MARKERS: mode === "markers" ? "1" : "0",
    SALTBOX_TEST_PROFILE: "0",
    SALTBOX_TEST_QUALIFICATION: "0",
    SALTBOX_TEST_DEPENDENCIES: mode === "dependencies" ? "1" : "0",
    SALTBOX_TEST_QUEUE: mode === "queue" ? "1" : "0",
    SALTBOX_TEST_SAVE_SCOPE: [
      "save-scope",
      "dependencies",
      "queue",
      "active-project-cache",
    ].includes(mode)
      ? "1"
      : "0",
    SALTBOX_TEST_ACTIVE_PROJECT: mode.startsWith("active-project") ? "1" : "0",
    SALTBOX_TEST_UNTRUSTED: mode === "untrusted" ? "1" : "0",
    SALTBOX_TEST_DISABLED: [
      "disabled",
      "live-performance",
      "save-scope",
      "dependencies",
      "queue",
      "active-project-cache",
    ].includes(mode)
      ? "1"
      : "0",
  };
}

/**
 * @param {{env?: NodeJS.ProcessEnv, directory?: string, platform?: string, arch?: string, packageVersion?: string, versions?: readonly string[], modes?: readonly string[]}} [configuration]
 * @param {import('./host-types.js').HostProfileDependencies & {download?: (version: string) => Promise<string>, profile?: typeof runHostProfile}} [dependencies]
 */
export async function runNativeHosts(
  {
    env = process.env,
    directory = extensionDirectory,
    platform = process.platform,
    arch = process.arch,
    packageVersion = manifest.version,
    versions = hostVersions,
    modes = hostModes,
  } = {},
  {
    download = downloadAndUnzipVSCode,
    profile = runHostProfile,
    ...dependencies
  } = {},
) {
  const target = `${platform}-${arch}`;
  const vsix = resolve(
    directory,
    `../dist/saltbox-lint-${packageVersion}-${target}.vsix`,
  );
  for (const version of versions) {
    const executable = await download(version);
    for (const mode of modes) {
      await profile(
        {
          directory,
          env: profileEnvironment(env, { version, mode, executable, vsix }),
        },
        dependencies,
      );
    }
  }
}
