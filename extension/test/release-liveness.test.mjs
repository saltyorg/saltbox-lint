// @ts-check
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { probeFixtureLifetime as probe } from "./support/fixture-lifetime.ts";
import { withTestResources } from "./support/test-resources.ts";
import { removeExecutedFixtureDirectory } from "./support/executed-fixture-directory.ts";
import { ownJoinedResource } from "./support/host-resources.ts";
import { stageBinary } from "../scripts/stage-binary.mjs";
import { createHostProcessSupervisor } from "../scripts/host-process-supervisor.mjs";
import { reserveProcess } from "../src/process-reservation.ts";
import {
  groupHasLiveMembers,
  liveGroupMembers,
} from "../scripts/owned-group.mjs";

const fixture = fileURLToPath(
  new URL("testdata/owned-builder.mjs", import.meta.url),
);
const outputFixture = fileURLToPath(
  new URL("testdata/owned-output.mjs", import.meta.url),
);
const denialGuardian = fileURLToPath(
  new URL("testdata/owned-denial-guardian.mjs", import.meta.url),
);
const groupQueryFixture = fileURLToPath(
  new URL("testdata/owned-group-query-fixture.mjs", import.meta.url),
);

/** @typedef {import("../scripts/owned-group.mjs").QueryError} QueryError */
/** @typedef {{error: QueryError | null, stdout: string, stderr: string}} QueryResult */
/** @typedef {{code: number | null, signal: NodeJS.Signals | null}} QueryClose */
/** @typedef {{file: string, args: readonly string[], options: import("node:child_process").ExecFileOptionsWithStringEncoding}} QueryRequest */
/** @typedef {{platform: NodeJS.Platform, execFile: (file: string, args: readonly string[], options: import("node:child_process").ExecFileOptionsWithStringEncoding, callback: (error: QueryError | null, stdout: string, stderr: string) => void) => import("node:child_process").ChildProcess}} QueryDependencies */
/** @typedef {{dependencies: QueryDependencies, requests: QueryRequest[], children: import("node:child_process").ChildProcess[], results: QueryResult[], closes: QueryClose[], entered: Promise<void>}} GroupQueryFixture */

/**
 * Run the actual observation interface against separately owned native queries.
 * The platform adapter exercises Darwin contracts on every source-test target;
 * the existing retained-zombie case still exercises that target's actual ps.
 * @template T
 * @param {string | readonly string[]} mode
 * @param {(fixture: GroupQueryFixture) => Promise<T>} body
 * @param {{earlyError?: QueryError, abortOnSpawn?: AbortController, missingExecutable?: boolean, platform?: NodeJS.Platform, holdBootstrap?: boolean, nodeOverflow?: boolean}} [control]
 */
async function withGroupQuery(mode, body, control = {}) {
  return withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
    const modes = typeof mode === "string" ? [mode] : mode;
    assert.ok(modes.length > 0);
    /** @type {string | undefined} */
    let overflowBinary;
    if (modes.includes("overflow") && !control.nodeOverflow) {
      const directory = mkdtempSync(join(tmpdir(), "saltbox-native-query-"));
      // The overflowing fixture executable runs from this directory. Removal
      // observes Windows image release within the 5s cleanup budget and
      // reports any release it had to wait for, so recurrences stay visible.
      resources.defer("native query fixture directory", async () => {
        const released = await removeExecutedFixtureDirectory(directory, 3000);
        if (released.attempts > 1)
          console.log(
            `saltbox-diagnostic native-query-fixture-release ${JSON.stringify(released)}`,
          );
      });
      overflowBinary = join(
        directory,
        "process-fixture" + (process.platform === "win32" ? ".exe" : ""),
      );
      await ownedCommand(
        "go",
        [
          "build",
          "-o",
          overflowBinary,
          fileURLToPath(
            new URL("testdata/process_fixture.go", import.meta.url),
          ),
        ],
        {
          phase: "native query fixture build",
          timeoutMs: 30000,
          env: { ...process.env, CGO_ENABLED: "0" },
        },
      );
    }
    /** @type {QueryRequest[]} */
    const requests = [];
    /** @type {import("node:child_process").ChildProcess[]} */
    const children = [];
    /** @type {QueryResult[]} */
    const results = [];
    /** @type {QueryClose[]} */
    const closes = [];
    /** @type {Promise<void>[]} */
    const joining = [];
    /** @type {{promise: Promise<void>, resolve: () => void, reject: (reason?: unknown) => void}} */
    const entered = Promise.withResolvers();
    ownJoinedResource(resources, "native process query probes", {
      dispose() {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          child.stdin?.end();
        }
      },
      async join() {
        await Promise.all(joining);
      },
    });
    /** @type {QueryDependencies} */
    const dependencies = {
      platform: control.platform ?? "darwin",
      execFile(file, args, options, callback) {
        const mode = modes[Math.min(requests.length, modes.length - 1)];
        requests.push({ file, args: [...args], options });
        let delivered = false;
        let executable = process.execPath;
        let parameters = [
          groupQueryFixture,
          mode,
          control.platform === "linux" ? "123" : args[1],
        ];
        if (mode === "overflow" && !control.nodeOverflow) {
          assert.ok(
            overflowBinary,
            "native output fixture is ready before query admission",
          );
          executable = overflowBinary;
          parameters = ["query-overflow"];
        }
        const child = execFile(
          control.missingExecutable
            ? `${groupQueryFixture}.missing-executable`
            : executable,
          parameters,
          control.holdBootstrap
            ? {
                ...options,
                env: { ...options.env, SALTBOX_TEST_QUERY_BOOTSTRAP_HOLD: "1" },
              }
            : options,
          (error, stdout, stderr) => {
            results.push({ error, stdout, stderr });
            if (!delivered) {
              delivered = true;
              callback(error, stdout, stderr);
            }
          },
        );
        children.push(child);
        joining.push(
          new Promise((resolve) => {
            child.once("close", (code, signal) => {
              closes.push({ code, signal });
              resolve();
            });
          }),
        );
        child.once("spawn", () => {
          if (control.earlyError) {
            delivered = true;
            callback(control.earlyError, "", "");
          }
          control.abortOnSpawn?.abort();
          entered.resolve();
        });
        child.once("error", () => entered.resolve());
        return child;
      },
    };
    return body({
      dependencies,
      requests,
      children,
      results,
      closes,
      entered: entered.promise,
    });
  });
}

/** @param {unknown} value */
function queryFailure(value) {
  assert.ok(value instanceof Error);
  assert.ok(
    "observation" in value &&
      value.observation &&
      typeof value.observation === "object",
  );
  const observation = value.observation;
  assert.ok("platform" in observation && observation.platform === "darwin");
  assert.ok("group" in observation && observation.group === 123);
  assert.ok(
    "elapsedMs" in observation &&
      typeof observation.elapsedMs === "number" &&
      observation.elapsedMs >= 0,
  );
  assert.ok(
    "stdoutBytes" in observation && typeof observation.stdoutBytes === "number",
  );
  assert.ok(
    "stderrBytes" in observation && typeof observation.stderrBytes === "number",
  );
  assert.ok("closeCode" in observation && "closeSignal" in observation);
  assert.ok("timeoutMs" in observation && observation.timeoutMs === 1000);
  assert.ok(
    "maxBufferBytes" in observation &&
      observation.maxBufferBytes === 4 * 1024 * 1024,
  );
  assert.ok(
    value.message.includes("process group query") &&
      value.message.length < 1500,
  );
  return { error: value, observation };
}

