import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { fixtureRunning } from "../host/fixture-processes.ts";

async function endpoint(answer: string | undefined) {
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
      const closed = once(server, "close");
      server.close();
      await closed;
    },
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
