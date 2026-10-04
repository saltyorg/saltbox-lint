import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  fixtureGateInstance,
  fixtureRunning,
} from "./host/fixture-processes.ts";

const source = fileURLToPath(
  new URL("testdata/process_fixture.go", import.meta.url),
);

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
  } finally {
    await rm(gate, { force: true });
    for (const { child, closed } of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
