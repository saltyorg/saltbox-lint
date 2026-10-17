// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorAcceptance } from "./host/editor-acceptance.ts";
import { getHostProfile } from "./host/host-profile.ts";
import { verifyInstalledProduct } from "./host/host-preflight.ts";
import { hostInputs } from "../scripts/host-inputs.mjs";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { createHostProcessSupervisor } from "../scripts/host-process-supervisor.mjs";
import { workspaceFixtureDirectory } from "./support/workspace-fixture.ts";
import { withTestResources } from "./support/test-resources.ts";
import {
  createHostProfile,
  cleanupHostProfile,
  populateHostFixture,
} from "../scripts/host-fixture.mjs";
import {
  extensionDirectory,
  hostOptions,
  installedPackage,
  inheritedCommand,
  profileTimeoutMs,
  runHostProfile,
  runHostWorker,
  verifyHostProfiles,
  vsixIdentity,
} from "../scripts/host-launcher.mjs";
import {
  hostModes,
  hostVersions,
  profileEnvironment,
  runNativeHosts,
} from "../scripts/native-hosts.mjs";

const workspaceBase = process.env.SALTBOX_TEST_WORKSPACE_BASE ?? tmpdir();

const resultEnvironment = Object.freeze({
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "12345",
  GITHUB_RUN_ATTEMPT: "2",
  PRIVATE_INPUT: "must not appear in results",
});

const realResultsIO = Object.freeze({
  write: writeFileSync,
  link: linkSync,
  rename: renameSync,
  remove: rmSync,
});

/** @param {string} filename @returns {import('../scripts/native-hosts.mjs').HostResults} */
function readHostResults(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

/** @param {unknown} error @param {unknown} target @returns {boolean} */
function containsFailure(error, target) {
  if (error === target) return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((item) => containsFailure(item, target))
  )
    return true;
  return error instanceof Error && containsFailure(error.cause, target);
}

/** @typedef {import("../scripts/host-types.js").HostProfile} HostProfile */
/** @typedef {import("../scripts/host-types.js").CommandOptions} CommandOptions */
/** @typedef {CommandOptions & {command: string, args: string[], env: NodeJS.ProcessEnv}} CommandCall */
/** @typedef {import("../scripts/host-types.js").ProfileRecord} ProfileRecord */

/** @param {import("node:test").TestContext} t */
function profileFor(t) {
  const profile = createHostProfile({ workspaceBase });
  t.after(() => {
    if (existsSync(profile.root)) cleanupHostProfile(profile);
  });
  return profile;
}

/** @param {Pick<HostProfile, "root">} profile */
function workerEnvironment(profile, mode = "disabled", version = "1.100.0") {
  return {
    ...profileEnvironment(
      {},
      {
        version,
        mode,
        executable: `/sdk/${version}`,
        vsix: undefined,
      },
    ),
    SALTBOX_TEST_HOST_WORKER: "1",
    SALTBOX_TEST_PROFILE_ROOT: profile.root,
  };
}

/** @param {HostProfile} profile */
function fakeProduct(
  profile,
  { version = "0.1.0", publisher = "saltyorg", name = "saltbox-lint" } = {},
) {
  const directory = join(
    profile.extensionsDir,
    `${publisher}.${name}-${version}`,
  );
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ version, publisher, name }),
  );
  writeFileSync(
    join(
      directory,
      "bin",
      "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
    ),
    "fixture backend",
  );
  return directory;
}

/** @param {string} message */
function releasedError(message) {
  return Object.assign(new Error(message), { ownershipReleased: true });
}

/**
 * @param {{version?: string, backend?: string | Buffer}} [options]
 * @returns {Map<string, import("../scripts/host-types.js").ArchiveEntry>}
 */
function fakeVSIXEntries({
  version = "0.1.0",
  backend = "fixture backend",
} = {}) {
  return new Map([
    [
      "extension/package.json",
      {
        bytes: Buffer.from(
          JSON.stringify({
            name: "saltbox-lint",
            publisher: "saltyorg",
            version,
          }),
        ),
      },
    ],
    [
      "extension/bin/saltbox-lint" +
        (process.platform === "win32" ? ".exe" : ""),
      { bytes: Buffer.from(backend) },
    ],
  ]);
}

/** @param {CommandOptions} options @returns {NodeJS.ProcessEnv} */
function commandEnvironment(options) {
  assert.ok(options.env, "a command must carry its isolated environment");
  return options.env;
}

/** @param {NodeJS.ProcessEnv} env */
function profileRoot(env) {
  const root = env.SALTBOX_TEST_PROFILE_ROOT;
  assert.ok(root, "a command must carry its owned profile root");
  return root;
}

test("acceptance rejects a wrong actual public editor version", () => {
  assert.throws(
    () =>
      editorAcceptance({
        expectedVersion: "1.100.0",
        actualVersion: "1.137.0",
        mode: "disabled",
        platform: process.platform,
        arch: process.arch,
        appRoot: "unused before version rejection",
        controllerPath: "unused before version rejection",
        cliPath: undefined,
        proxyPath: undefined,
      }),
    /actual public vscode.version/,
  );
});

test("acceptance reads shipped metadata and records actual runtime facts", (t) => {
  const profile = profileFor(t);
  writeFileSync(
    join(profile.root, "product.json"),
    JSON.stringify({
      version: "1.100.0",
      commit: "shipped-commit",
      nameShort: "Code",
      secret: "not emitted",
    }),
  );
  const facts = {
    expectedVersion: "1.100.0",
    actualVersion: "1.100.0",
    platform: "darwin",
    arch: "x64",
    mode: "dependencies",
    appRoot: profile.root,
    controllerPath: join(profile.root, "product.json"),
    cliPath: undefined,
    proxyPath: undefined,
  };
  const record = editorAcceptance(facts);
  assert.deepEqual(record.product, {
    state: "available",
    metadata: {
      version: "1.100.0",
      commit: "shipped-commit",
      nameShort: "Code",
    },
  });
  assert.equal(record.controller.state, "available");
  assert.equal(record.cli.state, "unavailable");
  assert.equal(record.expectedVersion, "1.100.0");
  assert.equal(record.actualVersion, "1.100.0");
  assert.equal(record.target, "darwin-x64");
  assert.throws(
    () => editorAcceptance({ ...facts, expectedVersion: undefined }),
    /provide expected/,
  );
});

