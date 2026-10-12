// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as sdk from "@vscode/test-electron";
import { ownedCommand } from "./owned-command.mjs";
import { hostInputs } from "./host-inputs.mjs";
import { createHostProcessSupervisor } from "./host-process-supervisor.mjs";
import { readVSIX } from "./verify-package.mjs";
import {
  createHostProfile,
  hostProfilePaths,
  populateHostFixture,
  cleanupHostProfile,
} from "./host-fixture.mjs";

export const extensionDirectory = fileURLToPath(
  new URL("../", import.meta.url),
);
export const profileTimeoutMs = 180000;
const cleanupTimeoutMs = 12000;

/** @param {import('./host-types.js').ProfileRecord} record */
function reportDefault(record) {
  console.log("SALTBOX_EDITOR_PROFILE " + JSON.stringify(record));
}

/**
 * @param {{version: string, mode: string}} identity
 * @param {() => number} clock
 * @param {import('./host-types.js').Report} report
 * @returns {{phase: import('./host-types.js').PhaseRecorder, report: import('./host-types.js').Report, clock: () => number | undefined, failures: Error[]}}
 */
function phaseRecorder({ version, mode }, clock, report) {
  /** @type {Error[]} */
  const failures = [];
  const observeClock = () => {
    try {
      const value = clock();
      assert.ok(
        Number.isFinite(value),
        "host clock must return a finite number",
      );
      return value;
    } catch (error) {
      failures.push(new Error("host clock observer failed", { cause: error }));
      return undefined;
    }
  };
  /** @type {import('./host-types.js').Report} */
  const emit = (record) => {
    try {
      report(record);
    } catch (error) {
      failures.push(
        new Error(
          `host report observer failed (${record.phase} ${record.stage})`,
          { cause: error },
        ),
      );
    }
  };
  /** @type {import('./host-types.js').PhaseRecorder} */
  const recordPhase = async (phase, operation) => {
    const started = observeClock();
    emit({ version, mode, phase, stage: "started" });
    const elapsed = () => {
      const ended = observeClock();
      return started === undefined || ended === undefined
        ? undefined
        : ended - started;
    };
    try {
      const value = await operation();
      emit({
        version,
        mode,
        phase,
        stage: "completed",
        elapsedMs: elapsed(),
      });
      return value;
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new Error("host operation failed", { cause: error });
      emit({
        version,
        mode,
        phase,
        stage: "failed",
        elapsedMs: elapsed(),
        error: failure.message,
      });
      throw failure;
    }
  };
  return { phase: recordPhase, report: emit, clock: observeClock, failures };
}

/** @param {unknown} failure @param {readonly Error[]} observers @returns {unknown} */
function withObserverFailures(failure, observers) {
  if (observers.length === 0) return failure;
  const errors =
    failure === undefined ? [...observers] : [failure, ...observers];
  const combined = new AggregateError(
    errors,
    "host operation, cleanup or observers failed",
    { cause: errors[0] },
  );
  if (
    failure instanceof Error &&
    "retainedProfile" in failure &&
    typeof failure.retainedProfile === "string"
  )
    Object.assign(combined, { retainedProfile: failure.retainedProfile });
  return combined;
}

// This adapter never creates a detached group. The profile's external
// ownedCommand supervisor owns it and every installer/editor descendant.
/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('./host-types.js').CommandOptions} options
 * @param {{setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, onFirstFailure?: (error: Error) => void}} [dependencies]
 * @returns {Promise<string>}
 */
