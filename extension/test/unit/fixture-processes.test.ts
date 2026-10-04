import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixtureGateInstance,
  fixtureInvocations,
  fixtureProcesses,
  fixtureRunning,
} from "../host/fixture-processes.ts";

async function endpoint(answer: string | undefined, closeTimeoutMs = 5000) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (answer !== undefined) socket.end(answer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    instance: { pid: process.pid, port: address.port, token: "a".repeat(64) },
    async close() {
      for (const socket of sockets) socket.destroy();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), closeTimeoutMs);
      try {
        const closed = once(server, "close", { signal: controller.signal });
        server.close();
        await closed;
      } catch (error) {
        throw new Error(
          `Owned fixture endpoint ${process.pid}:${address.port} close failed within ${closeTimeoutMs}ms`,
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }
    },
    server,
  };
}

test("fixture lifetime rejects quiescence while the exact instance is alive", async () => {
  const live = await endpoint("a".repeat(64) + "\n");
  try {
    assert.equal(await fixtureRunning(live.instance), true);
    // A numeric PID is informational. An incorrect or reused PID cannot hide
    // a live owned instance, nor make an exited instance look live.
    assert.equal(await fixtureRunning({ ...live.instance, pid: 999999 }), true);
  } finally {
    await live.close();
  }
  process.kill(live.instance.pid, 0);
  assert.equal(await fixtureRunning(live.instance), false);
});

test("gate readiness keeps its exact live instance when historical PIDs repeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-gate-instance-"));
  const historical = await endpoint("a".repeat(64) + "\n");
  await historical.close();
  const live = await endpoint("b".repeat(64) + "\n");
  live.instance.token = "b".repeat(64);
  try {
    const filename = join(directory, "instances.jsonl");
    await writeFile(
      filename,
      [historical.instance, live.instance]
        .map((instance) => JSON.stringify(instance))
        .join("\n") + "\n",
    );
    const ready = { pid: live.instance.pid, instance: live.instance };
    const oldSelection = fixtureProcesses(filename).find(
      (instance) => instance.pid === ready.pid,
    );
    assert.deepEqual(oldSelection, historical.instance);
    assert.ok(oldSelection);
    assert.equal(await fixtureRunning(oldSelection), false);
    const selected = fixtureGateInstance(ready, filename);
    assert.deepEqual(selected, live.instance);
    assert.equal(await fixtureRunning(selected), true);
    await writeFile(
      filename,
      [live.instance, historical.instance]
        .map((instance) => JSON.stringify(instance))
        .join("\n") + "\n",
    );
    assert.deepEqual(fixtureGateInstance(ready, filename), live.instance);
    assert.equal(
      await fixtureRunning(fixtureGateInstance(ready, filename)),
      true,
    );
    assert.throws(
      () => fixtureGateInstance(JSON.parse('{"pid":123}'), filename),
      /readiness includes its instance endpoint/,
    );
    assert.throws(
      () => fixtureGateInstance({ ...ready, pid: ready.pid + 1 }, filename),
      /instance owns its PID/,
    );
    assert.throws(
      () =>
        fixtureGateInstance(
          { ...ready, instance: { ...live.instance, token: "c".repeat(64) } },
          filename,
        ),
      /exact recorded instance endpoint/,
    );
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing endpoint close notification fails within its cleanup deadline", async () => {
  const live = await endpoint("a".repeat(64) + "\n", 50);
  const emit = live.server.emit;
  live.server.emit = function (event, ...args) {
    if (event === "close") return false;
    return Reflect.apply(emit, this, [event, ...args]);
  };
  assert.equal(await fixtureRunning(live.instance), true);
  await assert.rejects(live.close(), /Owned fixture endpoint .*50ms/);
  assert.equal(live.server.listening, false);
  assert.equal(await fixtureRunning(live.instance), false);
  assert.equal(live.server.listenerCount("close"), 0);
});

test("a different valid instance token does not identify an owned survivor", async () => {
  const other = await endpoint("b".repeat(64) + "\n");
  try {
    assert.equal(await fixtureRunning(other.instance), false);
  } finally {
    await other.close();
  }
});

test("unknown or unresponsive lifetime endpoints fail conservatively", async () => {
  for (const answer of [undefined, "", "incomplete\n", "x".repeat(66)]) {
    const unknown = await endpoint(answer);
    try {
      await assert.rejects(fixtureRunning(unknown.instance), /lifetime/);
    } finally {
      await unknown.close();
    }
  }
});

test("a cancelled fixture keeps its exact argv and lifetime in one journal record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-instance-argv-"));
  const live = await endpoint("a".repeat(64) + "\n");
  try {
    const filename = join(directory, "instances.jsonl");
    const args = [
      "check",
      "--root",
      "root with spaces",
      "--",
      "roles/main.yml",
    ];
    await writeFile(
      filename,
      JSON.stringify({ ...live.instance, args }) + "\n",
    );
    // Cancellation may prevent a subsequent legacy process-log append. The
    // completed identity record still accounts for the exact invocation.
    assert.deepEqual(fixtureInvocations(filename), [
      `${live.instance.pid} ${args.join(" ")}`,
    ]);
    assert.deepEqual(fixtureProcesses(filename), [{ ...live.instance, args }]);
    assert.equal(await fixtureRunning(fixtureProcesses(filename)[0]), true);
    await live.close();
    assert.equal(await fixtureRunning(fixtureProcesses(filename)[0]), false);
    await writeFile(filename, JSON.stringify(live.instance) + "\n");
    assert.throws(() => fixtureInvocations(filename), /includes actual argv/);
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});