test("native parent uses the owned command for both SDKs and every original mode", async () => {
  /** @type {CommandCall[]} */
  const calls = [];
  /** @type {string[]} */
  const downloads = [];
  await runNativeHosts(
    {
      env: {
        SALTBOX_TEST_WORKSPACE_BASE: workspaceBase,
        VSCODE_VERSION: "wrong inherited label",
        SALTBOX_TEST_PROFILE: "1",
        SALTBOX_TEST_QUALIFICATION: "1",
      },
      platform: "darwin",
      arch: "x64",
    },
    {
      download: async (version) => {
        downloads.push(version);
        return `/sdk/${version}`;
      },
      command: async (command, args, options) => {
        const env = commandEnvironment(options);
        calls.push({ command, args, ...options, env });
        assert.ok(existsSync(profileRoot(env)));
        return "";
      },
      report() {},
    },
  );
  assert.deepEqual(downloads, ["1.100.0", "1.137.0"]);
  assert.deepEqual(hostModes, [
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
  assert.equal(calls.length, 34);
  assert.equal(
    new Set(calls.map((call) => call.env.SALTBOX_TEST_PROFILE_ROOT)).size,
    34,
    "every profile has independent resources",
  );
  for (const [index, call] of calls.entries()) {
    const expected = index < 17 ? "1.100.0" : "1.137.0";
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, [
      join(extensionDirectory, "scripts/test-host.mjs"),
    ]);
    assert.equal(call.timeoutMs, 180000);
    assert.equal(call.env.SALTBOX_TEST_EXPECTED_VSCODE_VERSION, expected);
    assert.equal(call.env.VSCODE_EXECUTABLE_PATH, `/sdk/${expected}`);
    assert.equal(call.env.SALTBOX_TEST_HOST_WORKER, "1");
    assert.equal(call.env.SALTBOX_TEST_PROFILE, "0");
    assert.equal(call.env.SALTBOX_TEST_QUALIFICATION, "0");
    assert.equal(hostInputs(call.env).expectedVersion, expected);
    assert.equal(
      call.env.SALTBOX_TEST_VSIX,
      join(extensionDirectory, "../dist/saltbox-lint-0.1.0-darwin-x64.vsix"),
    );
    assert.equal(
      existsSync(profileRoot(call.env)),
      false,
      "profile disappears after owner joins",
    );
  }
  for (const offset of [0, 17])
    assert.deepEqual(
      calls
        .slice(offset, offset + 17)
        .map((call) => call.env.SALTBOX_TEST_HOST_MODE),
      hostModes,
    );
});

for (const mode of hostModes) {
  test(`native parent propagates ${mode} failure and cleans only after owner release`, async () => {
    const failure = releasedError(`controlled ${mode} failure`);
    /** @type {NodeJS.ProcessEnv[]} */
    const calls = [];
    /** @type {string[]} */
    const downloads = [];
    await assert.rejects(
      runNativeHosts(
        { env: { SALTBOX_TEST_WORKSPACE_BASE: workspaceBase } },
        {
          download: async (version) => {
            downloads.push(version);
            return "/sdk";
          },
          command: async (_name, _args, options) => {
            const env = commandEnvironment(options);
            calls.push(env);
            if (env.SALTBOX_TEST_HOST_MODE === mode) throw failure;
            return "";
          },
          report() {},
        },
      ),
      (error) => error === failure,
    );
    assert.deepEqual(downloads, ["1.100.0"]);
    assert.equal(calls.at(-1)?.SALTBOX_TEST_HOST_MODE, mode);
    assert.ok(calls.every((env) => !existsSync(profileRoot(env))));
  });
}

test("a parent deadline joins its owned process before deleting the fresh profile", async () => {
  /** @type {string[]} */
  const events = [];
  /** @type {(() => void) | undefined} */
  let release;
  /** @type {string | undefined} */
  let profileRoot;
  const failure = releasedError("controlled parent deadline");
  const pending = runHostProfile(
    { env: { SALTBOX_TEST_WORKSPACE_BASE: workspaceBase } },
    {
      command: (_name, _args, options) => {
        profileRoot = commandEnvironment(options).SALTBOX_TEST_PROFILE_ROOT;
        events.push("owner running");
        return new Promise((_resolve, reject) => {
          release = () => {
            events.push("owner joined");
            reject(failure);
          };
        });
      },
      cleanupProfile: (profile) => {
        events.push("directories removed");
        cleanupHostProfile(profile);
      },
      report() {},
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(profileRoot);
  assert.ok(existsSync(profileRoot));
  assert.deepEqual(events, ["owner running"]);
  assert.ok(release);
  release();
  await assert.rejects(pending, (error) => error === failure);
  assert.deepEqual(events, [
    "owner running",
    "owner joined",
    "directories removed",
  ]);
  assert.equal(existsSync(profileRoot), false);
});

test("uncertain process cleanup retains the owned profile and fails qualification", async (t) => {
  /** @type {HostProfile | undefined} */
  let profile;
  const failure = Object.assign(new Error("uncertain group release"), {
    ownershipReleased: false,
  });
  /** @type {ProfileRecord[]} */
  const records = [];
  await assert.rejects(
    runHostProfile(
      { env: {} },
      {
        createProfile: () => {
          profile = profileFor(t);
          return profile;
        },
        command: async () => {
          throw failure;
        },
        cleanupProfile: () =>
          assert.fail("uncertain live directories cannot be removed"),
        report: (record) => records.push(record),
      },
    ),
    (error) =>
      error === failure &&
      "retainedProfile" in failure &&
      failure.retainedProfile === profile?.root,
  );
  assert.ok(profile);
  assert.ok(existsSync(profile.root));
  assert.equal(records.at(-1)?.stage, "retained");
  assert.equal(records.at(-1)?.profileRoot, profile.root);
});

test("profile failure and cleanup failure are both retained", async (t) => {
  const profile = profileFor(t);
  const primary = releasedError("editor assertion failed");
  const cleanup = new Error("restore failed");
  await assert.rejects(
    runHostProfile(
      { env: {} },
      {
        createProfile: () => profile,
        command: async () => {
          throw primary;
        },
        cleanupProfile: async () => {
          throw cleanup;
        },
        report() {},
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.cause === primary &&
      error.errors[0] === primary &&
      error.errors[1] === cleanup,
  );
});

test("profile setup, exercise and cleanup report separate elapsed phases", async () => {
  /** @type {ProfileRecord[]} */
  const records = [];
  let elapsed = 0;
  await runHostProfile(
    { env: { SALTBOX_TEST_WORKSPACE_BASE: workspaceBase } },
    {
      command: async () => {
        elapsed += 123;
      },
      clock: () => elapsed,
      report: (record) => records.push(record),
    },
  );
  assert.deepEqual(
    records
      .filter(
        (record) =>
          record.stage === "completed" &&
          ["profile setup", "profile exercise", "cleanup"].includes(
            record.phase,
          ),
      )
      .map((record) => [record.phase, record.elapsedMs]),
    [
      ["profile setup", 0],
      ["profile exercise", 123],
      ["cleanup", 0],
    ],
  );
  assert.equal(profileTimeoutMs, 180000);
});

test("cleanup requires the exact owned container and preserves another profile", (t) => {
  const first = profileFor(t);
  const other = profileFor(t);
  writeFileSync(join(other.root, "owned-by-other.txt"), "preserve");
  assert.throws(() => cleanupHostProfile({ ...other }), /exact profile/);
  cleanupHostProfile(first);
  assert.equal(
    readFileSync(join(other.root, "owned-by-other.txt"), "utf8"),
    "preserve",
  );
});

test("cleanup rejects a replaced directory without deleting its contents", (t) => {
  const profile = profileFor(t);
  const moved = profile.root + "-owned";
  renameSync(profile.root, moved);
  mkdirSync(profile.root);
  writeFileSync(join(profile.root, "replacement.txt"), "preserve replacement");
  try {
    assert.throws(
      () => cleanupHostProfile(profile),
      /directory identity changed/,
    );
    assert.equal(
      readFileSync(join(profile.root, "replacement.txt"), "utf8"),
      "preserve replacement",
    );
  } finally {
    rmSync(profile.root, { recursive: true, force: true });
    renameSync(moved, profile.root);
  }
});

test("real fixture Git initialization and all fixture workloads remain available", async (t) => {
  const profile = profileFor(t);
  const env = workerEnvironment(profile, "live-checking");
  await populateHostFixture(profile, {
    env,
    extensionDirectory,
    command: ownedCommand,
  });
  for (const name of ["one", "two"]) {
    assert.ok(existsSync(join(profile.workspaceRoot, name, ".git")));
    assert.ok(existsSync(join(profile.workspaceRoot, name, ".saltbox-lint")));
    assert.ok(
      readFileSync(
        join(profile.workspaceRoot, name, "roles/navsource/tasks/main.yml"),
        "utf8",
      ).includes("😀é\r\n"),
    );
  }
  assert.ok(
    existsSync(
      join(profile.workspaceRoot, "one/roles/readonly/templates/config.yaml"),
    ),
  );
  assert.ok(
    existsSync(
      join(
        profile.workspaceRoot,
        "one/roles/readonly-directory/templates/config.j2",
      ),
    ),
  );
  assert.equal(
    readFileSync(
      join(
        profile.workspaceRoot,
        "one/roles/example/tasks/safe-rule-fixes.yml",
      ),
      "utf8",
    ).includes("# Author(s): salty"),
    true,
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(profile.workspaceRoot, "test.code-workspace"), "utf8"),
    ).folders,
    [{ path: "one" }, { path: "two" }],
  );
});

test("queue fixture retains all 46 entries in each independent repository", async (t) => {
  const profile = profileFor(t);
  await populateHostFixture(profile, {
    env: workerEnvironment(profile, "queue"),
    extensionDirectory,
    command: async () => "",
  });
  for (const name of ["one", "two"])
    assert.equal(
      readdirSync(join(profile.workspaceRoot, name)).filter((name) =>
        /^queue-\d+\.yml$/.test(name),
      ).length,
      46,
    );
});

test("active-project fixtures isolate late saves and keep related declarations distinct", async (t) => {
  for (const mode of ["active-project", "active-project-cache"]) {
    const profile = profileFor(t);
    await populateHostFixture(profile, {
      env: workerEnvironment(profile, mode),
      extensionDirectory,
      command: async () => "",
    });
    assert.equal(
      readFileSync(join(profile.workspaceRoot, "one/late.yml"), "utf8"),
      'value: "{{ initial\n }}"\n',
    );
    assert.equal(
      existsSync(
        join(profile.workspaceRoot, "one/roles/late/defaults/main.yml"),
      ),
      false,
      "late-save control must be outside cross-file declaration dependencies",
    );
    const names = new Set();
    for (const filename of readdirSync(
      join(profile.workspaceRoot, "one/roles/example/defaults"),
    )) {
      const text = readFileSync(
        join(profile.workspaceRoot, "one/roles/example/defaults", filename),
        "utf8",
      );
      for (const match of text.matchAll(/^([a-z][a-z0-9_]*):/gm)) {
        assert.equal(
          names.has(match[1]),
          false,
          `duplicate fixture variable ${match[1]}`,
        );
        names.add(match[1]);
      }
      if (
        [
          "related.yml",
          "related-closed.yml",
          "a-related.yml",
          "z-gate.yml",
        ].includes(filename)
      ) {
        assert.equal(
          text.match(/^# Settings$/gm)?.length,
          2,
          "related-location section workload is preserved",
        );
      }
    }
  }
});

test("disabled live performance preserves original fixtures and registers controller configuration", async (t) => {
  const profile = profileFor(t);
  const env = workerEnvironment(profile, "live-performance");
  assert.equal(env.SALTBOX_TEST_DISABLED, "1");
  assert.equal(env.SALTBOX_TEST_SAVE_SCOPE, "0");
  await populateHostFixture(profile, {
    env,
    extensionDirectory,
    command: async () => "",
  });
  assert.ok(
    existsSync(
      join(profile.workspaceRoot, "one/roles/readonly/templates/config.yaml"),
    ),
  );
  assert.ok(
    existsSync(
      join(profile.workspaceRoot, "one/roles/navsource/tasks/main.yml"),
    ),
  );
  const controller = JSON.parse(
    readFileSync(join(profile.controller, "package.json"), "utf8"),
  );
  assert.equal(
    controller.contributes.configuration.properties["saltboxLint.checkOnType"]
      .default,
    false,
  );
});

test("nested owner setup failure removes only the unused profile and cannot launch", async (t) => {
  const profile = profileFor(t);
  const failure = new Error("supervisor setup failed");
  await assert.rejects(
    runHostProfile(
      { env: {} },
      {
        createProfile: () => profile,
        createSupervisor: async () => {
          throw failure;
        },
        command: () => assert.fail("failed setup cannot launch a worker"),
        report() {},
      },
    ),
    (error) => error === failure,
  );
  assert.equal(existsSync(profile.root), false);
});

for (const version of hostVersions) {
  for (const mode of ["disabled", "live-checking"]) {
    test(`worker directly forwards ${version} ${mode} to the supported SDK`, async (t) => {
      const profile = profileFor(t);
      const env = workerEnvironment(profile, mode, version);
      /** @type {import("@vscode/test-electron").TestOptions | undefined} */
      let received;
      const options = await runHostWorker(
        { env },
        {
          command: async () => "",
          electron: {
            downloadAndUnzipVSCode: () =>
              assert.fail("explicit executable must be retained"),
            runTests: async (value) => {
              received = value;
            },
          },
          report() {},
        },
      );
      assert.equal(options, received);
      assert.equal(options.version, version);
      assert.equal(options.vscodeExecutablePath, `/sdk/${version}`);
      assert.equal(options.extensionTestsEnv.SALTBOX_TEST_HOST_MODE, mode);
      assert.equal(
        options.extensionTestsEnv.SALTBOX_TEST_WORKSPACE_PATH,
        profile.workspaceRoot,
      );
      assert.ok(
        existsSync(profile.root),
        "worker never deletes externally owned directories",
      );
      verifyHostProfiles(options, profile);
    });
  }
}

test("worker setup failure cannot launch the editor and its outer owner cleans partial fixtures", async () => {
  const failure = new Error("fixture initialization failed");
  /** @type {string | undefined} */
  let root;
  let launches = 0;
  await assert.rejects(
    runHostProfile(
      {
        env: {
          SALTBOX_TEST_WORKSPACE_BASE: workspaceBase,
          ...workerEnvironment({ root: "provided by owner" }),
        },
      },
      {
        command: async (_name, _args, options) => {
          root = profileRoot(commandEnvironment(options));
          try {
            await runHostWorker(
              { env: options.env },
              {
                command: async () => {
                  throw failure;
                },
                electron: {
                  runTests: async () => {
                    launches++;
                  },
                },
                report() {},
              },
            );
          } catch (error) {
            assert.ok(error instanceof Error);
            Object.assign(error, { ownershipReleased: true });
            throw error;
          }
        },
        report() {},
      },
    ),
    (error) => error === failure,
  );
  assert.equal(launches, 0);
  assert.ok(root);
  assert.equal(existsSync(root), false);
});

test("restricted launch preserves trust and receives the matched profile identity", async (t) => {
  const profile = profileFor(t);
  const env = workerEnvironment(profile, "untrusted");
  /** @type {{name: string, args: string[], options: CommandOptions} | undefined} */
  let restricted;
  await runHostWorker(
    { env },
    {
      command: async (name, args, options) => {
        if (name !== "git") restricted = { name, args, options };
        return "";
      },
      electron: {
        runTests: () => assert.fail("standard runner would disable trust"),
      },
      report() {},
    },
  );
  assert.ok(restricted);
  assert.equal(restricted.name, "/sdk/1.100.0");
  assert.equal(restricted.options.timeoutMs, 90000);
  assert.equal(restricted.args.includes("--disable-workspace-trust"), false);
  assert.equal(
    commandEnvironment(restricted.options).SALTBOX_TEST_USER_DATA_DIR,
    profile.userData,
  );
  assert.equal(
    commandEnvironment(restricted.options).SALTBOX_TEST_EXTENSIONS_DIR,
    profile.extensionsDir,
  );
});

for (const flag of ["--user-data-dir", "--extensions-dir"]) {
  test(`profile mismatch and repeated ${flag} are rejected before launch`, (t) => {
    const profile = profileFor(t);
    const options = hostOptions({
      env: {},
      profile,
      executable: "/sdk",
      realCLI: "/cli",
    });
    const wrong = { ...options, launchArgs: [...options.launchArgs] };
    wrong.launchArgs[wrong.launchArgs.indexOf(flag) + 1] = "/wrong/profile";
    assert.throws(
      () => verifyHostProfiles(wrong, profile),
      /match installation profile/,
    );
    assert.throws(
      () =>
        verifyHostProfiles(
          { ...options, launchArgs: [...options.launchArgs, flag + "=/wrong"] },
          profile,
        ),
      /exactly one/,
    );
  });
}

test("installed package preflight rejects missing, wrong and duplicate packages", (t) => {
  const profile = profileFor(t);
  assert.throws(
    () => installedPackage(profile, { packageVersion: "0.1.0" }),
    /exactly one/,
  );
  fakeProduct(profile, { version: "0.2.0" });
  assert.throws(
    () => installedPackage(profile, { packageVersion: "0.1.0" }),
    /package version/,
  );
  fakeProduct(profile);
  assert.throws(
    () => installedPackage(profile, { packageVersion: "0.1.0" }),
    /exactly one/,
  );
});

test("installed package and backend identity are forwarded before editor exercise", async (t) => {
  const profile = profileFor(t);
  const env = {
    ...workerEnvironment(profile),
    SALTBOX_TEST_VSIX: "fixture.vsix",
  };
  /** @type {{args: string[], options: CommandOptions}[]} */
  const commands = [];
  /** @type {import("@vscode/test-electron").TestOptions | undefined} */
  let editor;
  await runHostWorker(
    { env },
    {
      readArchive: async () => fakeVSIXEntries(),
      command: async (name, args, options) => {
        if (name === "git") return "";
        commands.push({ args, options });
        if (args.includes("--install-extension")) fakeProduct(profile);
        return "saltyorg.saltbox-lint@0.1.0\n";
      },
      electron: {
        resolveCliArgsFromVSCodeExecutablePath: () => ["code-cli", "prefix"],
        runTests: async (options) => {
          editor = options;
        },
      },
      report() {},
    },
  );
  assert.equal(commands.length, 2);
  for (const call of commands) {
    assert.equal(
      call.args[call.args.indexOf("--user-data-dir") + 1],
      profile.userData,
    );
    assert.equal(
      call.args[call.args.indexOf("--extensions-dir") + 1],
      profile.extensionsDir,
    );
    assert.equal(call.options.timeoutMs, 90000);
  }
  assert.ok(editor);
  assert.ok(editor.extensionTestsEnv);
  assert.equal(editor.extensionDevelopmentPath, profile.controller);
  assert.equal(
    editor.extensionTestsEnv.SALTBOX_TEST_EXPECTED_PRODUCT_VERSION,
    "0.1.0",
  );
  assert.equal(
    editor.extensionTestsEnv.SALTBOX_TEST_EXPECTED_CLI_SHA256?.length,
    64,
  );
  assert.equal(
    editor.extensionTestsEnv.SALTBOX_TEST_EXPECTED_PRODUCT_PATH,
    join(profile.extensionsDir, "saltyorg.saltbox-lint-0.1.0"),
  );
});

test("wrong installed version fails before any editor flow", async (t) => {
  const profile = profileFor(t);
  let launches = 0;
  await assert.rejects(
    runHostWorker(
      {
        env: {
          ...workerEnvironment(profile),
          SALTBOX_TEST_VSIX: "fixture.vsix",
        },
      },
      {
        readArchive: async () => fakeVSIXEntries(),
        command: async (name, args) => {
          if (name !== "git" && args.includes("--install-extension"))
            fakeProduct(profile, { version: "9.0.0" });
          return "saltyorg.saltbox-lint@9.0.0\n";
        },
        electron: {
          resolveCliArgsFromVSCodeExecutablePath: () => ["code-cli"],
          runTests: async () => {
            launches++;
          },
        },
        report() {},
      },
    ),
    /package version/,
  );
  assert.equal(launches, 0);
});

test("same-version installed backend mismatch is detected against independent VSIX bytes", async (t) => {
  const profile = profileFor(t);
  let launches = 0;
  await assert.rejects(
    runHostWorker(
      {
        env: {
          ...workerEnvironment(profile),
          SALTBOX_TEST_VSIX: "fixture.vsix",
        },
      },
      {
        readArchive: async () =>
          fakeVSIXEntries({ backend: "different tested archive backend" }),
        command: async (name, args) => {
          if (name !== "git" && args.includes("--install-extension"))
            fakeProduct(profile);
          return "saltyorg.saltbox-lint@0.1.0\n";
        },
        electron: {
          resolveCliArgsFromVSCodeExecutablePath: () => ["code-cli"],
          runTests: async () => {
            launches++;
          },
        },
        report() {},
      },
    ),
    /backend bytes must match the tested VSIX/,
  );
  assert.equal(launches, 0);
});

test("tested archive identity rejects missing native backend before installation", async () => {
  const entries = fakeVSIXEntries();
  entries.delete(
    "extension/bin/saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
  );
  await assert.rejects(
    vsixIdentity("fixture.vsix", { readArchive: async () => entries }),
    /contain the native backend/,
  );
});

test("inherited command requires the external owner and awaits real child closure", async () => {
  assert.throws(
    () =>
      inheritedCommand(process.execPath, ["-e", ""], {
        env: {},
        phase: "missing external owner rejection",
        timeoutMs: 1000,
      }),
    /external profile owner/,
  );
  const value = await inheritedCommand(
    process.execPath,
    ["-e", "process.stdout.write('ready')"],
    {
      env: { ...process.env, SALTBOX_TEST_HOST_WORKER: "1" },
      phase: "adapter contract",
      timeoutMs: 1000,
    },
  );
  assert.equal(value, "ready");
});

test("actual process failure joins the owned group or Job and removes its profile", async () => {
  /** @type {string | undefined} */
  let profileRoot;
  await assert.rejects(
    runHostProfile(
      { env: { ...process.env, SALTBOX_TEST_WORKSPACE_BASE: workspaceBase } },
      {
        command: (name, _args, options) => {
          profileRoot = commandEnvironment(options).SALTBOX_TEST_PROFILE_ROOT;
          return ownedCommand(name, ["-e", "process.exit(7)"], options);
        },
        report() {},
      },
    ),
    (error) =>
      error instanceof Error &&
      "ownershipReleased" in error &&
      error.ownershipReleased === true &&
      /exited 7/.test(error.message),
  );
  assert.ok(profileRoot);
  assert.equal(existsSync(profileRoot), false);
});

test("SDK download failure never creates or launches a profile", async () => {
  const failure = new Error("SDK download failed");
  await assert.rejects(
    runNativeHosts(
      {},
      {
        download: async () => {
          throw failure;
        },
        profile: () => assert.fail("download failure cannot admit a profile"),
      },
    ),
    (error) => error === failure,
  );
});

test("installed backend links outside its package fail preflight", (t) => {
  const profile = profileFor(t);
  const directory = fakeProduct(profile);
  const backend = join(
    directory,
    "bin",
    "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
  );
  // Use another owned fixture as the external target; neither package can
  // borrow the other's identity merely by pointing to its bytes.
  const other = profileFor(t);
  writeFileSync(join(other.root, "backend"), "other bytes");
  unlinkSync(backend);
  symlinkSync(join(other.root, "backend"), backend, "file");
  assert.throws(
    () => installedPackage(profile, { packageVersion: "0.1.0" }),
    /backend must belong/,
  );
});

test("failed log archival preserves the only original failure evidence", (t) => {
  const profile = profileFor(t);
  mkdirSync(join(profile.userData, "logs"));
  writeFileSync(
    join(profile.userData, "logs", "failure.log"),
    "unique failure",
  );
  const blocked = join(profile.root, "blocked-archive");
  writeFileSync(blocked, "not a directory");
  assert.throws(
    () => cleanupHostProfile(profile, { logsPath: blocked }),
    (error) =>
      error instanceof AggregateError &&
      "retainedProfile" in error &&
      error.retainedProfile === profile.root,
  );
  assert.equal(
    readFileSync(join(profile.userData, "logs", "failure.log"), "utf8"),
    "unique failure",
  );
});

test("native profile names are accepted by the directly imported controller policy", () => {
  for (const mode of hostModes)
    assert.equal(
      getHostProfile(
        profileEnvironment(
          {},
          { mode, version: "1.100.0", executable: "/sdk" },
        ),
      ),
      mode,
    );
  assert.throws(() => getHostProfile({}), /Unknown host profile/);
  assert.throws(
    () => getHostProfile({ SALTBOX_TEST_HOST_MODE: "unknown" }),
    /Unknown host profile/,
  );
});

test("controller preflight rejects incorrect loaded identity and profile before a flow", (t) => {
  const profile = profileFor(t);
  fakeProduct(profile);
  const product = installedPackage(profile, { packageVersion: "0.1.0" });
  const options = hostOptions({
    env: { SALTBOX_TEST_VSIX: "fixture.vsix" },
    profile,
    executable: "/sdk",
    realCLI: product.cliPath,
    product,
  });
  const loaded = {
    id: "saltyorg.saltbox-lint",
    extensionPath: product.directory,
    version: "0.1.0",
  };
  verifyInstalledProduct(options.extensionTestsEnv, loaded);
  assert.throws(() =>
    verifyInstalledProduct(options.extensionTestsEnv, {
      ...loaded,
      id: "wrong.product",
    }),
  );
  assert.throws(
    () =>
      verifyInstalledProduct(options.extensionTestsEnv, {
        ...loaded,
        version: "9.0.0",
      }),
    /product version/,
  );
  const other = profileFor(t);
  fakeProduct(other);
  assert.throws(
    () =>
      verifyInstalledProduct(options.extensionTestsEnv, {
        ...loaded,
        extensionPath: join(other.extensionsDir, "saltyorg.saltbox-lint-0.1.0"),
      }),
    /isolated installation/,
  );
  assert.throws(
    () =>
      verifyInstalledProduct(
        {
          ...options.extensionTestsEnv,
          SALTBOX_TEST_EXTENSIONS_DIR: other.extensionsDir,
        },
        loaded,
      ),
    /isolated installation/,
  );
  writeFileSync(product.cliPath, "wrong backend bytes");
  assert.throws(
    () => verifyInstalledProduct(options.extensionTestsEnv, loaded),
    /backend bytes/,
  );
});

test("retained child pipes do not replace the first inherited-command failure", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { inheritedCommand } from './scripts/host-launcher.mjs';
    const payload = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},250)'],{stdio:['ignore','inherit','ignore']}); process.stdout.write('too much output'); setTimeout(()=>{},10000);";
    let deadline;
    let failureObserved = false;
    await assert.rejects(inheritedCommand(process.execPath, ['-e', payload], {
      env: { ...process.env, SALTBOX_TEST_HOST_WORKER: '1' },
      phase: 'overflow retained pipes', timeoutMs: 90000, maxOutputBytes: 1,
    }, {
      setTimer: (expired) => { deadline = expired; },
      clearTimer() {},
      onFirstFailure: () => { failureObserved = true; deadline(); },
    }), /output exceeds 1 bytes/);
    assert.equal(failureObserved, true);
  `;
  await ownedCommand(process.execPath, ["--input-type=module", "-e", script], {
    phase: "inherited failure ordering with retained pipes",
    timeoutMs: 10000,
    cwd: extensionDirectory,
    env: process.env,
  });
});

for (const phase of [
  "profile setup",
  "nested owner setup",
  "profile exercise",
  "nested owner cleanup",
  "cleanup",
]) {
  for (const stage of ["started", "completed"]) {
    test(`report failure at ${phase} ${stage} cannot lose resource ownership`, async (t) => {
      const profile = profileFor(t);
      const observer = new Error("controlled reporting failure");
      let commandCalls = 0;
      let ownerFinishes = 0;
      let cleanups = 0;
      const supervisor = await createHostProcessSupervisor();
      t.after(async () => {
        await supervisor?.finish();
      });
      await assert.rejects(
        runHostProfile(
          { env: {} },
          {
            createProfile: () => profile,
            createSupervisor: async () =>
              supervisor
                ? {
                    environment: supervisor.environment,
                    finish: async () => {
                      ownerFinishes++;
                      return await supervisor.finish();
                    },
                  }
                : {
                    environment: "owned observer fixture",
                    finish: async () => {
                      ownerFinishes++;
                    },
                  },
            command: async () => {
              commandCalls++;
              return "";
            },
            cleanupProfile: (owned) => {
              cleanups++;
              cleanupHostProfile(owned);
            },
            report: (record) => {
              if (record.phase === phase && record.stage === stage)
                throw observer;
            },
          },
        ),
        (error) => containsFailure(error, observer),
      );
      assert.equal(commandCalls, 1);
      assert.equal(ownerFinishes, 1);
      assert.equal(cleanups, 1);
      assert.equal(existsSync(profile.root), false);
    });
  }
}

test("direct ownership reporting failures still join the native supervisor and clean fixtures", async (t) => {
  const profile = profileFor(t);
  const observer = new Error("direct ownership reporting failure");
  let joined = false;
  const supervisor = await createHostProcessSupervisor();
  t.after(async () => {
    await supervisor?.finish();
  });
  await assert.rejects(
    runHostProfile(
      { env: {} },
      {
        createProfile: () => profile,
        createSupervisor: async () =>
          supervisor
            ? {
                environment: supervisor.environment,
                finish: async () => {
                  const value = await supervisor.finish();
                  joined = true;
                  return value;
                },
              }
            : {
                environment: "Windows enclosing Job",
                finish: async () => {
                  joined = true;
                  return {
                    reservations: 0,
                    registrations: 0,
                    groups: 0,
                    released: true,
                  };
                },
              },
        command: async () => "",
        report: (record) => {
          if (record.stage === "ownership") throw observer;
        },
      },
    ),
    (error) => containsFailure(error, observer),
  );
  assert.equal(joined, true);
  assert.equal(existsSync(profile.root), false);
});

test("retention reporting cannot replace primary failure or discard uncertain inputs", async (t) => {
  const profile = profileFor(t);
  const primary = Object.assign(new Error("unproven command release"), {
    ownershipReleased: false,
  });
  const observer = new Error("retention reporting failure");
  await assert.rejects(
    runHostProfile(
      { env: {} },
      {
        createProfile: () => profile,
        createSupervisor: async () => undefined,
        command: async () => {
          throw primary;
        },
        cleanupProfile: () =>
          assert.fail("uncertain ownership forbids removal"),
        report: (record) => {
          if (record.stage === "retained") throw observer;
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof Error && "retainedProfile" in error);
      assert.equal(error.retainedProfile, profile.root);
      assert.ok(containsFailure(error, primary));
      assert.ok(containsFailure(error, observer));
      return true;
    },
  );
  assert.equal(existsSync(profile.root), true);
});

test("operation, restoration and reporting failures all survive final cleanup", async (t) => {
  const profile = profileFor(t);
  const primary = releasedError("primary command failure");
  const cleanup = new Error("controlled restoration failure");
  const observer = new Error("cleanup observer failure");
  await assert.rejects(
    runHostProfile(
      { env: {} },
      {
        createProfile: () => profile,
        createSupervisor: async () => undefined,
        command: async () => {
          throw primary;
        },
        cleanupProfile: () => {
          throw cleanup;
        },
        report: (record) => {
          if (record.phase === "cleanup") throw observer;
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof Error && "retainedProfile" in error);
      assert.equal(error.retainedProfile, profile.root);
      for (const failure of [primary, cleanup, observer])
        assert.ok(containsFailure(error, failure));
      return true;
    },
  );
  assert.equal(existsSync(profile.root), true);
});

for (const mode of ["always", "during cleanup", "nonfinite"]) {
  test(`${mode} clock failure leaves timing unknown and cannot bypass teardown`, async (t) => {
    const profile = profileFor(t);
    const clockFailure = new Error("controlled clock failure");
    let cleaning = false;
    let cleanups = 0;
    /** @type {import('../scripts/host-types.js').ProfileRecord[]} */
    const reports = [];
    await assert.rejects(
      runHostProfile(
        { env: {} },
        {
          createProfile: () => profile,
          createSupervisor: async () => undefined,
          command: async () => "",
          cleanupProfile: (owned) => {
            cleaning = true;
            cleanups++;
            cleanupHostProfile(owned);
          },
          clock: () => {
            if (mode === "nonfinite") return NaN;
            if (mode === "always" || cleaning) throw clockFailure;
            return 0;
          },
          report: (record) => reports.push(record),
        },
      ),
      (error) =>
        mode === "nonfinite"
          ? error instanceof AggregateError
          : containsFailure(error, clockFailure),
    );
    assert.equal(cleanups, 1);
    assert.equal(existsSync(profile.root), false);
    assert.ok(
      reports.some(
        (record) =>
          record.stage === "completed" && record.elapsedMs === undefined,
      ),
    );
  });
}

test("worker reporting and clock errors do not hide its SDK failure", async (t) => {
  const profile = profileFor(t);
  const primary = new Error("actual SDK exercise failure");
  const observer = new Error("worker reporter failure");
  const clockFailure = new Error("worker clock failure");
  let exercised = false;
  await assert.rejects(
    runHostWorker(
      { env: workerEnvironment(profile), directory: extensionDirectory },
      {
        command: async () => "",
        electron: {
          runTests: async () => {
            exercised = true;
            throw primary;
          },
        },
        clock: () => {
          throw clockFailure;
        },
        report: () => {
          throw observer;
        },
      },
    ),
    (error) => {
      for (const failure of [primary, observer, clockFailure])
        assert.ok(containsFailure(error, failure));
      return true;
    },
  );
  assert.equal(exercised, true);
  assert.equal(
    existsSync(profile.root),
    true,
    "the external parent retains directory ownership",
  );
});

/**
 * @template T
 * @param {Promise<T>} work
 * @param {Promise<unknown>} admission
 * @param {() => void} release
 * @param {() => void} inspect
 * @returns {Promise<{ok: true, value: T} | {ok: false, error: unknown}>}
 */
async function inspectParentAdmission(work, admission, release, inspect) {
  const outcome = work.then(
    /** @param {T} value @returns {{ok: true, value: T}} */
    (value) => ({ ok: true, value }),
    /** @param {unknown} error @returns {{ok: false, error: unknown}} */
    (error) => ({ ok: false, error }),
  );
  /** @type {unknown[]} */
  const failures = [];
  let result;
  try {
    await Promise.race([
      admission,
      outcome.then((value) => {
        if (!value.ok) throw value.error;
        throw new Error("Parent command settled before admission");
      }),
    ]);
    inspect();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
    result = await outcome;
    if (failures.length && !result.ok && !failures.includes(result.error))
      failures.push(result.error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Held parent test failed", {
      cause: failures[0],
    });
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, error: result.error };
}

for (const outcome of [
  "success",
  "released body failure",
  "unknown release",
  "busy cleanup",
]) {
  test(`SDK-visible input survives case cleanup until external owner settles: ${outcome}`, async (t) => {
    // The command dependency starts no native process. This directly exercises
    // the parent's ownership-result contract with real fixture directories;
    // the separate native owner tests prove the OS join behind that contract.
    const profile = profileFor(t);
    const parent = join(profile.workspaceRoot, "one");
    mkdirSync(parent);
    /** @type {string | undefined} */
    let fixture;
    /** @type {(() => void) | undefined} */
    let admit;
    const admitted = new Promise((resolve) => {
      admit = () => resolve(undefined);
    });
    /** @type {(() => void) | undefined} */
    let release;
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const primary = Object.assign(new Error("owned SDK body rejected"), {
      ownershipReleased: outcome !== "unknown release",
    });
    const busy = Object.assign(new Error("owned profile input is busy"), {
      code: "EBUSY",
    });
    /** @type {string[]} */
    const events = [];
    let joined = false;
    const pending = runHostProfile(
      { env: {} },
      {
        createProfile: () => profile,
        command: async (_name, _args, options) => {
          const env = commandEnvironment(options);
          try {
            fixture = await workspaceFixtureDirectory(
              parent,
              "saltbox-sdk-input-",
              {
                ...env,
                SALTBOX_TEST_WORKSPACE_PATH: profile.workspaceRoot,
              },
            );
            writeFileSync(join(fixture, "main.yml"), "owned SDK source\n");
            await withTestResources({ cleanupTimeoutMs: 5000 }, (owner) => {
              owner.defer("case state restoration", () => {
                events.push("case restored");
                assert.ok(
                  fixture && existsSync(fixture),
                  "case restoration cannot remove SDK-visible inputs",
                );
              });
            });
            assert.ok(admit);
            admit();
            await held;
            joined = true;
            events.push("external owner settled");
            if (outcome !== "success") throw primary;
            return "";
          } catch (error) {
            assert.ok(admit);
            admit();
            throw error;
          }
        },
        cleanupProfile: (owned) => {
          assert.equal(
            joined,
            true,
            "native owner must settle before deleting inputs",
          );
          assert.ok(fixture && existsSync(fixture));
          events.push("parent removal");
          if (outcome === "busy cleanup") throw busy;
          cleanupHostProfile(owned);
        },
        report() {},
      },
    );
    const result = await inspectParentAdmission(
      pending,
      admitted,
      () => {
        assert.ok(release);
        release();
      },
      () => {
        assert.ok(fixture && existsSync(fixture));
        assert.deepEqual(events, ["case restored"]);
      },
    );
    if (outcome === "success") assert.equal(result.ok, true);
    else if (outcome === "busy cleanup") {
      assert.equal(result.ok, false);
      assert.ok(result.error instanceof AggregateError);
      assert.equal(result.error.cause, primary);
      assert.equal(result.error.errors.length, 2);
      assert.equal(result.error.errors[0], primary);
      assert.equal(result.error.errors[1], busy);
      assert.equal(busy.code, "EBUSY");
      assert.equal(Reflect.get(result.error, "retainedProfile"), profile.root);
    } else {
      assert.equal(result.ok, false);
      assert.equal(result.error, primary);
    }
    if (outcome === "unknown release") {
      assert.deepEqual(events, ["case restored", "external owner settled"]);
      assert.ok(existsSync(profile.root));
      assert.ok(fixture && existsSync(fixture));
      assert.equal(Reflect.get(primary, "retainedProfile"), profile.root);
    } else if (outcome === "busy cleanup") {
      assert.deepEqual(events, [
        "case restored",
        "external owner settled",
        "parent removal",
      ]);
      assert.ok(existsSync(profile.root));
      assert.ok(fixture && existsSync(fixture));
    } else {
      assert.deepEqual(events, [
        "case restored",
        "external owner settled",
        "parent removal",
      ]);
      assert.equal(existsSync(profile.root), false);
      assert.ok(fixture);
      assert.equal(existsSync(fixture), false);
    }
  });
}

test("an actual parent failure before input admission is handled, released and joined", async (t) => {
  const profile = profileFor(t);
  const original = releasedError("parent failed before admission");
  let released = false;
  const pending = runHostProfile(
    { env: {} },
    {
      createProfile: () => profile,
      command: async () => {
        throw original;
      },
      report() {},
    },
  );
  await assert.rejects(
    inspectParentAdmission(
      pending,
      new Promise(() => {}),
      () => {
        released = true;
      },
      () =>
        assert.fail("failed command cannot reach its admission observation"),
    ),
    (error) => error === original,
  );
  assert.equal(released, true);
  assert.equal(existsSync(profile.root), false);
});

test("editor matrix results publish actual progress and the complete configured identity", async (t) => {
  const evidence = profileFor(t);
  const resultsFile = join(evidence.root, "results.json");
  let completed = 0;
  await runNativeHosts(
    {
      env: resultEnvironment,
      resultsFile,
      platform: "darwin",
      arch: "arm64",
      versions: hostVersions,
      modes: ["normal", "navigation"],
    },
    {
      download: async (version) => {
        const result = readHostResults(resultsFile);
        assert.equal(result.status, "running");
        assert.equal(
          result.profiles.filter((entry) => entry.status === "passed").length,
          completed,
        );
        return `/sdk/${version}`;
      },
      profile: async () => {
        const result = readHostResults(resultsFile);
        assert.equal(
          result.profiles.filter((entry) => entry.status === "running").length,
          1,
        );
        assert.equal(result.profiles[completed].status, "running");
        completed++;
      },
    },
  );
  const result = readHostResults(resultsFile);
  assert.deepEqual(result, {
    schemaVersion: 1,
    target: "darwin-arm64",
    commit: resultEnvironment.GITHUB_SHA,
    runId: resultEnvironment.GITHUB_RUN_ID,
    attempt: resultEnvironment.GITHUB_RUN_ATTEMPT,
    status: "passed",
    versions: [...hostVersions],
    modes: ["normal", "navigation"],
    profiles: hostVersions.flatMap((version) =>
      ["normal", "navigation"].map((mode) => ({
        version,
        mode,
        status: "passed",
      })),
    ),
  });
  assert.equal(completed, 4);
  assert.ok(!readFileSync(resultsFile, "utf8").includes("PRIVATE_INPUT"));
  assert.deepEqual(
    readdirSync(evidence.root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("editor matrix cannot count a profile as passed before its real cleanup joins", async (t) => {
  const evidence = profileFor(t);
  const profile = profileFor(t);
  const resultsFile = join(evidence.root, "results.json");
  /** @type {(() => void) | undefined} */
  let admit;
  const admitted = new Promise((resolve) => {
    admit = () => resolve(undefined);
  });
  /** @type {(() => void) | undefined} */
  let release;
  const held = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const pending = runNativeHosts(
    {
      env: resultEnvironment,
      resultsFile,
      versions: ["1.100.0"],
      modes: ["normal"],
    },
    {
      download: async () => "/sdk/1.100.0",
      createProfile: () => profile,
      createSupervisor: async () => undefined,
      command: async () => "",
      cleanupProfile: async (owned) => {
        assert.ok(admit);
        admit();
        await held;
        cleanupHostProfile(owned);
      },
      report() {},
    },
  );
  const result = await inspectParentAdmission(
    pending,
    admitted,
    () => {
      assert.ok(release);
      release();
    },
    () => {
      assert.ok(existsSync(profile.root));
      assert.equal(readHostResults(resultsFile).profiles[0].status, "running");
      assert.equal(readHostResults(resultsFile).status, "running");
    },
  );
  assert.equal(result.ok, true);
  assert.equal(existsSync(profile.root), false);
  assert.equal(readHostResults(resultsFile).profiles[0].status, "passed");
  assert.equal(readHostResults(resultsFile).status, "passed");
});

test("editor matrix preserves its first profile failure and leaves remaining cases unrun", async (t) => {
  const evidence = profileFor(t);
  const resultsFile = join(evidence.root, "results.json");
  const original = new Error("private profile failure details");
  let calls = 0;
  await assert.rejects(
    runNativeHosts(
      {
        env: resultEnvironment,
        resultsFile,
        versions: hostVersions,
        modes: ["normal", "navigation", "diagnostics"],
      },
      {
        download: async () => "/sdk",
        profile: async () => {
          if (++calls === 2) throw original;
        },
      },
    ),
    (error) => error === original,
  );
  const result = readHostResults(resultsFile);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.failure, {
    stage: "profile",
    version: "1.100.0",
    mode: "navigation",
  });
  assert.deepEqual(
    result.profiles.map((entry) => entry.status),
    ["passed", "failed", "not_run", "not_run", "not_run", "not_run"],
  );
  assert.equal(calls, 2);
  assert.ok(!readFileSync(resultsFile, "utf8").includes(original.message));
});

test("editor matrix download failure preserves completed editor profiles and admits no later profile", async (t) => {
  const evidence = profileFor(t);
  const resultsFile = join(evidence.root, "results.json");
  const original = new Error("private download failure");
  let calls = 0;
  await assert.rejects(
    runNativeHosts(
      {
        env: resultEnvironment,
        resultsFile,
        versions: hostVersions,
        modes: ["normal"],
      },
      {
        download: async (version) => {
          if (version === "1.137.0") throw original;
          return "/sdk";
        },
        profile: async () => {
          calls++;
        },
      },
    ),
    (error) => error === original,
  );
  assert.equal(calls, 1);
  const result = readHostResults(resultsFile);
  assert.deepEqual(result.failure, { stage: "download", version: "1.137.0" });
  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.profiles.map((entry) => entry.status),
    ["passed", "not_run"],
  );
});

test("editor matrix reporting is opt-in and leaves the filesystem boundary unused by default", async () => {
  let profiles = 0;
  const unused = () =>
    assert.fail("default execution cannot write a matrix result");
  await runNativeHosts(
    { versions: ["1.100.0"], modes: ["normal"] },
    {
      download: async () => "/sdk",
      profile: async () => {
        profiles++;
      },
      resultsIO: {
        write: unused,
        link: unused,
        rename: unused,
        remove: unused,
      },
    },
  );
  assert.equal(profiles, 1);
});

test("editor matrix initial publication preserves an existing file and removes its temporary", async (t) => {
  const evidence = profileFor(t);
  const resultsFile = join(evidence.root, "results.json");
  writeFileSync(resultsFile, "another owner's results\n");
  await assert.rejects(
    runNativeHosts(
      { resultsFile },
      {
        download: async () =>
          assert.fail("publication failure cannot admit a download"),
        profile: async () =>
          assert.fail("publication failure cannot admit a profile"),
      },
    ),
    { code: "EEXIST" },
  );
  assert.equal(readFileSync(resultsFile, "utf8"), "another owner's results\n");
  assert.deepEqual(
    readdirSync(evidence.root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("editor matrix partial write failure removes unpublished bytes before any admission", async (t) => {
  const evidence = profileFor(t);
  const resultsFile = join(evidence.root, "results.json");
  const original = Object.assign(new Error("controlled partial result write"), {
    code: "ENOSPC",
  });
  await assert.rejects(
    runNativeHosts(
      { resultsFile },
      {
        download: async () =>
          assert.fail("write failure cannot admit a download"),
        resultsIO: {
          ...realResultsIO,
          write: (filename, _bytes, options) => {
            writeFileSync(filename, "partial result", options);
            throw original;
          },
        },
      },
    ),
    (error) => error === original,
  );
  assert.equal(existsSync(resultsFile), false);
  assert.deepEqual(
    readdirSync(evidence.root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("editor matrix failed-status publication preserves both original errors and the previous checkpoint", async (t) => {
  const evidence = profileFor(t);
  const resultsFile = join(evidence.root, "results.json");
  const primary = new Error("actual profile rejection");
  const reporting = Object.assign(
    new Error("controlled result publication failure"),
    { code: "EACCES" },
  );
  await assert.rejects(
    runNativeHosts(
      { resultsFile, versions: ["1.100.0"], modes: ["normal", "navigation"] },
      {
        download: async () => "/sdk",
        profile: async () => {
          throw primary;
        },
        resultsIO: {
          ...realResultsIO,
          rename: (source, destination) => {
            if (readHostResults(String(source)).status === "failed")
              throw reporting;
            renameSync(source, destination);
          },
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, reporting]);
      return true;
    },
  );
  const result = readHostResults(resultsFile);
  assert.equal(result.status, "running");
  assert.deepEqual(
    result.profiles.map((entry) => entry.status),
    ["running", "not_run"],
  );
  assert.deepEqual(
    readdirSync(evidence.root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("editor matrix final publication failure cannot turn a successful profile into a passing invocation", async (t) => {
  const evidence = profileFor(t);
  const resultsFile = join(evidence.root, "results.json");
  const reporting = new Error("final result publication failed");
  let completed = 0;
  await assert.rejects(
    runNativeHosts(
      { resultsFile, versions: ["1.100.0"], modes: ["normal"] },
      {
        download: async () => "/sdk",
        profile: async () => {
          completed++;
        },
        resultsIO: {
          ...realResultsIO,
          rename: (source, destination) => {
            if (readHostResults(String(source)).status === "passed")
              throw reporting;
            renameSync(source, destination);
          },
        },
      },
    ),
    (error) => error === reporting,
  );
  assert.equal(completed, 1);
  const result = readHostResults(resultsFile);
  assert.equal(result.status, "running");
  assert.equal(result.profiles[0].status, "passed");
  assert.deepEqual(
    readdirSync(evidence.root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});
