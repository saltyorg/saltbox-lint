import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { stageBinary } from "../scripts/stage-binary.mjs";
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

async function record(filename) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try {
      return JSON.parse(readFileSync(filename));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`Owned builder did not publish ${filename}`);
}

function running(instance, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: instance.port });
    let response = "";
    const finish = (error, alive) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(alive);
    };
    socket.setTimeout(1000, () =>
      finish(new Error("Owned builder probe timed out")),
    );
    if (request) socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk) => (response += chunk.toString("ascii")));
    socket.once("end", () =>
      finish(undefined, response === instance.token + "\n"),
    );
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") finish(undefined, false);
      else finish(error);
    });
  });
}

test("POSIX observer retains a live worker after its main thread exits", async () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-thread-"));
  const filename = join(directory, "thread.json");
  const binary = join(directory, "fixture");
  let child;
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
    child = spawn(binary, [filename, randomBytes(32).toString("hex")], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 45000,
      killSignal: "SIGKILL",
    });
    child.stderr.resume();
    closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const instance = await record(filename);
    assert.equal(await running(instance, "probe\n"), true);
    assert.equal(await groupHasLiveMembers(instance.pid), true);
    const trigger = createConnection({
      host: "127.0.0.1",
      port: instance.port,
    });
    await new Promise((resolve, reject) => {
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
    if (child?.pid) process.kill(-child.pid, "SIGKILL");
    if (closed)
      assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
    if (child?.pid) {
      const instance = await record(filename);
      assert.equal(
        await running(instance, "probe\n"),
        false,
        "exact killed worker endpoint is absent",
      );
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("group snapshots require complete Linux threads and supported Darwin states", () => {
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
    "123 123 123 2 Z\n123 123 123 2 Z\n",
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
  for (const state of ["R", "S", "T", "U", "I", "Ss+", "U<", "SNXEVLs+"]) {
    assert.equal(
      liveGroupMembers(`123 123 Z\n123 124 ${state}\n`, 123, "darwin"),
      true,
    );
  }
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
  for (const platform of ["linux", "darwin"]) {
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
  let supervisor;
  let exited;
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
    supervisor = spawn(binary, ["parent", filename], {
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 45000,
    });
    exited = new Promise((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", (code, signal) => resolve({ code, signal }));
    });
    instance = await record(filename);
    assert.equal(await running(instance), true);
    assert.equal(await groupHasLiveMembers(instance.pid), true);
    writeFileSync(filename + ".exit", "");
    const until = Date.now() + 5000;
    let state;
    do {
      state = execFileSync(
        "/bin/ps",
        ["-p", String(instance.pid), "-o", "state="],
        { encoding: "utf8", timeout: 1000 },
      ).trim();
      if (!state.startsWith("Z")) await delay(10);
    } while (!state.startsWith("Z") && Date.now() < until);
    assert.match(state, /^Z/, "supervisor has not reaped the actual child");
    assert.doesNotThrow(
      () => process.kill(-instance.pid, 0),
      "zombie-only group still exists",
    );
    assert.equal(
      await running(instance),
      false,
      "exact child endpoint is absent",
    );
    assert.equal(
      await groupHasLiveMembers(instance.pid),
      false,
      "zombies do not extend cleanup",
    );
    supervisor.stdin.end("reap\n");
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    if (instance && (await running(instance)))
      process.kill(-instance.pid, "SIGKILL");
    supervisor?.stdin.end("reap\n");
    if (exited) await exited;
    rmSync(directory, { recursive: true, force: true });
  }
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
    /metadata control: .*owned (?:Job launcher )?PID \d+.*exited 7\nbuilder failure/s,
  );
  await assert.rejects(
    ownedCommand("saltbox-missing-owned-builder", [], {
      phase: "spawn control",
      timeoutMs: 30000,
    }),
    /spawn control: .*ENOENT/s,
  );
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
  }).then(
    () => undefined,
    (error) => error,
  );
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
    }).then(
      () => undefined,
      (error) => error,
    );
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

for (const output of ["stdout", "stderr"]) {
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
      const result = JSON.parse(readFileSync(resultFile));
      assert.ok(
        Date.now() - result.settledAt < 5000,
        "no cleanup timer retains the owner after settlement",
      );
      if (mode === "error-output") assert.match(result.error, /exited 7/);
      else assert.equal(result.error, undefined);
      assert.deepEqual(result.after, result.before);
    } finally {
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

async function outputControl(output, consumer, mode) {
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-output-"));
  const filename = join(directory, "builder.json");
  const resultFile = join(directory, "result.json");
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
  let parent;
  let child;
  try {
    parent = await record(filename);
    child = await record(filename + ".child");
    assert.equal(await running(parent), true);
    assert.equal(await running(child), true);
    const trigger = createConnection({ host: "127.0.0.1", port: parent.port });
    trigger.on("error", () => {});
    trigger.end(output + "\n");
    if (consumer === "blocked") {
      const status = await record(filename + ".pending");
      assert.equal(status.token, parent.token);
      assert.equal(
        status.pending,
        true,
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
    const result = JSON.parse(readFileSync(resultFile));
    assert.ok(
      Date.now() - result.settledAt < 5000,
      "no cleanup timer retains the owner after settlement",
    );
    if (consumer === "closed") assert.match(result.error, /exited 7/);
    else if (mode === "output-tree")
      assert.match(result.error, /timed out after 30000ms/);
    else
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
    assert.doesNotMatch(otherOutput, /Unhandled 'error' event/);
  } finally {
    await exited;
    // A regression run against broken POSIX forwarding can exit the owner
    // before it releases its group. Only clean our recorded, still-live tree.
    if (process.platform !== "win32" && parent && child) {
      const probes = await Promise.allSettled([
        running(parent),
        running(child),
      ]);
      if (probes.some((probe) => probe.status === "fulfilled" && probe.value))
        process.kill(-parent.pid, "SIGKILL");
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