/** @typedef {{pid: number, port: number, token: string}} FixtureInstance */
/** @typedef {import("../scripts/owned-command.mjs").ClosedCommand} ClosedCommand */

/** @param {unknown} value */
function recordObject(value) {
  assert.ok(value && typeof value === "object", "fixture record is an object");
  return value;
}

/** @param {unknown} value @returns {FixtureInstance} */
function instanceRecord(value) {
  const record = recordObject(value);
  assert.ok("pid" in record && typeof record.pid === "number");
  assert.ok("port" in record && typeof record.port === "number");
  assert.ok("token" in record && typeof record.token === "string");
  return { pid: record.pid, port: record.port, token: record.token };
}

/** @param {unknown} value */
function pendingRecord(value) {
  const record = recordObject(value);
  assert.ok("token" in record && typeof record.token === "string");
  assert.ok("pending" in record && typeof record.pending === "boolean");
  return { ...record, token: record.token, pending: record.pending };
}

/** @param {string} filename @returns {{pid: number, nonce?: string}} */
function identityRecord(filename) {
  const record = recordObject(JSON.parse(readFileSync(filename, "utf8")));
  assert.ok("pid" in record && typeof record.pid === "number");
  const nonce = "nonce" in record ? record.nonce : undefined;
  assert.ok(nonce === undefined || typeof nonce === "string");
  return { pid: record.pid, nonce };
}

/** @param {unknown} value @returns {number[][]} */
function listenerCounts(value) {
  assert.ok(Array.isArray(value));
  return value.map((counts) => {
    assert.ok(Array.isArray(counts));
    return counts.map((count) => {
      assert.equal(typeof count, "number");
      return count;
    });
  });
}

/** @param {string} filename */
function outputResult(filename) {
  const record = recordObject(JSON.parse(readFileSync(filename, "utf8")));
  assert.ok("elapsed" in record && typeof record.elapsed === "number");
  assert.ok("settledAt" in record && typeof record.settledAt === "number");
  assert.ok("before" in record && "after" in record);
  const error = "error" in record ? record.error : undefined;
  assert.ok(error === undefined || typeof error === "string");
  return {
    error,
    elapsed: record.elapsed,
    settledAt: record.settledAt,
    before: listenerCounts(record.before),
    after: listenerCounts(record.after),
  };
}

/** @param {unknown} value @returns {import("../scripts/owned-command.mjs").CommandError} */
function commandError(value) {
  assert.ok(value instanceof Error);
  if ("exitCode" in value)
    assert.ok(value.exitCode == null || typeof value.exitCode === "number");
  if ("stderr" in value)
    assert.ok(value.stderr === undefined || typeof value.stderr === "string");
  if ("stdout" in value)
    assert.ok(value.stdout === undefined || typeof value.stdout === "string");
  if ("ownershipReleased" in value)
    assert.ok(
      value.ownershipReleased === undefined ||
        typeof value.ownershipReleased === "boolean",
    );
  return value;
}

/** @overload @param {string} filename @returns {Promise<FixtureInstance>} */
/** @template T @overload @param {string} filename @param {(value: unknown) => T} decode @returns {Promise<T>} */
/** @param {string} filename @param {(value: unknown) => unknown} [decode] @returns {Promise<unknown>} */
async function record(filename, decode = instanceRecord) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try {
      return decode(JSON.parse(readFileSync(filename, "utf8")));
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    await delay(10);
  }
  throw new Error(`Owned builder did not publish ${filename}`);
}

/** @param {FixtureInstance} instance @param {string} [request] */
async function running(instance, request) {
  const result = await probe(instance, request);
  if (result.state === "alive") return true;
  if (result.state === "endpoint-absent") return false;
  throw new Error(
    `Owned builder probe ${result.state}: ${result.error ?? "foreign credential"}`,
  );
}

// Exit observation requires a refused connection, never a reset, timeout or
// foreign credential. Callers also verify the owned child/group has exited.
/** @param {FixtureInstance} instance @param {string} [request] */
async function endpointAbsent(instance, request) {
  const until = Date.now() + 1000;
  let result;
  do {
    result = await probe(instance, request);
    if (result.state === "endpoint-absent") return true;
    await delay(10);
  } while (Date.now() < until);
  throw new Error(
    `Owned builder endpoint absence was not confirmed: ${result.state}`,
  );
}

/**
 * @typedef {{directory: string, guardian: () => Promise<FixtureInstance>, refused: () => Promise<FixtureInstance>, release: () => Promise<void>, launch: (command: string, args: string[], options: import("../scripts/owned-command.mjs").OwnedCommandOptions) => ReturnType<typeof ownedCommand>}} DenialFixture
 */

/** @template T @param {(fixture: DenialFixture) => Promise<T>} body @returns {Promise<T>} */
async function withDeniedGuardian(body) {
  return withTestResources({ cleanupTimeoutMs: 15000 }, async (resources) => {
    const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-denial-"));
    resources.defer("denial fixture files", () =>
      rmSync(directory, { recursive: true, force: true }),
    );
    const filename = join(directory, "guardian.json");
    const nonce = randomBytes(32).toString("hex");
    /** @type {Promise<unknown>[]} */
    const admitted = [];
    const guardian = async () => {
      const instance = await record(filename);
      assert.equal(
        instance.token,
        nonce,
        "the guardian belongs to this invocation",
      );
      return instance;
    };
    const release = async () => {
      if (!admitted.length) return;
      const instance = await guardian();
      const result = await probe(instance, `release ${instance.token}\n`);
      assert.ok(
        result.state === "alive" || result.state === "endpoint-absent",
        `authenticated guardian release: ${result.state}`,
      );
    };
    /** @type {Promise<{ok: true} | {ok: false, error: unknown}> | undefined} */
    let releasing;
    ownJoinedResource(resources, "native denial guardian", {
      dispose() {
        releasing ??= release().then(
          () => ({ ok: true }),
          (error) => ({ ok: false, error }),
        );
      },
      async join() {
        const releaseResult = await releasing;
        await Promise.all(admitted);
        if (releaseResult && !releaseResult.ok) throw releaseResult.error;
        if (admitted.length) {
          const instance = await guardian();
          assert.equal(
            await endpointAbsent(instance, `probe ${instance.token}\n`),
            true,
          );
          assert.equal(
            await groupHasLiveMembers(instance.pid),
            false,
            "the exact guardian group is gone before files are removed",
          );
        }
      },
    });
    return body({
      directory,
      guardian,
      release,
      async refused() {
        const instance = await guardian();
        const rejection = await record(filename + ".refused", recordObject);
        assert.ok(
          "pid" in rejection && "token" in rejection && "refusals" in rejection,
        );
        assert.equal(rejection.pid, instance.pid);
        assert.equal(rejection.token, nonce);
        assert.equal(
          rejection.refusals,
          1,
          "the first actual guardian stop was refused",
        );
        assert.equal(
          await running(instance, `probe ${instance.token}\n`),
          true,
        );
        return instance;
      },
      launch(command, args, options) {
        resources.signal.throwIfAborted();
        const pending = ownedCommand(
          command,
          args,
          {
            ...options,
            signal: resources.signal,
            env: {
              ...process.env,
              ...options.env,
              SALTBOX_TEST_GUARDIAN_RECORD: filename,
              SALTBOX_TEST_GUARDIAN_NONCE: nonce,
            },
          },
          { guardianPath: denialGuardian },
        );
        // Expected native failures are inspected by the body; this owner joins
        // every actual command result before considering its tree released.
        admitted.push(
          pending.then(
            () => undefined,
            (error) => error,
          ),
        );
        return pending;
      },
    });
  });
}

