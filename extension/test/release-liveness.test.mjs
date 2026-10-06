import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
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

function probe(instance, request) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: instance.port });
    let response = "";
    let settled = false;
    const finish = (state, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ state, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(
      () => finish("unavailable", "Owned builder probe timed out"),
      1000,
    );
    if (request) socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk) => {
      response += chunk.toString("ascii");
      if (response.length > 65) finish("unavailable", "response exceeds bound");
    });
    socket.once("end", () => {
      if (!/^[a-f0-9]{64}\n$/.test(response))
        finish("unavailable", "invalid response");
      else finish(response === instance.token + "\n" ? "alive" : "mismatch");
    });
    socket.once("close", () =>
      finish("unavailable", "probe closed unexpectedly"),
    );
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") finish("endpoint-absent");
      else finish("unavailable", error.code ?? error.name);
    });
  });
}

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
        await endpointAbsent(instance, "probe\n"),
        true,
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
      assert.deepEqual(
        row.slice(1, 5).map(Number),
        [instance.pid, supervisor.pid, instance.pid, process.geteuid()],
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
    supervisor.stdin.end("reap\n");
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    if (instance && (await groupHasLiveMembers(instance.pid)))
      process.kill(-instance.pid, "SIGKILL");
    supervisor?.stdin.end("reap\n");
    if (exited) await exited;
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const instance = { pid: process.pid, port: server.address().port, token };
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
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
  }).catch((error) => error);
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

