import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { fixtureRunning } from "../host/fixture-processes.ts";

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