/** @param {unknown} error */
function deniedCleanup(error) {
  assert.ok(error instanceof Error);
  assert.equal(error.message, "kill EPERM control");
  assert.ok("code" in error && "syscall" in error);
  assert.equal(error.code, "EPERM");
  assert.equal(error.syscall, "kill");
}

test("POSIX observer retains a live worker after its main thread exits", async () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-thread-"));
  const filename = join(directory, "thread.json");
  const binary = join(directory, "fixture");
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;
  /** @type {Promise<ClosedCommand> | undefined} */
  let closed;
  try {
    await ownedCommand(
      "cc",
      [
        "-pthread",
        "-o",
        binary,
        fileURLToPath(new URL("testdata/owned-thread.c", import.meta.url)),
      ],
      { phase: "thread fixture build", timeoutMs: 30000 },
    );
    const started = spawn(binary, [filename, randomBytes(32).toString("hex")], {
      detached: true,
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 45000,
      killSignal: "SIGKILL",
    });
    child = started;
    started.stderr.resume();
    closed = new Promise((resolve, reject) => {
      started.once("error", reject);
      started.once("close", (code, signal) => resolve({ code, signal }));
    });
    const instance = await record(filename);
    assert.equal(await running(instance, "probe\n"), true);
    assert.equal(await groupHasLiveMembers(instance.pid), true);
    const trigger = createConnection({
      host: "127.0.0.1",
      port: instance.port,
    });
    /** @type {Promise<void>} */
    const mainExited = new Promise((resolve, reject) => {
      let response = "";
      trigger.setTimeout(1000, () =>
        trigger.destroy(new Error("Main-thread exit probe timed out")),
      );
      trigger.once("error", reject);
      trigger.on("data", (bytes) => (response += bytes.toString("ascii")));
      trigger.once("end", () => {
        trigger.destroy();
        try {
          assert.equal(
            response,
            instance.token + "\n",
            "worker joined the exited main thread",
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      trigger.end("exit-main\n");
    });
    await mainExited;
    if (process.platform === "linux") {
      const until = Date.now() + 5000;
      let state;
      do {
        state = execFileSync(
          "/bin/ps",
          ["-p", String(instance.pid), "-o", "s="],
          { encoding: "utf8", timeout: 1000 },
        ).trim();
        if (state !== "Z") await delay(10);
      } while (state !== "Z" && Date.now() < until);
      assert.equal(state, "Z", "actual Linux leader is an unreaped zombie");
    }
    assert.equal(
      await running(instance, "probe\n"),
      true,
      "exact live worker endpoint answers",
    );
    assert.equal(
      await groupHasLiveMembers(instance.pid),
      true,
      "leader state cannot hide the live worker",
    );
    trigger.destroy();
  } finally {
    child?.stdin?.end();
    if (closed)
      assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
    if (child?.pid) {
      const instance = await record(filename);
      assert.equal(
        await endpointAbsent(instance, "probe\n"),
        true,
        "exact killed worker endpoint is absent",
      );
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("group snapshots prove complete Linux zombie coverage and support Darwin states", () => {
  assert.equal(
    liveGroupMembers("123 123 123 1 Z\n456 456 456 1 S\n", 123, "linux"),
    false,
  );
  for (const state of ["D", "R", "S", "T", "t", "W", "X", "I"]) {
    assert.equal(
      liveGroupMembers(
        `123 123 123 2 Z\n123 123 124 2 ${state}\n`,
        123,
        "linux",
      ),
      true,
    );
  }
  assert.equal(liveGroupMembers("456 456 456 1 S\n", 123, "linux"), false);
  for (const snapshot of [
    "123 123 123 2 Z\n",
    "123 123 124 1 Z\n",
    "123 123 123 2 Z\n123 123 124 1 Z\n",
    "123 123 123 1 Z\n123 123 124 1 Z\n",
    "123 123 123 2 Z\n456 456 456 1 S\n",
    "123 123 123 1 Z\n123 124 125 1 Z\n",
  ])
    assert.equal(
      liveGroupMembers(snapshot, 123, "linux"),
      true,
      "valid incomplete owned thread coverage cannot prove disappearance",
    );
  assert.equal(
    liveGroupMembers("123 123 123 2 Z\n123 123 124 2 Z\n", 123, "linux"),
    false,
    "every advertised owned thread is present and defunct",
  );
  for (const snapshot of [
    "123 123 123 2 Z\n123 123 123 2 Z\n",
    "123 123 123 1 S\n123 123 123 2 Z\n",
    "123 123 123 2 Z\nmalformed\n",
    "123 123 123 1 S\nmalformed\n",
    "123 123 123 0 Z\n",
    "123 0 0 1 Z\n",
    "123 9007199254740992 123 1 Z\n",
    "123 123 123 1 Z?\n",
    "123 123 123 1 Zombie\n",
    "123 123 123 1 Z+\n",
    "123 123 123 1 Z",
  ])
    assert.throws(() => liveGroupMembers(snapshot, 123, "linux"), /snapshot/);
  assert.equal(
    liveGroupMembers("123 123 Z\n123 124 Z+\n456 456 S\n", 123, "darwin"),
    false,
  );
  for (const state of [
    "R",
    "S",
    "T",
    "U",
    "I",
    "H",
    "?",
    "HN",
    "?XEs+",
    "Ss+",
    "U<",
    "SNXEVLs+",
  ]) {
    assert.equal(
      liveGroupMembers(`123 123 Z\n123 124 ${state}\n`, 123, "darwin"),
      true,
    );
  }
  assert.equal(
    liveGroupMembers("456 456 ?\n", 123, "darwin"),
    false,
    "a verified unavailable task outside the owned group cannot hide its members",
  );
  assert.throws(
    () => liveGroupMembers(`123 123 R${"x".repeat(4096)}\n`, 123, "darwin"),
    (error) =>
      error instanceof Error &&
      error.message.includes("darwin, owned group 123") &&
      error.message.includes("123 123 Rx") &&
      error.message.length < 400,
    "malformed rows retain bounded observation identity",
  );
  for (const snapshot of [
    "123 123 Z?\n",
    "123 123 Zombie\n",
    "123 123 Z++\n",
    "123 123 Zs<\n",
    "123 123 ZE\n",
    "123 123 Z\n123 123 Z\n",
  ]) {
    assert.throws(
      () => liveGroupMembers(snapshot, 123, "darwin"),
      /snapshot|Duplicate/,
    );
  }
  /** @type {NodeJS.Platform[]} */
  const platforms = ["linux", "darwin"];
  for (const platform of platforms) {
    assert.throws(
      () => liveGroupMembers("123\n", 123, platform),
      /Unrecognized/,
    );
    assert.throws(() => liveGroupMembers("\n", 123, platform), /Empty/);
    assert.throws(() => liveGroupMembers("123 Z\n", 0, platform), /Invalid/);
  }
  assert.throws(
    () => liveGroupMembers("123 Z\n", 123, "freebsd"),
    /requires Linux or Darwin/,
  );
});

for (const final of ["linux-zombie", "linux-absent"]) {
  test(`Linux supervisor waits for ${final} proof after partial zombie coverage`, async () => {
    await withGroupQuery(
      ["linux-partial", final],
      async (f) => {
        /** @type {boolean[]} */
        const observations = [];
        const supervisor = await createHostProcessSupervisor({
          platform: "linux",
          async observeGroup(group, signal) {
            assert.equal(group, 123);
            const value = await groupHasLiveMembers(
              group,
              signal,
              f.dependencies,
            );
            assert.equal(f.closes.length, f.requests.length);
            observations.push(value);
            return value;
          },
        });
        assert.ok(supervisor);
        try {
          const owner = await reserveProcess(
            supervisor.environment,
            new AbortController().signal,
          );
          await owner.completeJoinedChild(123);
          const result = await supervisor.finish();
          assert.equal(result.released, true);
          assert.deepEqual(observations, [true, false]);
          assert.equal(f.requests.length, 2);
          assert.deepEqual(f.closes, [
            { code: 0, signal: null },
            { code: 0, signal: null },
          ]);
          for (const request of f.requests) {
            assert.equal(request.file, "/bin/ps");
            assert.deepEqual(request.args, [
              "-A",
              "-L",
              "-o",
              "pgid=,pid=,lwp=,nlwp=,s=",
            ]);
            assert.equal(request.options.timeout, 1000);
            assert.equal(request.options.maxBuffer, 4 * 1024 * 1024);
          }
        } finally {
          await supervisor.finish().catch(() => {});
        }
      },
      { platform: "linux" },
    );
  });
}

test("Linux supervisor retains permanently partial groups until its cleanup deadline", async () => {
  await withGroupQuery(
    "linux-partial",
    async (f) => {
      let partial = 0;
      /** @type {AbortSignal | undefined} */
      let cleanupSignal;
      const supervisor = await createHostProcessSupervisor({
        platform: "linux",
        cleanupTimeoutMs: 3000,
        async observeGroup(group, signal) {
          cleanupSignal = signal;
          const value = await groupHasLiveMembers(
            group,
            signal,
            f.dependencies,
          );
          assert.equal(value, true, "partial coverage never proves release");
          partial++;
          return value;
        },
      });
      assert.ok(supervisor);
      try {
        const owner = await reserveProcess(
          supervisor.environment,
          new AbortController().signal,
        );
        await owner.completeJoinedChild(123);
        await assert.rejects(supervisor.finish());
        assert.ok(
          partial > 0,
          "the real query observed partial zombie coverage",
        );
        assert.ok(cleanupSignal);
        assert.equal(cleanupSignal.aborted, true);
        assert.ok(
          cleanupSignal.reason instanceof Error &&
            cleanupSignal.reason.message.includes("cleanup exceeded 3000ms"),
        );
        assert.equal(f.closes.length, f.requests.length);
        assert.ok(
          f.children.every(
            (child) => child.exitCode !== null || child.signalCode !== null,
          ),
          "all admitted native queries joined before failure",
        );
      } finally {
        await supervisor.finish().catch(() => {});
      }
    },
    { platform: "linux" },
  );
});

test("Linux supervisor keeps query errors terminal after an incomplete observation", async () => {
  for (const mode of [
    "linux-malformed",
    "linux-duplicate",
    "linux-no-newline",
    "stderr",
    "other-exit",
    "empty",
  ]) {
    await withGroupQuery(
      ["linux-partial", mode],
      async (f) => {
        /** @type {boolean[]} */
        const observations = [];
        /** @type {unknown} */
        let original;
        const supervisor = await createHostProcessSupervisor({
          platform: "linux",
          async observeGroup(group, signal) {
            try {
              const value = await groupHasLiveMembers(
                group,
                signal,
                f.dependencies,
              );
              observations.push(value);
              return value;
            } catch (error) {
              original = error;
              throw error;
            }
          },
        });
        assert.ok(supervisor);
        try {
          const owner = await reserveProcess(
            supervisor.environment,
            new AbortController().signal,
          );
          await owner.completeJoinedChild(123);
          await assert.rejects(supervisor.finish(), (error) => {
            assert.equal(error, original, "retain the exact failed query");
            assert.ok(error instanceof Error);
            assert.match(error.message, /Owned process group query failed/);
            return true;
          });
          assert.deepEqual(observations, [true]);
          assert.equal(f.requests.length, 2, `${mode} is not retried`);
          assert.equal(f.closes.length, 2);
          assert.equal(f.results.length, 2);
        } finally {
          await supervisor.finish().catch(() => {});
        }
      },
      { platform: "linux" },
    );
  }
});

test("Darwin process query selects only its owned group in a private Unix 2003 environment", async () => {
  const parentMode = process.env.COMMAND_MODE;
  const parentLocale = process.env.LC_ALL;
  await withGroupQuery("live", async (f) => {
    const live = await groupHasLiveMembers(123, undefined, f.dependencies);
    assert.equal(
      f.requests.length,
      1,
      "the observation uses its per-instance native query adapter",
    );
    const request = f.requests[0];
    assert.equal(request.file, "/bin/ps");
    assert.deepEqual(request.args, [
      "-g",
      "123",
      "-x",
      "-o",
      "pgid=,pid=,state=",
    ]);
    assert.equal(request.options.timeout, 1000);
    assert.equal(request.options.killSignal, "SIGKILL");
    assert.equal(request.options.maxBuffer, 4 * 1024 * 1024);
    assert.notEqual(request.options.env, process.env);
    assert.equal(request.options.env?.COMMAND_MODE, "unix2003");
    assert.equal(request.options.env?.LC_ALL, "C");
    assert.equal(process.env.COMMAND_MODE, parentMode);
    assert.equal(process.env.LC_ALL, parentLocale);
    assert.equal(live, true, "the exact selected native group is live");
    assert.deepEqual(f.closes, [{ code: 0, signal: null }]);
  });
  await withGroupQuery("zombie", async (f) => {
    assert.equal(
      await groupHasLiveMembers(123, undefined, f.dependencies),
      false,
    );
    assert.deepEqual(f.closes, [{ code: 0, signal: null }]);
  });
});

test("Darwin process query accepts only joined empty exit one as no match", async () => {
  await withGroupQuery("absent", async (f) => {
    assert.equal(
      await groupHasLiveMembers(123, undefined, f.dependencies),
      false,
    );
    assert.deepEqual(f.closes, [{ code: 1, signal: null }]);
    assert.equal(f.results[0].error?.code, 1);
    assert.equal(f.results[0].error?.killed, false);
    assert.equal(f.results[0].stdout, "");
    assert.equal(f.results[0].stderr, "");
  });
  for (const mode of [
    "empty",
    "other-exit",
    "stderr",
    "absent-stderr",
    "failed-row",
    "wrong-group",
    "malformed",
  ]) {
    await withGroupQuery(mode, async (f) => {
      await assert.rejects(
        groupHasLiveMembers(123, undefined, f.dependencies),
        (failure) => {
          const { error, observation } = queryFailure(failure);
          assert.equal(
            f.closes.length,
            1,
            `${mode} settled after its native close`,
          );
          assert.equal(observation.closeCode, f.closes[0].code);
          assert.equal(observation.closeSignal, f.closes[0].signal);
          assert.equal(
            observation.stdoutBytes,
            Buffer.byteLength(f.results[0].stdout),
          );
          assert.equal(
            observation.stderrBytes,
            Buffer.byteLength(f.results[0].stderr),
          );
          if (f.results[0].error) assert.equal(error.cause, f.results[0].error);
          return true;
        },
      );
    });
  }
});

test("process group validation rejects unsafe identities before native admission", async () => {
  await withGroupQuery("live", async (f) => {
    for (const group of [0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
      await assert.rejects(
        groupHasLiveMembers(group, undefined, f.dependencies),
        /Invalid owned process group/,
      );
    await assert.rejects(
      groupHasLiveMembers(123, undefined, {
        ...f.dependencies,
        platform: "freebsd",
      }),
      /requires Linux or Darwin/,
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.children.length, 0);
  });
});

test("process query failure retains bounded native timeout overflow cancellation and spawn evidence", async () => {
  for (const mode of ["hold", "overflow"]) {
    await withGroupQuery(mode, async (f) => {
      await assert.rejects(
        groupHasLiveMembers(123, undefined, f.dependencies),
        (failure) => {
          const { error, observation } = queryFailure(failure);
          assert.equal(error.cause, f.results[0].error);
          assert.equal(f.closes.length, 1);
          assert.equal(observation.closeCode, f.closes[0].code);
          assert.equal(observation.closeSignal, f.closes[0].signal);
          if (mode === "hold") {
            assert.equal(f.results[0].error?.killed, true);
            assert.equal(observation.closeSignal, "SIGKILL");
            assert.ok("killed" in observation && observation.killed === true);
          } else {
            assert.equal(
              f.results[0].error?.code,
              "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            );
            assert.ok(
              "code" in observation &&
                observation.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            );
            assert.ok(typeof observation.stdoutBytes === "number");
            assert.ok(observation.stdoutBytes <= 4 * 1024 * 1024);
          }
          return true;
        },
      );
    });
  }
  const aborted = new AbortController();
  await withGroupQuery(
    "hold",
    async (f) => {
      await assert.rejects(
        groupHasLiveMembers(123, aborted.signal, f.dependencies),
        (failure) => {
          const { error, observation } = queryFailure(failure);
          assert.equal(error.cause, f.results[0].error);
          assert.equal(f.results[0].error?.code, "ABORT_ERR");
          assert.ok("aborted" in observation && observation.aborted === true);
          assert.equal(f.closes.length, 1);
          return true;
        },
      );
    },
    { abortOnSpawn: aborted },
  );
  await withGroupQuery(
    "live",
    async (f) => {
      await assert.rejects(
        groupHasLiveMembers(123, undefined, f.dependencies),
        (failure) => {
          const { error, observation } = queryFailure(failure);
          assert.equal(error.cause, f.results[0].error);
          assert.equal(f.results[0].error?.code, "ENOENT");
          assert.ok("code" in observation && observation.code === "ENOENT");
          assert.equal(f.closes.length, 1);
          return true;
        },
      );
    },
    { missingExecutable: true },
  );
});

test("native query overflow remains independent of blocked Node fixture bootstrap", async () => {
  for (const nodeOverflow of [true, false]) {
    await withGroupQuery(
      "overflow",
      async (f) => {
        await assert.rejects(
          groupHasLiveMembers(123, undefined, f.dependencies),
          (failure) => {
            const { error, observation } = queryFailure(failure);
            assert.equal(error.cause, f.results[0].error);
            assert.equal(f.requests[0].options.timeout, 1000);
            assert.equal(f.requests[0].options.maxBuffer, 4 * 1024 * 1024);
            assert.equal(f.closes.length, 1);
            if (nodeOverflow) {
              assert.equal(f.children[0].spawnfile, process.execPath);
              assert.equal(f.results[0].error?.killed, true);
              assert.equal(observation.closeSignal, "SIGKILL");
            } else {
              assert.notEqual(f.children[0].spawnfile, process.execPath);
              assert.equal(
                f.results[0].error?.code,
                "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              );
              assert.ok(
                "code" in observation &&
                  observation.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              );
              assert.ok(typeof observation.stdoutBytes === "number");
              assert.ok(observation.stdoutBytes <= 4 * 1024 * 1024);
            }
            return true;
          },
        );
      },
      { holdBootstrap: true, nodeOverflow },
    );
  }
});

test("process query joins the exact native close after an early exit-one callback", async () => {
  /** @type {QueryError} */
  const original = Object.assign(new Error("early native query error"), {
    code: 1,
    killed: false,
    signal: null,
  });
  await withGroupQuery(
    "hold",
    async (f) => {
      let settled = false;
      /** @param {boolean} value @returns {{ok: true, value: boolean}} */
      const fulfilled = (value) => ({ ok: true, value });
      /** @param {unknown} error @returns {{ok: false, error: unknown}} */
      const rejected = (error) => ({ ok: false, error });
      const outcome = groupHasLiveMembers(123, undefined, f.dependencies)
        .then(fulfilled, rejected)
        .finally(() => {
          settled = true;
        });
      try {
        await f.entered;
        await Promise.resolve();
        assert.equal(settled, false, "a callback does not prove native close");
        assert.equal(f.closes.length, 0);
      } finally {
        for (const child of f.children) child.stdin?.end();
      }
      const result = await outcome;
      assert.equal(
        result.ok,
        false,
        "exit-one callback with native exit zero is not no-match",
      );
      if (result.ok) throw new Error("Unqualified absence result");
      const { error, observation } = queryFailure(result.error);
      assert.equal(error.cause, original);
      assert.equal(observation.closeCode, 0);
      assert.deepEqual(f.closes, [{ code: 0, signal: null }]);
    },
    { earlyError: original },
  );
});

test("POSIX group observation rejects cancellation and distinguishes a real retained zombie", async () => {
  if (process.platform === "win32") {
    await assert.rejects(groupHasLiveMembers(123), /requires Linux or Darwin/);
    return;
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(groupHasLiveMembers(process.pid, aborted.signal), {
    code: "ABORT_ERR",
  });
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-zombie-"));
  const filename = join(directory, "child.json");
  const binary = join(directory, "fixture");
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let supervisor;
  /** @type {Promise<ClosedCommand> | undefined} */
  let exited;
  /** @type {FixtureInstance | undefined} */
  let instance;
  try {
    await ownedCommand(
      "go",
      [
        "build",
        "-o",
        binary,
        fileURLToPath(new URL("testdata/owned-zombie.go", import.meta.url)),
      ],
      { phase: "zombie fixture build", timeoutMs: 30000 },
    );
    const started = spawn(binary, ["parent", filename], {
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 45000,
    });
    supervisor = started;
    exited = new Promise((resolve, reject) => {
      started.once("error", reject);
      started.once("close", (code, signal) => resolve({ code, signal }));
    });
    instance = await record(filename);
    assert.equal(await running(instance), true);
    assert.equal(await groupHasLiveMembers(instance.pid), true);
    writeFileSync(filename + ".exit", "");
    const until = Date.now() + 5000;
    let state;
    do {
      const snapshot = execFileSync(
        "/bin/ps",
        ["-p", String(instance.pid), "-o", "pid=,ppid=,pgid=,uid=,state="],
        {
          encoding: "utf8",
          timeout: 1000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
          env: { ...process.env, LC_ALL: "C" },
        },
      );
      const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*\n$/.exec(
        snapshot,
      );
      assert.ok(row, "complete single child process record");
      assert.ok(process.geteuid, "POSIX exposes the effective owner identity");
      assert.deepEqual(
        row.slice(1, 5).map(Number),
        [instance.pid, started.pid, instance.pid, process.geteuid()],
        "exact child remains owned by its supervisor in its original group",
      );
      state = row[5];
      if (!state.startsWith("Z")) await delay(10);
    } while (!state.startsWith("Z") && Date.now() < until);
    assert.match(state, /^Z/, "supervisor has not reaped the actual child");
    // Darwin's group signal check excludes SZOMB members and returns EPERM
    // even for our own retained child. The exact ps row proves membership.
    assert.equal(
      await endpointAbsent(instance),
      true,
      "exact child endpoint is absent",
    );
    assert.equal(
      await groupHasLiveMembers(instance.pid),
      false,
      "zombies do not extend cleanup",
    );
    started.stdin.end("reap\n");
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    supervisor?.stdin?.end("reap\n");
    if (exited) await exited;
    if (instance) {
      assert.equal(await endpointAbsent(instance), true);
      assert.equal(await groupHasLiveMembers(instance.pid), false);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release exit probes keep connected resets and foreign credentials inconclusive", async () => {
  const token = randomBytes(32).toString("hex");
  const server = createServer((socket) => {
    socket.once("data", (bytes) => {
      if (bytes.toString() === "reset\n") socket.resetAndDestroy();
      else socket.end(token + "\n");
    });
  });
  /** @type {Promise<void>} */
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const instance = { pid: process.pid, port: address.port, token };
  try {
    assert.equal(await running(instance, "probe\n"), true);
    const reset = await probe(instance, "reset\n");
    assert.equal(reset.state, "unavailable");
    assert.equal(reset.error, "ECONNRESET");
    assert.equal(
      await running(instance, "probe\n"),
      true,
      "reset did not stop the owned listener",
    );
    assert.equal(
      (
        await probe(
          { ...instance, token: randomBytes(32).toString("hex") },
          "probe\n",
        )
      ).state,
      "mismatch",
    );
  } finally {
    /** @type {Promise<void>} */
    const closed = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closed;
  }
  assert.equal(await endpointAbsent(instance, "probe\n"), true);
});

test("release probes preserve output and identify command failures", async () => {
  assert.equal(
    await ownedCommand(
      process.execPath,
      ["-e", 'process.stdout.write("release")'],
      {
        phase: "version control",
        timeoutMs: 30000,
      },
    ),
    "release",
  );
  await assert.rejects(
    ownedCommand(
      process.execPath,
      ["-e", 'console.error("builder failure"); process.exit(7)'],
      {
        phase: "metadata control",
        timeoutMs: 30000,
      },
    ),
    (error) => {
      const failure = commandError(error);
      assert.match(
        failure.message,
        /metadata control: .*owned (?:Job launcher )?PID \d+.*exited 7\nbuilder failure/s,
      );
      assert.equal(failure.ownershipReleased, true);
      return true;
    },
  );
  await assert.rejects(
    ownedCommand("saltbox-missing-owned-builder", [], {
      phase: "spawn control",
      timeoutMs: 30000,
    }),
    /spawn control: .*ENOENT/s,
  );
});

test("owned checks retain exit codes and join owner-cancelled descendants", async () => {
  assert.equal(
    await ownedCommand(process.execPath, ["-e", "process.exit(23)"], {
      phase: "exit-code control",
      returnExitCode: true,
    }),
    23,
  );
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-check-"));
  const filename = join(directory, "builder.json");
  const controller = new AbortController();
  const result = ownedCommand(process.execPath, [fixture, "tree", filename], {
    phase: "owner cancellation control",
    signal: controller.signal,
    returnExitCode: true,
  }).catch(commandError);
  try {
    const parent = await record(filename);
    const child = await record(filename + ".child");
    assert.equal(await running(parent), true);
    assert.equal(await running(child), true);
    const reason = new Error("scope owner stopped");
    controller.abort(reason);
    const error = await result;
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /owner cancellation control: .*interrupted by owner/s,
    );
    assert.equal(error.cause, reason);
    assert.equal(await running(parent), false);
    assert.equal(await running(child), false);
  } finally {
    controller.abort();
    await result;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source capture preserves NUL records and fails on overflow", async () => {
  const bytes = "go.mod\0source with spaces.go\0source\nnewline.go\0";
  assert.equal(
    await ownedCommand(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(bytes)})`],
      { phase: "source records control", maxOutputBytes: 4096 },
    ),
    bytes,
  );
  await assert.rejects(
    ownedCommand(
      process.execPath,
      ["-e", 'process.stdout.write(Buffer.alloc(2048, "x"))'],
      {
        phase: "source overflow control",
        maxOutputBytes: 1024,
        returnExitCode: true,
      },
    ),
    /source overflow control: .*output exceeds 1024 bytes/s,
  );
});

test("successful capture still rejects a denied owned group cleanup", async () => {
  if (process.platform === "win32") return;
  await withDeniedGuardian(async (f) => {
    const filename = join(f.directory, "builder.json");
    let settled = false;
    const result = f
      .launch(
        process.execPath,
        [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(filename)}, JSON.stringify({ pid: process.pid })); process.stdout.write("ok")`,
        ],
        { phase: "successful capture cleanup control", timeoutMs: 30000 },
      )
      .then(
        (value) => {
          settled = true;
          return { ok: true, value };
        },
        (error) => {
          settled = true;
          return { ok: false, error: commandError(error) };
        },
      );
    const guardian = await f.refused();
    assert.equal(await groupHasLiveMembers(guardian.pid), true);
    assert.equal(settled, false, "refusal cannot establish group release");
    await f.release();
    const outcome = await result;
    assert.equal(outcome.ok, false);
    assert.ok("error" in outcome);
    assert.match(outcome.error.message, /owned group cleanup failed/);
    deniedCleanup(outcome.error.cause);
    assert.equal(outcome.error instanceof AggregateError, false);
    assert.equal(outcome.error.ownershipReleased, false);
    assert.equal(await groupHasLiveMembers(guardian.pid), false);
  });
});

test("ordinary command exits preserve failures alongside denied cleanup", async () => {
  if (process.platform === "win32") return;
  for (const code of [0, 3]) {
    for (const returnExitCode of [false, true]) {
      await withDeniedGuardian(async (f) => {
        const filename = join(f.directory, "builder.json");
        const nonce = randomBytes(16).toString("hex");
        let settled = false;
        const result = f
          .launch(
            process.execPath,
            [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(filename)}, JSON.stringify({ pid: process.pid, nonce: ${JSON.stringify(nonce)} })); process.stderr.write("ordinary failure detail\\n"); process.exit(${code})`,
            ],
            {
              phase: "ordinary exit cleanup control",
              timeoutMs: 30000,
              returnExitCode,
            },
          )
          .then(
            (value) => {
              settled = true;
              return { ok: true, value };
            },
            (error) => {
              settled = true;
              return { ok: false, error: commandError(error) };
            },
          );
        const guardian = await f.refused();
        assert.equal(identityRecord(filename).nonce, nonce);
        assert.equal(await groupHasLiveMembers(guardian.pid), true);
        assert.equal(
          settled,
          false,
          "refused cleanup retains actual group ownership",
        );
        await f.release();
        const outcome = await result;
        assert.equal(outcome.ok, false);
        assert.ok("error" in outcome);
        const error = outcome.error;
        if (code !== 0 && !returnExitCode) {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          const [primary, cleanup] = error.errors.map(commandError);
          assert.notEqual(primary, cleanup);
          assert.equal(primary.exitCode, code);
          assert.equal(primary.stderr, "ordinary failure detail\n");
          assert.match(primary.message, /exited 3\nordinary failure detail/);
          assert.match(cleanup.message, /owned group cleanup failed/);
          deniedCleanup(cleanup.cause);
          assert.equal(
            error.cause,
            primary,
            "outer aggregate preserves its original primary Error",
          );
          assert.match(
            error.message,
            /exited 3\nordinary failure detail.*owned group cleanup failed/s,
          );
        } else {
          assert.equal(error instanceof AggregateError, false);
          assert.match(error.message, /owned group cleanup failed/);
          deniedCleanup(error.cause);
          assert.equal(error.exitCode, undefined);
          assert.equal(error.stderr, undefined);
        }
        assert.equal(await groupHasLiveMembers(guardian.pid), false);
      });
    }
  }
});

test("source overflow retains cleanup errors and waits for owned group exit", async () => {
  if (process.platform === "win32") return;
  await withDeniedGuardian(async (f) => {
    const filename = join(f.directory, "builder.json");
    let settled = false;
    const result = f
      .launch(process.execPath, [fixture, "output-tree", filename], {
        phase: "source overflow cleanup control",
        maxOutputBytes: 1024,
        timeoutMs: 30000,
      })
      .then(
        (value) => {
          settled = true;
          return { ok: true, value };
        },
        (error) => {
          settled = true;
          return { ok: false, error: commandError(error) };
        },
      );
    const parent = await record(filename);
    const descendant = await record(filename + ".child");
    assert.equal(await running(parent, "stdout"), true);
    const guardian = await f.refused();
    assert.equal(await running(parent), true);
    assert.equal(await running(descendant), true);
    assert.equal(await groupHasLiveMembers(guardian.pid), true);
    assert.equal(settled, false, "EPERM does not prove owned group exit");
    await f.release();
    const outcome = await result;
    assert.equal(outcome.ok, false);
    assert.ok("error" in outcome);
    const error = outcome.error;
    assert.match(
      error.message,
      /source overflow cleanup control: .*output exceeds 1024 bytes.*owned group cleanup failed: kill EPERM control/s,
    );
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    const [primary, cleanup] = error.errors.map(commandError);
    assert.match(primary.message, /output exceeds 1024 bytes/);
    deniedCleanup(cleanup.cause);
    assert.equal(error.cause, primary);
    assert.equal(await groupHasLiveMembers(guardian.pid), false);
    assert.equal(await endpointAbsent(parent), true);
    assert.equal(await endpointAbsent(descendant), true);
  });
});

test("owned deadline retains cleanup errors and waits for group exit", async () => {
  if (process.platform === "win32") return;
  await withDeniedGuardian(async (f) => {
    const filename = join(f.directory, "builder.json");
    let settled = false;
    const result = f
      .launch(process.execPath, [fixture, "tree", filename], {
        phase: "owned deadline cleanup control",
        timeoutMs: 30000,
        returnExitCode: true,
      })
      .then(
        (value) => {
          settled = true;
          return { ok: true, value };
        },
        (error) => {
          settled = true;
          return { ok: false, error: commandError(error) };
        },
      );
    const parent = await record(filename);
    const descendant = await record(filename + ".child");
    const guardian = await f.refused();
    assert.equal(await running(parent), true);
    assert.equal(await running(descendant), true);
    assert.equal(await groupHasLiveMembers(guardian.pid), true);
    assert.equal(settled, false, "EPERM does not prove owned group exit");
    await f.release();
    const outcome = await result;
    assert.equal(outcome.ok, false);
    assert.ok("error" in outcome);
    const error = outcome.error;
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    const [primary, cleanup] = error.errors.map(commandError);
    assert.notEqual(primary, cleanup);
    assert.match(primary.message, /timed out after 30000ms/);
    assert.match(cleanup.message, /owned group cleanup failed/);
    deniedCleanup(cleanup.cause);
    assert.equal(error.cause, primary);
    assert.match(
      error.message,
      /timed out after 30000ms.*owned group cleanup failed/s,
    );
    assert.equal(await groupHasLiveMembers(guardian.pid), false);
    assert.equal(await endpointAbsent(parent), true);
    assert.equal(await endpointAbsent(descendant), true);
  });
});

test("staging deadline names its command and closes the owned builder tree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-build-"));
  const filename = join(directory, "builder.json");
  // Attach rejection handling before observing the live resources.
  const result = stageBinary({
    command: process.execPath,
    prefix: [fixture, "tree", filename],
    output: join(directory, "saltbox-lint"),
    timeoutMs: 30000,
  }).then(() => undefined, commandError);
  try {
    const parent = await record(filename);
    const child = await record(filename + ".child");
    assert.equal(
      await running(parent),
      true,
      "owned builder is live before the deadline",
    );
    assert.equal(
      await running(child),
      true,
      "owned descendant is live before the deadline",
    );
    const failure = await result;
    assert.ok(failure instanceof Error);
    assert.match(
      failure.message,
      /stage release CLI: .*owned (?:Job launcher )?PID \d+.*timed out after 30000ms/s,
    );
    assert.match(failure.message, /owned-builder\.mjs/);
    assert.equal(
      await running(parent),
      false,
      "owned builder endpoint is absent after cleanup",
    );
    assert.equal(
      await running(child),
      false,
      "owned descendant endpoint is absent after cleanup",
    );
  } finally {
    await result;
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mode of ["exit", "error-exit"]) {
  test(`staging reaps retained descendant pipes after builder ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "saltbox-exited-build-"));
    const filename = join(directory, "builder.json");
    const result = stageBinary({
      command: process.execPath,
      prefix: [fixture, mode, filename],
      output: join(directory, "saltbox-lint"),
      timeoutMs: 30000,
    }).then(() => undefined, commandError);
    try {
      const parent = await record(filename);
      const child = await record(filename + ".child");
      assert.equal(await running(parent), true);
      assert.equal(
        await running(child),
        true,
        "owned descendant is live before parent exit",
      );
      const trigger = createConnection({
        host: "127.0.0.1",
        port: parent.port,
      });
      trigger.on("error", () => {});
      trigger.end("exit\n");
      const failure = await result;
      trigger.destroy();
      if (mode === "error-exit") {
        assert.ok(failure instanceof Error);
        assert.match(failure.message, /stage release CLI: .*exited 7/s);
        assert.doesNotMatch(failure.message, /timed out/);
      } else
        assert.equal(
          failure,
          undefined,
          "successful builder exit remains successful",
        );
      assert.equal(await running(parent), false);
      assert.equal(
        await running(child),
        false,
        "exited parent's owned descendant endpoint is absent",
      );
    } finally {
      await result;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

/** @type {("stdout" | "stderr")[]} */
const outputs = ["stdout", "stderr"];
for (const output of outputs) {
  test(`closed ${output} consumer rejects after exact owned cleanup`, async () => {
    await outputControl(output, "closed", "output-tree");
  });
  test(`blocked ${output} writes reap retained descendants after parent exit`, async () => {
    await outputControl(output, "blocked", "output-exit");
  });
  test(`blocked ${output} consumer retains the live builder deadline`, async () => {
    await outputControl(output, "blocked", "output-tree");
  });
}

for (const mode of ["normal-output", "error-output"]) {
  test(`inherited output preserves both streams and ${mode} semantics`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "saltbox-output-semantics-"));
    const filename = join(directory, "builder.json");
    const resultFile = join(directory, "result.json");
    const owner = spawn(
      process.execPath,
      [outputFixture, fixture, mode, filename, resultFile],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 45000,
      },
    );
    let stdout = "";
    let stderr = "";
    owner.stdout.on("data", (chunk) => (stdout += chunk));
    owner.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise((resolve, reject) => {
      owner.once("error", reject);
      owner.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.equal(stdout, "normal stdout\n");
      assert.equal(stderr, "normal stderr\n");
      const result = outputResult(resultFile);
      assert.ok(
        Date.now() - result.settledAt < 5000,
        "no cleanup timer retains the owner after settlement",
      );
      if (mode === "error-output") {
        assert.ok(typeof result.error === "string");
        assert.match(result.error, /exited 7/);
      } else assert.equal(result.error, undefined);
      assert.deepEqual(result.after, result.before);
    } finally {
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

/** @param {"stdout" | "stderr"} output @param {"closed" | "blocked"} consumer @param {string} mode */
async function outputControl(output, consumer, mode) {
  return withTestResources({ cleanupTimeoutMs: 15000 }, (resources) =>
    outputControlOwned(resources, output, consumer, mode),
  );
}

/** @param {import("./support/test-resources.ts").TestResources} resources @param {"stdout" | "stderr"} output @param {"closed" | "blocked"} consumer @param {string} mode */
async function outputControlOwned(resources, output, consumer, mode) {
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-output-"));
  const filename = join(directory, "builder.json");
  const resultFile = join(directory, "result.json");
  let lifetimesAbsent = false;
  resources.defer("native output fixture files", () => {
    if (lifetimesAbsent) rmSync(directory, { recursive: true, force: true });
    else
      console.error(`Retained unverified native output fixture: ${directory}`);
  });
  const owner = spawn(
    process.execPath,
    [outputFixture, fixture, mode, filename, resultFile],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 45000 },
  );
  let otherOutput = "";
  const target = owner[output];
  const other = owner[output === "stdout" ? "stderr" : "stdout"];
  other.on("data", (chunk) => (otherOutput += chunk.toString()));
  if (consumer === "closed") target.once("data", () => target.destroy());
  else owner.once("exit", () => target.resume());
  const exited = new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.once("close", (code, signal) => resolve({ code, signal }));
  });
  /** @type {FixtureInstance | undefined} */
  let parent;
  /** @type {FixtureInstance | undefined} */
  let child;
  /** @type {FixtureInstance | undefined} */
  let writer;
  ownJoinedResource(resources, "native output driver", {
    dispose() {
      if (owner.exitCode === null && owner.signalCode === null)
        owner.kill("SIGKILL");
    },
    async join() {
      await exited;
      assert.ok(
        parent && child,
        "credentialed fixture membership must be known before removing its evidence",
      );
      assert.equal(await endpointAbsent(parent), true);
      assert.equal(await endpointAbsent(child), true);
      if (writer) assert.equal(await endpointAbsent(writer), true);
      lifetimesAbsent = true;
    },
  });
  try {
    parent = await record(filename);
    child = await record(filename + ".child");
    assert.equal(await running(parent), true);
    assert.equal(await running(child), true);
    const trigger = createConnection({ host: "127.0.0.1", port: parent.port });
    trigger.on("error", () => {});
    trigger.end(output + "\n");
    if (consumer === "blocked") {
      const status = await record(filename + ".pending", pendingRecord);
      assert.equal(status.token, parent.token);
      if (process.platform === "win32") {
        writer = await record(filename + ".writer");
        assert.equal(
          await running(writer),
          true,
          "exact owned output writer is live while its write is pending",
        );
      }
      if (target.readableLength === 0) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1000);
        try {
          await once(target, "readable", { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      }
      assert.ok(
        target.readableLength > 0,
        "actual unread output reached the pipe",
      );
      assert.deepEqual(
        await record(filename + ".pending", pendingRecord),
        { token: parent.token, pending: true },
        "actual large output write is pending",
      );
      if (mode === "output-exit") {
        const exitTrigger = createConnection({
          host: "127.0.0.1",
          port: parent.port,
        });
        exitTrigger.on("error", () => {});
        exitTrigger.end("exit\n");
      }
    }
    const exit = await exited;
    trigger.destroy();
    assert.deepEqual(exit, { code: 0, signal: null }, otherOutput);
    const result = outputResult(resultFile);
    assert.ok(
      Date.now() - result.settledAt < 5000,
      "no cleanup timer retains the owner after settlement",
    );
    if (consumer === "closed") {
      assert.ok(typeof result.error === "string");
      assert.match(result.error, /exited 7/);
    } else if (mode === "output-tree") {
      assert.ok(typeof result.error === "string");
      assert.match(result.error, /timed out after 30000ms/);
    } else
      assert.equal(
        result.error,
        undefined,
        "successful parent exit remains successful",
      );
    assert.deepEqual(
      result.after,
      result.before,
      "temporary listeners disposed",
    );
    assert.ok(result.elapsed < 42000, "deadline and cleanup remain bounded");
    assert.equal(await running(parent), false, "exact owned builder is absent");
    assert.equal(
      await running(child),
      false,
      "exact owned descendant is absent",
    );
    if (writer)
      assert.equal(
        await running(writer),
        false,
        "exact owned blocked writer is absent",
      );
    assert.doesNotMatch(otherOutput, /Unhandled 'error' event/);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null)
      owner.kill("SIGKILL");
    await exited;
  }
}