test("successful capture still rejects a denied owned group cleanup", async (t) => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-denial-"));
  const filename = join(directory, "builder.json");
  const kill = process.kill.bind(process);
  const denied = Object.assign(new Error("kill EPERM control"), {
    code: "EPERM",
    syscall: "kill",
  });
  const mock = t.mock.method(process, "kill", (pid, signal) => {
    if (pid < 0 && signal === "SIGKILL") {
      const instance = JSON.parse(readFileSync(filename));
      if (pid === -instance.pid) throw denied;
    }
    return kill(pid, signal);
  });
  try {
    await assert.rejects(
      ownedCommand(
        process.execPath,
        [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(filename)}, JSON.stringify({ pid: process.pid })); process.stdout.write("ok")`,
        ],
        { phase: "successful capture cleanup control", timeoutMs: 30000 },
      ),
      (error) => {
        assert.match(error.message, /owned group cleanup failed/);
        assert.equal(error.cause, denied);
        assert.equal(error instanceof AggregateError, false);
        return true;
      },
    );
    assert.equal(
      await groupHasLiveMembers(JSON.parse(readFileSync(filename)).pid),
      false,
    );
  } finally {
    mock.mock.restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordinary command exits preserve failures alongside denied cleanup", async (t) => {
  if (process.platform === "win32") return;
  for (const code of [0, 3]) {
    for (const returnExitCode of [false, true]) {
      const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-exit-"));
      const filename = join(directory, "builder.json");
      const nonce = randomBytes(16).toString("hex");
      const kill = process.kill.bind(process);
      const denied = Object.assign(new Error("kill EPERM control"), {
        code: "EPERM",
        syscall: "kill",
      });
      let instance;
      const mock = t.mock.method(process, "kill", (pid, signal) => {
        if (pid < 0 && signal === "SIGKILL") {
          instance = JSON.parse(readFileSync(filename));
          assert.equal(instance.nonce, nonce);
          if (pid === -instance.pid) throw denied;
        }
        return kill(pid, signal);
      });
      try {
        await assert.rejects(
          ownedCommand(
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
          ),
          (error) => {
            if (code !== 0 && !returnExitCode) {
              assert.ok(error instanceof AggregateError);
              assert.equal(error.errors.length, 2);
              const [primary, cleanup] = error.errors;
              assert.notEqual(primary, cleanup);
              assert.equal(primary.exitCode, code);
              assert.equal(primary.stderr, "ordinary failure detail\n");
              assert.match(
                primary.message,
                /exited 3\nordinary failure detail/,
              );
              assert.match(cleanup.message, /owned group cleanup failed/);
              assert.equal(cleanup.cause, denied);
              assert.equal(error.cause, primary);
              assert.match(
                error.message,
                /exited 3\nordinary failure detail.*owned group cleanup failed/s,
              );
            } else {
              assert.equal(error instanceof AggregateError, false);
              assert.match(error.message, /owned group cleanup failed/);
              assert.equal(error.cause, denied);
              assert.equal(error.exitCode, undefined);
              assert.equal(error.stderr, undefined);
            }
            return true;
          },
        );
        assert.equal(instance.nonce, nonce);
        assert.equal(await groupHasLiveMembers(instance.pid), false);
      } finally {
        mock.mock.restore();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});

test("source overflow retains cleanup errors and waits for owned group exit", async (t) => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-overflow-"));
  const filename = join(directory, "builder.json");
  const controller = new AbortController();
  const kill = process.kill.bind(process);
  const denied = Object.assign(new Error("kill EPERM control"), {
    code: "EPERM",
    syscall: "kill",
  });
  let parent;
  let descendant;
  let mock;
  let settled = false;
  const result = ownedCommand(
    process.execPath,
    [fixture, "output-tree", filename],
    {
      phase: "source overflow cleanup control",
      maxOutputBytes: 1024,
      timeoutMs: 30000,
      signal: controller.signal,
    },
  ).then(
    () => {
      settled = true;
      throw new Error("Overflow unexpectedly succeeded");
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    parent = await record(filename);
    descendant = await record(filename + ".child");
    let deniedKill;
    const attempted = new Promise((resolve) => {
      deniedKill = resolve;
    });
    mock = t.mock.method(process, "kill", (pid, signal) => {
      if (pid === -parent.pid && signal === "SIGKILL") {
        deniedKill();
        throw denied;
      }
      return kill(pid, signal);
    });
    assert.equal(await running(parent, "stdout"), true);
    await attempted;
    assert.equal(await running(parent), true);
    assert.equal(await running(descendant), true);
    assert.equal(await groupHasLiveMembers(parent.pid), true);
    assert.equal(settled, false, "EPERM does not prove owned group exit");
    mock.mock.restore();
    kill(-parent.pid, "SIGKILL");
    const error = await result;
    assert.match(
      error.message,
      /source overflow cleanup control: .*output exceeds 1024 bytes.*owned group cleanup failed: Error: kill EPERM control/s,
    );
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /output exceeds 1024 bytes/);
    assert.equal(error.errors[1].cause, denied);
    assert.equal(await groupHasLiveMembers(parent.pid), false);
    assert.equal(await endpointAbsent(parent), true);
    assert.equal(await endpointAbsent(descendant), true);
  } finally {
    mock?.mock.restore();
    controller.abort();
    if (parent && (await groupHasLiveMembers(parent.pid))) {
      // Signal only our recorded group after authenticating a live member.
      assert.ok(
        (await running(parent)) || (descendant && (await running(descendant))),
      );
      kill(-parent.pid, "SIGKILL");
    }
    await result;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owned deadline retains cleanup errors and waits for group exit", async (t) => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-deadline-"));
  const filename = join(directory, "builder.json");
  const controller = new AbortController();
  const kill = process.kill.bind(process);
  const denied = Object.assign(new Error("kill EPERM control"), {
    code: "EPERM",
    syscall: "kill",
  });
  let parent;
  let descendant;
  let mock;
  let settled = false;
  const result = ownedCommand(process.execPath, [fixture, "tree", filename], {
    phase: "owned deadline cleanup control",
    timeoutMs: 30000,
    returnExitCode: true,
    signal: controller.signal,
  }).then(
    () => {
      settled = true;
      throw new Error("Deadline unexpectedly succeeded");
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    parent = await record(filename);
    descendant = await record(filename + ".child");
    let deniedKill;
    const attempted = new Promise((resolve) => {
      deniedKill = resolve;
    });
    mock = t.mock.method(process, "kill", (pid, signal) => {
      if (pid === -parent.pid && signal === "SIGKILL") {
        deniedKill();
        throw denied;
      }
      return kill(pid, signal);
    });
    await attempted;
    assert.equal(await running(parent), true);
    assert.equal(await running(descendant), true);
    assert.equal(await groupHasLiveMembers(parent.pid), true);
    assert.equal(settled, false, "EPERM does not prove owned group exit");
    mock.mock.restore();
    kill(-parent.pid, "SIGKILL");
    const error = await result;
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    const [primary, cleanup] = error.errors;
    assert.notEqual(primary, cleanup);
    assert.match(primary.message, /timed out after 30000ms/);
    assert.match(cleanup.message, /owned group cleanup failed/);
    assert.equal(cleanup.cause, denied);
    assert.equal(error.cause, primary);
    assert.match(
      error.message,
      /timed out after 30000ms.*owned group cleanup failed/s,
    );
    assert.equal(await groupHasLiveMembers(parent.pid), false);
    assert.equal(await endpointAbsent(parent), true);
    assert.equal(await endpointAbsent(descendant), true);
  } finally {
    mock?.mock.restore();
    controller.abort();
    if (parent && (await groupHasLiveMembers(parent.pid))) {
      assert.ok(
        (await running(parent)) || (descendant && (await running(descendant))),
      );
      kill(-parent.pid, "SIGKILL");
    }
    await result;
    rmSync(directory, { recursive: true, force: true });
  }
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
  let writer;
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
        await record(filename + ".pending"),
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
    if (writer)
      assert.equal(
        await running(writer),
        false,
        "exact owned blocked writer is absent",
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