export function inheritedCommand(
  command,
  args,
  {
    phase,
    timeoutMs,
    stdio,
    env = process.env,
    cwd = extensionDirectory,
    shell = false,
    maxOutputBytes = 4 * 1024 * 1024,
  },
  {
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onFirstFailure = () => {},
  } = {},
) {
  assert.equal(
    env.SALTBOX_TEST_HOST_WORKER,
    "1",
    "host commands require an external profile owner",
  );
  if (shell) {
    command = `"${command}"`;
    args = args.map((argument) => `"${argument.replaceAll('"', '""')}"`);
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      windowsHide: true,
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    /** @type {Error | undefined} */
    let failure;
    const observeFailure = () => {
      try {
        if (failure) onFirstFailure(failure);
      } catch {
        /* Observation cannot replace the command failure. */
      }
    };
    const deadline = setTimer(() => {
      const first = failure === undefined;
      failure ??= new Error(`${phase}: timed out after ${timeoutMs}ms`);
      if (first) observeFailure();
      child.kill("SIGKILL");
    }, timeoutMs);
    /** @param {string} data @param {'stdout' | 'stderr'} stream */
    const collect = (data, stream) => {
      bytes += Buffer.byteLength(data);
      if (bytes > maxOutputBytes) {
        const first = failure === undefined;
        failure ??= new Error(
          `${phase}: output exceeds ${maxOutputBytes} bytes`,
        );
        if (first) observeFailure();
        child.kill("SIGKILL");
      } else if (stream === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout
      ?.setEncoding("utf8")
      .on("data", (data) => collect(data, "stdout"));
    child.stderr
      ?.setEncoding("utf8")
      .on("data", (data) => collect(data, "stderr"));
    child.once("error", (error) => {
      const first = failure === undefined;
      failure ??= error;
      if (first) observeFailure();
    });
    child.once("close", (code, signal) => {
      clearTimer(deadline);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`${phase}: exited ${code ?? signal}\n${stderr}`));
      else resolveResult(stdout);
    });
  });
}

/**
 * @param {import('./host-types.js').HostProfile} profile
 * @param {{packageVersion: string, platform?: NodeJS.Platform, expectedBackendHash?: string}} options
 * @returns {import('./host-types.js').InstalledProduct}
 */
export function installedPackage(
  profile,
  { packageVersion, platform = process.platform, expectedBackendHash },
) {
  const candidates = readdirSync(profile.extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(profile.extensionsDir, entry.name))
    .filter((directory) => existsSync(join(directory, "package.json")))
    .map((directory) => ({
      directory,
      manifest: JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ),
    }))
    .filter(
      ({ manifest }) =>
        manifest.publisher === "saltyorg" && manifest.name === "saltbox-lint",
    );
  assert.equal(
    candidates.length,
    1,
    "isolated installation must contain exactly one Saltbox Lint package",
  );
  const { directory, manifest } = candidates[0];
  assert.equal(
    manifest.version,
    packageVersion,
    "installed package version must match the tested VSIX",
  );
  const confined = relative(
    realpathSync(profile.extensionsDir),
    realpathSync(directory),
  );
  assert.ok(
    confined && !confined.startsWith("..") && !isAbsolute(confined),
    "installed package must belong to the isolated profile",
  );
  const cliPath = join(
    directory,
    "bin",
    "saltbox-lint" + (platform === "win32" ? ".exe" : ""),
  );
  const confinedCLI = relative(realpathSync(directory), realpathSync(cliPath));
  assert.ok(
    confinedCLI && !confinedCLI.startsWith("..") && !isAbsolute(confinedCLI),
    "installed backend must belong to the tested package",
  );
  const cliBytes = readFileSync(cliPath);
  const cliSha256 = createHash("sha256").update(cliBytes).digest("hex");
  if (expectedBackendHash !== undefined)
    assert.equal(
      cliSha256,
      expectedBackendHash,
      "installed backend bytes must match the tested VSIX",
    );
  return {
    directory,
    version: manifest.version,
    cliPath,
    cliSha256: expectedBackendHash ?? cliSha256,
  };
}

/**
 * @param {string} filename
 * @param {{platform?: NodeJS.Platform, readArchive?: import('./host-types.js').ReadArchive}} [dependencies]
 * @returns {Promise<{version: string, backendHash: string}>}
 */
export async function vsixIdentity(
  filename,
  { platform = process.platform, readArchive = readVSIX } = {},
) {
  const entries = await readArchive(filename);
  const packageEntry = entries.get("extension/package.json");
  assert.ok(packageEntry, "tested VSIX must contain its product manifest");
  const manifest = JSON.parse(packageEntry.bytes.toString("utf8"));
  assert.equal(
    manifest.publisher,
    "saltyorg",
    "tested VSIX publisher must match the product",
  );
  assert.equal(
    manifest.name,
    "saltbox-lint",
    "tested VSIX name must match the product",
  );
  assert.equal(
    typeof manifest.version,
    "string",
    "tested VSIX version must be a string",
  );
  const binary = entries.get(
    "extension/bin/saltbox-lint" + (platform === "win32" ? ".exe" : ""),
  );
  assert.ok(binary, "tested VSIX must contain the native backend");
  return {
    version: manifest.version,
    backendHash: createHash("sha256").update(binary.bytes).digest("hex"),
  };
}

