import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import {
  fixtureAbsent,
  fixtureGateInstance,
  fixtureRunning,
} from "./host/fixture-processes.ts";

const source = fileURLToPath(
  new URL("testdata/process_fixture.go", import.meta.url),
);

test("fixture failures identify their stage without disclosing process inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-fixture-failure-"));
  const binary = join(
    directory,
    "process-fixture" + (process.platform === "win32" ? ".exe" : ""),
  );
  const privateMarker =
    "private-fixture-input-" + randomBytes(16).toString("hex");
  const privateDirectory = join(directory, privateMarker);
  const renameGate = join(privateDirectory, "rename-gate");
  try {
    await mkdir(privateDirectory);
    await mkdir(renameGate + ".ready");
    await writeFile(join(renameGate + ".ready", privateMarker), privateMarker);
    const build = spawnSync("go", ["build", "-o", binary, source], {
      env: { ...process.env, CGO_ENABLED: "0" },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(build.status, 0, build.stderr);
    const baseEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("SALTBOX_TEST_"),
        ),
      ),
      // An explicit executable suffix reaches CreateProcess rather than
      // Windows extension discovery, so the missing file yields an OS errno.
      ...(process.platform === "win32" ? { PATHEXT: ".EXE" } : {}),
      SALTBOX_TEST_REAL_CLI: process.execPath,
      SALTBOX_TEST_PROCESS_GATE_NONCE: privateMarker,
    };
    const cases = [
      {
        stage: "instance-open",
        errorClass: "errno",
        args: ["format", privateMarker],
        env: { SALTBOX_TEST_PROCESS_INSTANCES: privateDirectory },
      },
      {
        stage: "process-log-open",
        errorClass: "errno",
        args: ["check", privateMarker],
        env: { SALTBOX_TEST_PROCESS_LOG: privateDirectory },
      },
      {
        stage: "gate-selection-decode",
        errorClass: "json",
        env: { SALTBOX_TEST_PROCESS_GATE_PATHS: privateMarker },
      },
      {
        stage: "gate-selection-decode",
        errorClass: "json",
        env: {
          SALTBOX_TEST_PROCESS_GATE_PATHS: JSON.stringify({ privateMarker }),
        },
      },
      {
        stage: "gate-selection-empty",
        errorClass: "invalid-input",
        env: { SALTBOX_TEST_PROCESS_GATE_PATHS: "[]" },
      },
      {
        stage: "readiness-write",
        errorClass: "errno",
        env: {
          SALTBOX_TEST_PROCESS_GATE: join(privateDirectory, "missing", "gate"),
        },
      },
      {
        stage: "readiness-rename",
        errorClass: "errno",
        env: { SALTBOX_TEST_PROCESS_GATE: renameGate },
      },
      {
        stage: "child-start",
        errorClass: "errno",
        env: {
          SALTBOX_TEST_REAL_CLI: join(
            privateDirectory,
            "missing-executable.exe",
          ),
        },
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const failureLog = join(directory, `failure-${index}.jsonl`);
      const result = spawnSync(binary, scenario.args ?? ["--version"], {
        env: {
          ...baseEnv,
          ...scenario.env,
          SALTBOX_TEST_PROCESS_FAILURE_LOG: failureLog,
        },
        input: privateMarker,
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.error, undefined, scenario.stage);
      assert.equal(result.signal, null, scenario.stage);
      assert.equal(result.status, 2, scenario.stage);
      const persisted = await readFile(failureLog, "utf8");
      assert.equal(
        result.stderr,
        "SALTBOX_TEST_FIXTURE_FAILURE " + persisted,
        scenario.stage,
      );
      const record = JSON.parse(persisted);
      assert.equal(record.stage, scenario.stage);
      assert.equal(record.error_class, scenario.errorClass, scenario.stage);
      assert.deepEqual(
        Object.keys(record).sort(),
        scenario.errorClass === "errno"
          ? ["errno", "error_class", "operation", "pid", "stage"]
          : ["error_class", "operation", "pid", "stage"],
      );
      assert.equal(Number.isSafeInteger(record.pid), true);
      assert.ok(record.pid > 0);
      assert.equal(record.operation, scenario.args?.[0] ?? "other");
      if (scenario.errorClass === "errno") {
        assert.equal(Number.isSafeInteger(record.errno), true);
        assert.ok(record.errno > 0);
      }
      assert.equal(result.stderr.includes(privateMarker), false);
      assert.equal(result.stderr.includes(directory), false);
      assert.equal(result.stderr.includes(process.execPath), false);
    }
    const failedLogging = spawnSync(binary, ["--version"], {
      env: {
        ...baseEnv,
        SALTBOX_TEST_REAL_CLI: join(privateDirectory, "missing-executable.exe"),
        SALTBOX_TEST_PROCESS_FAILURE_LOG: privateDirectory,
      },
      input: privateMarker,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(failedLogging.error, undefined);
    assert.equal(failedLogging.status, 2);
    const failedLoggingRecord = JSON.parse(
      failedLogging.stderr.replace(/^SALTBOX_TEST_FIXTURE_FAILURE /, ""),
    );
    assert.equal(failedLoggingRecord.stage, "child-start");
    assert.equal(
      failedLoggingRecord.error_class,
      "errno",
      "child-start with diagnostic logging failure",
    );
    assert.equal(Number.isSafeInteger(failedLoggingRecord.errno), true);
    assert.equal(failedLogging.stderr.includes(privateMarker), false);

    for (const status of [1, 7]) {
      const failureLog = join(directory, `child-exit-${status}.jsonl`);
      const output = "public child output";
      const childExit = spawnSync(
        binary,
        [
          "--eval",
          `process.stdout.write(${JSON.stringify(output)}); process.exit(${status})`,
        ],
        {
          env: { ...baseEnv, SALTBOX_TEST_PROCESS_FAILURE_LOG: failureLog },
          input: privateMarker,
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(childExit.error, undefined);
      assert.equal(childExit.status, status);
      assert.equal(childExit.stderr, "");
      assert.equal(childExit.stdout, output);
      await assert.rejects(readFile(failureLog), { code: "ENOENT" });
    }
    const successful = spawnSync(binary, ["--version"], {
      env: baseEnv,
      input: privateMarker,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(successful.error, undefined);
    assert.equal(successful.status, 0);
    assert.equal(successful.stderr, "");
    assert.equal(successful.stdout.trim(), process.version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh control gates preserve occupied readiness from a completed control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-control-gates-"));
  const binary = join(
    directory,
    "process-fixture" + (process.platform === "win32" ? ".exe" : ""),
  );
  const instances = join(directory, "instances.jsonl");
  const failureLog = join(directory, "failures.jsonl");
  const children = [];
  try {
    const build = spawnSync("go", ["build", "-o", binary, source], {
      env: { ...process.env, CGO_ENABLED: "0" },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(build.status, 0, build.stderr);
    const baseEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("SALTBOX_TEST_"),
        ),
      ),
      SALTBOX_TEST_REAL_CLI: process.execPath,
      SALTBOX_TEST_PROCESS_INSTANCES: instances,
      SALTBOX_TEST_PROCESS_FAILURE_LOG: failureLog,
    };
    const launch = (gate, nonce) => {
      const child = spawn(binary, ["--version"], {
        env: {
          ...baseEnv,
          SALTBOX_TEST_PROCESS_GATE: gate,
          SALTBOX_TEST_PROCESS_GATE_NONCE: nonce,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
        killSignal: "SIGKILL",
      });
      const control = {
        child,
        closed: once(child, "close"),
        stdout: "",
        stderr: "",
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        control.stdout += data;
      });
      child.stderr.on("data", (data) => {
        control.stderr += data;
      });
      children.push(control);
      return control;
    };
    const published = async (gate, control) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        assert.equal(control.child.exitCode, null, control.stderr);
        try {
          return JSON.parse(await readFile(gate + ".ready", "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(10);
      }
      assert.fail("control gate publication exceeded 5000ms");
    };
    const firstNonce = randomBytes(32).toString("hex");
    const firstGate = join(directory, `response-${firstNonce}`);
    await writeFile(firstGate, "held");
    const first = launch(firstGate, firstNonce);
    const firstReady = await published(firstGate, first);
    assert.equal(firstReady.pid, first.child.pid);
    assert.equal(firstReady.nonce, firstNonce);
    const firstInstance = fixtureGateInstance(firstReady, instances);
    assert.equal(await fixtureRunning(firstInstance), true);
    assert.equal(first.stdout, "");
    await rm(firstGate);
    assert.deepEqual(await first.closed, [0, null]);
    assert.equal(first.stdout.trim(), process.version);
    assert.equal(first.stderr, "");
    assert.equal(await fixtureAbsent(firstInstance), true);

    // An occupied readiness destination makes replacing it fail on every
    // platform without relying on Windows file-sharing timing.
    const retainedBytes = await readFile(firstGate + ".ready");
    await rm(firstGate + ".ready");
    await mkdir(firstGate + ".ready");
    const retained = join(firstGate + ".ready", "retained.json");
    await writeFile(retained, retainedBytes);
    await writeFile(firstGate, "held");
    const freshNonce = randomBytes(32).toString("hex");
    const reused = spawnSync(binary, ["--version"], {
      env: {
        ...baseEnv,
        SALTBOX_TEST_PROCESS_GATE: firstGate,
        SALTBOX_TEST_PROCESS_GATE_NONCE: freshNonce,
      },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(reused.error, undefined);
    assert.equal(reused.status, 2);
    assert.equal(reused.stdout, "");
    const failureBytes = await readFile(failureLog, "utf8");
    assert.equal(reused.stderr, "SALTBOX_TEST_FIXTURE_FAILURE " + failureBytes);
    const failedReuse = JSON.parse(failureBytes);
    assert.equal(failedReuse.stage, "readiness-rename");
    assert.equal(failedReuse.error_class, "errno");
    assert.equal(failedReuse.pid, reused.pid);
    assert.equal(Number.isSafeInteger(failedReuse.errno), true);
    assert.ok(failedReuse.errno > 0);
    assert.deepEqual(await readFile(retained), retainedBytes);

    const freshGate = join(directory, `response-${freshNonce}`);
    assert.notEqual(freshGate, firstGate);
    await writeFile(freshGate, "held");
    const fresh = launch(freshGate, freshNonce);
    const freshReady = await published(freshGate, fresh);
    assert.equal(freshReady.pid, fresh.child.pid);
    assert.equal(freshReady.nonce, freshNonce);
    assert.notEqual(freshReady.nonce, firstReady.nonce);
    const freshInstance = fixtureGateInstance(freshReady, instances);
    assert.equal(freshInstance.pid, fresh.child.pid);
    assert.notEqual(freshInstance.token, firstInstance.token);
    assert.equal(await fixtureRunning(freshInstance), true);
    assert.equal(fresh.stdout, "");
    assert.deepEqual(await readFile(retained), retainedBytes);
    assert.equal(await readFile(firstGate, "utf8"), "held");
    await rm(freshGate);
    assert.deepEqual(await fresh.closed, [0, null]);
    assert.equal(fresh.stdout.trim(), process.version);
    assert.equal(fresh.stderr, "");
    assert.equal(await fixtureAbsent(freshInstance), true);
    assert.deepEqual(await readFile(retained), retainedBytes);
    assert.equal(await readFile(failureLog, "utf8"), failureBytes);
  } finally {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("only the exact selected chunk can publish or replace gate readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-selected-gate-"));
  const binary = join(
    directory,
    "process-fixture" + (process.platform === "win32" ? ".exe" : ""),
  );
  const children = [];
  const gate = join(directory, "gate");
  try {
    const build = spawnSync("go", ["build", "-o", binary, source], {
      env: { ...process.env, CGO_ENABLED: "0" },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(build.status, 0, build.stderr);
    const prefix = "roles/admission/defaults/";
    const paths = Array.from(
      { length: 65 },
      (_, index) => `${prefix}file${String(index).padStart(3, "0")}.yml`,
    );
    const expected = paths.slice(0, 64);
    const nonce = "a".repeat(64);
    const env = {
      ...process.env,
      // Node's --version exits before interpreting the selected path arguments.
      // The real Go publisher still runs its child and publication code.
      SALTBOX_TEST_REAL_CLI: process.execPath,
      SALTBOX_TEST_PROCESS_GATE: gate,
      SALTBOX_TEST_PROCESS_GATE_PREFIX: prefix,
      SALTBOX_TEST_PROCESS_GATE_PATHS: JSON.stringify(expected),
      SALTBOX_TEST_PROCESS_GATE_NONCE: nonce,
      SALTBOX_TEST_PROCESS_INSTANCES: join(directory, "instances.jsonl"),
    };
    await writeFile(gate, "");
    const launch = (selected) => {
      const child = spawn(binary, ["--version", "--", ...selected], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
        killSignal: "SIGKILL",
      });
      child.stdout.resume();
      child.stderr.resume();
      const closed = once(child, "close");
      children.push({ child, closed });
      return { child, closed };
    };
    const readiness = async () => {
      try {
        return JSON.parse(await readFile(gate + ".ready", "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    };
    const until = async (predicate) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(10);
      }
      assert.fail("gate publication or process exit exceeded 5000ms");
    };
    const unrelated = launch(["roles/example/defaults/main.yml"]);
    await until(() => unrelated.child.exitCode !== null);
    assert.deepEqual(await unrelated.closed, [0, null]);
    assert.equal(await readiness(), undefined);

    const publisher = launch(expected);
    let ready;
    await until(async () => {
      ready = await readiness();
      return ready !== undefined;
    });
    assert.equal(ready.pid, publisher.child.pid);
    assert.equal(ready.nonce, nonce);
    assert.equal(ready.instance.pid, publisher.child.pid);
    assert.deepEqual(ready.args, ["--version", "--", ...expected]);
    const instance = fixtureGateInstance(
      ready,
      env.SALTBOX_TEST_PROCESS_INSTANCES,
    );
    assert.equal(await fixtureRunning(instance), true);
    for (const selected of [
      paths.slice(64),
      [...expected.slice(0, 63), paths[64]],
      [expected[1], expected[0], ...expected.slice(2)],
      [...expected, paths[64]],
    ]) {
      const later = launch(selected);
      await until(async () => {
        assert.deepEqual(
          await readiness(),
          ready,
          "a different selected chunk must not replace exact first-chunk readiness",
        );
        return later.child.exitCode !== null;
      });
      assert.deepEqual(await later.closed, [0, null]);
      assert.equal(publisher.child.exitCode, null);
      assert.equal(await fixtureRunning(instance), true);
    }
    await rm(gate);
    assert.deepEqual(await publisher.closed, [0, null]);
    assert.equal(await fixtureRunning(instance), false);

    await rm(gate + ".ready");
    await writeFile(gate, "held");
    env.SALTBOX_TEST_PROCESS_GATE_NONCE = randomBytes(32).toString("hex");
    const exiting = launch(expected);
    let exitReady;
    await until(async () => {
      exitReady = await readiness();
      return exitReady !== undefined;
    });
    assert.equal(exitReady.pid, exiting.child.pid);
    assert.equal(exitReady.nonce, env.SALTBOX_TEST_PROCESS_GATE_NONCE);
    assert.deepEqual(exitReady.args, ["--version", "--", ...expected]);
    const exitInstance = fixtureGateInstance(
      exitReady,
      env.SALTBOX_TEST_PROCESS_INSTANCES,
    );
    assert.equal(await fixtureRunning(exitInstance), true);
    assert.equal(await fixtureAbsent(exitInstance), false);
    const mismatch = {
      ...exitInstance,
      token: randomBytes(32).toString("hex"),
    };
    assert.equal(await fixtureAbsent(mismatch), false);
    await assert.rejects(async () =>
      assert.equal(await fixtureRunning(mismatch), true),
    );

    const originalConnection = net.createConnection;
    let connected = false;
    const transitions = [];
    const sockets = [];
    net.createConnection = function (...args) {
      const socket = Reflect.apply(originalConnection, this, args);
      if (args[0]?.port === exitInstance.port) {
        sockets.push(socket);
        socket.once("connect", () => {
          connected = true;
          transitions.push("connect");
        });
        socket.once("error", (error) => transitions.push(error.code));
        socket.once("end", () => transitions.push("end"));
      }
      return socket;
    };
    syncBuiltinESMExports();
    let absence;
    try {
      absence = until(() => fixtureAbsent(exitInstance));
      // Keep rejection handled while the connect assertion runs; the original
      // observation is still awaited below and during owned cleanup.
      void absence.catch(() => undefined);
      // The observer opens the actual recorded endpoint before scoped exit.
      await until(() => connected);
      assert.equal(exiting.child.kill("SIGKILL"), true);
      await exiting.closed;
      await absence;
      assert.equal(await fixtureAbsent(exitInstance), true);
      console.log(
        `MEASURE real fixture connected exit observed=${JSON.stringify(transitions)} joined=true endpoint_absent=true`,
      );
    } finally {
      net.createConnection = originalConnection;
      syncBuiltinESMExports();
      for (const socket of sockets) socket.destroy();
      if (exiting.child.exitCode === null && exiting.child.signalCode === null)
        exiting.child.kill("SIGKILL");
      await exiting.closed;
      await absence;
    }
  } finally {
    await rm(gate, { force: true });
    for (const { child, closed } of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
