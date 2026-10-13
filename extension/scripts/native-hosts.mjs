// @ts-check
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { randomUUID } from "node:crypto";
import { linkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { manifest } from "./release-inputs.mjs";
import { extensionDirectory, runHostProfile } from "./host-launcher.mjs";
import { hostModes, hostVersions } from "./host-matrix.mjs";

export { hostModes, hostVersions } from "./host-matrix.mjs";

/** @typedef {"not_run" | "running" | "passed" | "failed"} ProfileStatus */
/** @typedef {{version: string, mode: string, status: ProfileStatus}} ProfileResult */
/** @typedef {{stage: "download" | "profile", version: string, mode?: string}} MatrixFailure */
/** @typedef {{schemaVersion: 1, target: string, commit: string, runId: string, attempt: string, versions: readonly string[], modes: readonly string[], profiles: ProfileResult[], status: "running" | "passed" | "failed", failure?: MatrixFailure}} HostResults */
/** @typedef {{write: typeof writeFileSync, link: typeof linkSync, rename: typeof renameSync, remove: typeof rmSync}} ResultsIO */

const resultsIO = Object.freeze({
  write: writeFileSync,
  link: linkSync,
  rename: renameSync,
  remove: rmSync,
});

/** @param {string | undefined} filename @param {ResultsIO} io */
function resultRecorder(filename, io) {
  let published = false;
  /** @param {HostResults} result */
  return (result) => {
    if (filename === undefined) return;
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let created = false;
    let failed = false;
    /** @type {unknown} */
    let failure;
    try {
      // Exclusive creation and publication preserve another writer's file.
      created = true;
      try {
        io.write(temporary, JSON.stringify(result) + "\n", {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        // EEXIST from exclusive creation belongs to another writer.
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        )
          created = false;
        throw error;
      }
      if (published) io.rename(temporary, filename);
      else io.link(temporary, filename);
      published = true;
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (created) {
      try {
        io.remove(temporary, { force: true });
      } catch (error) {
        failure = failed
          ? new AggregateError(
              [failure, error],
              "Editor result reporting and temporary cleanup failed",
              { cause: failure },
            )
          : error;
        failed = true;
      }
    }
    if (failed) throw failure;
  };
}

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
 * @param {{env?: NodeJS.ProcessEnv, directory?: string, platform?: string, arch?: string, packageVersion?: string, versions?: readonly string[], modes?: readonly string[], resultsFile?: string}} [configuration]
 * @param {import('./host-types.js').HostProfileDependencies & {download?: (version: string) => Promise<string>, profile?: typeof runHostProfile, resultsIO?: ResultsIO}} [dependencies]
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
    resultsFile,
  } = {},
  {
    download = downloadAndUnzipVSCode,
    profile = runHostProfile,
    resultsIO: io = resultsIO,
    ...dependencies
  } = {},
) {
  const target = `${platform}-${arch}`;
  const vsix = resolve(
    directory,
    `../dist/saltbox-lint-${packageVersion}-${target}.vsix`,
  );
  /** @type {HostResults} */
  const result = {
    schemaVersion: 1,
    target,
    commit: env.GITHUB_SHA ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    attempt: env.GITHUB_RUN_ATTEMPT ?? "",
    status: "running",
    versions: [...versions],
    modes: [...modes],
    profiles: versions.flatMap((version) =>
      modes.map((mode) => ({ version, mode, status: "not_run" })),
    ),
  };
  const record = resultRecorder(resultsFile, io);
  /** @param {unknown} primary @param {MatrixFailure} failure @returns {never} */
  const recordFailure = (primary, failure) => {
    result.status = "failed";
    result.failure = failure;
    try {
      record(result);
    } catch (reporting) {
      throw new AggregateError(
        [primary, reporting],
        "Editor acceptance and result reporting failed",
        { cause: primary },
      );
    }
    throw primary;
  };
  record(result);
  let index = 0;
  for (const version of versions) {
    let executable;
    try {
      executable = await download(version);
    } catch (error) {
      recordFailure(error, { stage: "download", version });
    }
    for (const mode of modes) {
      const entry = result.profiles[index++];
      entry.status = "running";
      record(result);
      try {
        await profile(
          {
            directory,
            env: profileEnvironment(env, { version, mode, executable, vsix }),
          },
          dependencies,
        );
      } catch (error) {
        entry.status = "failed";
        recordFailure(error, { stage: "profile", version, mode });
      }
      entry.status = "passed";
      record(result);
    }
  }
  result.status = "passed";
  record(result);
}