/**
 * @param {{env: NodeJS.ProcessEnv, profile: import('./host-types.js').HostProfile, executable: string, realCLI: string, product?: import('./host-types.js').InstalledProduct, directory?: string}} configuration
 * @returns {import('./host-types.js').HostLaunchOptions}
 */
export function hostOptions({
  env,
  profile,
  executable,
  realCLI,
  product,
  directory = extensionDirectory,
}) {
  const { expectedVersion, mode } = hostInputs(env);
  const vsix = env.SALTBOX_TEST_VSIX;
  const untrusted = env.SALTBOX_TEST_UNTRUSTED === "1";
  return {
    vscodeExecutablePath: executable,
    version: expectedVersion,
    reuseMachineInstall: true,
    extensionDevelopmentPath:
      vsix || env.SALTBOX_TEST_SAVE_SCOPE === "1"
        ? profile.controller
        : env.SALTBOX_TEST_MARKERS === "1"
          ? [directory, profile.controller]
          : directory,
    extensionTestsEnv: {
      ...env,
      SALTBOX_TEST_EXPECTED_VSCODE_VERSION: expectedVersion,
      SALTBOX_TEST_HOST_MODE: mode,
      SALTBOX_TEST_INSTALLED_CLI_PATH: realCLI,
      SALTBOX_TEST_EXTENSIONS_DIR: profile.extensionsDir,
      SALTBOX_TEST_USER_DATA_DIR: profile.userData,
      SALTBOX_TEST_WORKSPACE_PATH: profile.workspaceRoot,
      SALTBOX_TEST_EXPECTED_PRODUCT_VERSION: product?.version,
      SALTBOX_TEST_EXPECTED_PRODUCT_PATH: product?.directory,
      SALTBOX_TEST_EXPECTED_CLI_SHA256: product?.cliSha256,
      SALTBOX_TEST_REAL_CLI: env.SALTBOX_TEST_SAVE_SCOPE === "1" ? realCLI : "",
      SALTBOX_TEST_FIXTURE_PATH: join(
        directory,
        "bin",
        "process-fixture" + (process.platform === "win32" ? ".exe" : ""),
      ),
    },
    extensionTestsPath: join(directory, "dist/test/host.js"),
    launchArgs: [
      join(profile.workspaceRoot, "test.code-workspace"),
      "--no-sandbox",
      "--disable-gpu",
      ...(untrusted ? [] : ["--disable-workspace-trust"]),
      "--user-data-dir",
      profile.userData,
      "--extensions-dir",
      profile.extensionsDir,
      "--skip-welcome",
      "--skip-release-notes",
      ...(env.SALTBOX_TEST_LOGS ? ["--log", "trace"] : []),
      ...(vsix ? [] : ["--disable-extensions"]),
      ...(env.SALTBOX_TEST_DISABLED === "1"
        ? ["--disable-extension", "saltyorg.saltbox-lint"]
        : []),
    ],
  };
}

/**
 * @param {Pick<import('./host-types.js').HostLaunchOptions, 'launchArgs' | 'extensionTestsEnv'>} options
 * @param {import('./host-types.js').HostProfile} profile
 */
export function verifyHostProfiles(options, profile) {
  for (const [flag, expected] of [
    ["--user-data-dir", profile.userData],
    ["--extensions-dir", profile.extensionsDir],
  ]) {
    const index = options.launchArgs.indexOf(flag);
    assert.ok(index >= 0, `editor launch must specify ${flag}`);
    assert.equal(
      options.launchArgs.filter(
        (argument) => argument === flag || argument.startsWith(flag + "="),
      ).length,
      1,
      `editor launch must specify exactly one ${flag}`,
    );
    assert.equal(
      options.launchArgs[index + 1],
      expected,
      `editor launch ${flag} must match installation profile`,
    );
  }
  assert.equal(
    options.extensionTestsEnv.SALTBOX_TEST_EXTENSIONS_DIR,
    profile.extensionsDir,
    "controller must observe the matched installation profile",
  );
  assert.equal(
    options.extensionTestsEnv.SALTBOX_TEST_USER_DATA_DIR,
    profile.userData,
    "controller must observe the matched user-data profile",
  );
}

/**
 * @param {import('./host-types.js').HostConfiguration} [configuration]
 * @param {import('./host-types.js').WorkerDependencies} [dependencies]
 */
export async function runHostWorker(
  { env = process.env, directory = extensionDirectory } = {},
  {
    electron = sdk,
    command = inheritedCommand,
    clock = () => performance.now(),
    report = reportDefault,
    readArchive = readVSIX,
  } = {},
) {
  assert.equal(
    env.SALTBOX_TEST_HOST_WORKER,
    "1",
    "worker must run under an external profile owner",
  );
  assert.ok(
    env.SALTBOX_TEST_PROFILE_ROOT,
    "external owner must provide the fresh profile directory",
  );
  const profile = hostProfilePaths(env.SALTBOX_TEST_PROFILE_ROOT);
  const { expectedVersion, mode } = hostInputs(env);
  const { phase, failures: observerFailures } = phaseRecorder(
    { version: expectedVersion, mode },
    clock,
    report,
  );
  /** @type {import('./host-types.js').HostCommand} */
  const execute = (name, args, options) =>
    command(name, args, {
      ...options,
      cwd: directory,
      env: options.env ?? env,
    });
  /** @type {unknown} */
  let operationFailure;
  try {
    const options = await phase("setup", async () => {
      await populateHostFixture(profile, {
        env,
        extensionDirectory: directory,
        command: execute,
      });
      const executable =
        env.VSCODE_EXECUTABLE_PATH ??
        (await (electron.downloadAndUnzipVSCode ?? sdk.downloadAndUnzipVSCode)(
          expectedVersion,
        ));
      /** @param {string[]} args */
      const cli = async (args) => {
        const [name, ...prefix] = (
          electron.resolveCliArgsFromVSCodeExecutablePath ??
          sdk.resolveCliArgsFromVSCodeExecutablePath
        )(executable, { reuseMachineInstall: true });
        const cliArgs = [
          ...prefix,
          "--no-sandbox",
          "--user-data-dir",
          profile.userData,
          "--extensions-dir",
          profile.extensionsDir,
          ...args,
        ];
        // The public SDK's Windows CLI is a .cmd launcher. Match its documented
        // shell invocation while the enclosing Job retains process ownership.
        const shell = process.platform === "win32";
        return execute(name, cliArgs, {
          phase: "VS Code installation CLI",
          timeoutMs: 90000,
          shell,
        });
      };
      let product;
      if (env.SALTBOX_TEST_VSIX) {
        const expected = await vsixIdentity(resolve(env.SALTBOX_TEST_VSIX), {
          readArchive,
        });
        const manifest = JSON.parse(
          readFileSync(join(directory, "package.json"), "utf8"),
        );
        assert.equal(
          expected.version,
          manifest.version,
          "tested VSIX version must match source package identity",
        );
        await cli([
          "--install-extension",
          resolve(env.SALTBOX_TEST_VSIX),
          "--force",
        ]);
        assert.match(
          await cli(["--list-extensions", "--show-versions"]),
          /^saltyorg\.saltbox-lint@/m,
        );
        product = installedPackage(profile, {
          packageVersion: expected.version,
          expectedBackendHash: expected.backendHash,
        });
      }
      const realCLI =
        product?.cliPath ??
        join(
          directory,
          "bin",
          "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
        );
      if (env.SALTBOX_TEST_SAVE_SCOPE === "1")
        assert.ok(
          existsSync(realCLI),
          "recording proxy requires the real platform CLI",
        );
      const options = hostOptions({
        env,
        profile,
        executable,
        realCLI,
        product,
        directory,
      });
      verifyHostProfiles(options, profile);
      return options;
    });
    await phase("exercise", async () => {
      if (env.SALTBOX_TEST_UNTRUSTED === "1") {
        // test-electron 3.1.0 always adds --disable-workspace-trust. Its public
        // executable/launch options still define this deliberately direct case.
        await execute(
          options.vscodeExecutablePath,
          [
            ...options.launchArgs,
            `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
            `--extensionTestsPath=${options.extensionTestsPath}`,
            "--disable-updates",
          ],
          {
            phase: "restricted workspace host",
            timeoutMs: 90000,
            stdio: "inherit",
            env: options.extensionTestsEnv,
          },
        );
      } else await electron.runTests(options);
    });
    return options;
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    if (observerFailures.length)
      throw withObserverFailures(operationFailure, observerFailures);
  }
}

/**
 * @param {import('./host-types.js').HostConfiguration} [configuration]
 * @param {import('./host-types.js').HostProfileDependencies} [dependencies]
 */
export async function runHostProfile(
  {
    env = process.env,
    directory = extensionDirectory,
    executable = process.execPath,
  } = {},
  {
    command = ownedCommand,
    createProfile = createHostProfile,
    cleanupProfile = cleanupHostProfile,
    createSupervisor = createHostProcessSupervisor,
    clock = () => performance.now(),
    report = reportDefault,
  } = {},
) {
  const { expectedVersion, mode } = hostInputs(env);
  const {
    phase,
    report: emit,
    clock: observeClock,
    failures: observerFailures,
  } = phaseRecorder({ version: expectedVersion, mode }, clock, report);
  let profile;
  try {
    profile = await phase("profile setup", () =>
      createProfile({ workspaceBase: env.SALTBOX_TEST_WORKSPACE_BASE }),
    );
  } catch (error) {
    throw withObserverFailures(error, observerFailures);
  }
  /** @type {unknown} */
  let failure;
  let ownershipReleased = true;
  let commandStarted = false;
  /** @type {Awaited<ReturnType<NonNullable<import('./host-types.js').HostProfileDependencies['createSupervisor']>>>} */
  let supervisor;
  try {
    supervisor = await phase("nested owner setup", () => createSupervisor());
    await phase("profile exercise", async () => {
      commandStarted = true;
      ownershipReleased = false;
      await command(executable, [join(directory, "scripts/test-host.mjs")], {
        phase: `VS Code ${expectedVersion} ${mode}`,
        timeoutMs: profileTimeoutMs,
        stdio: "inherit",
        cwd: directory,
        env: {
          ...env,
          SALTBOX_TEST_HOST_WORKER: "1",
          SALTBOX_TEST_PROFILE_ROOT: profile.root,
          SALTBOX_LINT_EDITOR_SUPERVISOR: supervisor?.environment,
        },
      });
      ownershipReleased = true;
    });
  } catch (error) {
    failure = error;
    ownershipReleased ||=
      !commandStarted ||
      (error instanceof Error &&
        "ownershipReleased" in error &&
        error.ownershipReleased === true);
  }
  let nestedReleased = true;
  if (supervisor) {
    const owner = supervisor;
    try {
      const release = await phase("nested owner cleanup", () => owner.finish());
      if (release)
        emit({
          version: expectedVersion,
          mode,
          phase: "nested owner cleanup",
          stage: "ownership",
          ...release,
        });
    } catch (error) {
      nestedReleased = false;
      failure = failure
        ? new AggregateError(
            [failure, error],
            "host profile and nested ownership failed",
            { cause: failure },
          )
        : error;
    }
  }
  if (!ownershipReleased || !nestedReleased) {
    emit({
      version: expectedVersion,
      mode,
      phase: "cleanup",
      stage: "retained",
      profileRoot: profile.root,
      reason: ownershipReleased
        ? "nested process owner could not establish release"
        : "process owner could not establish release",
    });
    failure = withObserverFailures(failure, observerFailures);
    const retained =
      failure instanceof Error
        ? failure
        : new Error("host ownership failed", { cause: failure });
    throw Object.assign(retained, { retainedProfile: profile.root });
  }
  try {
    await phase("cleanup", async () => {
      const started = observeClock();
      await cleanupProfile(profile, {
        logsPath: env.SALTBOX_TEST_LOGS,
        label: `${expectedVersion}-${mode}`,
      });
      const ended = observeClock();
      // An unavailable clock is an observer failure at the final result. It
      // cannot prevent restoration or manufacture a successful timing claim.
      if (started !== undefined && ended !== undefined)
        assert.ok(
          ended - started <= cleanupTimeoutMs,
          `profile cleanup exceeded its independent ${cleanupTimeoutMs}ms budget`,
        );
    });
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "host profile and cleanup failed",
          { cause: failure },
        )
      : error;
    if (existsSync(profile.root)) {
      const retained =
        failure instanceof Error
          ? failure
          : new Error("host cleanup failed", { cause: failure });
      failure = Object.assign(retained, { retainedProfile: profile.root });
    }
  }
  failure = withObserverFailures(failure, observerFailures);
  if (failure) throw failure;
}
