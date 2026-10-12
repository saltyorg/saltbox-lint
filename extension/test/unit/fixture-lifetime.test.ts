import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { probeFixtureLifetime } from "../support/fixture-lifetime.ts";
import { withTestResources } from "../support/test-resources.ts";

test("credentialed probe joins its actual native socket after response delivery", async () => {
  await withTestResources({ cleanupTimeoutMs: 1000 }, async (resources) => {
    const token = randomBytes(32).toString("hex");
    const server = createServer((socket) => {
      socket.on("error", () => socket.destroy());
      socket.once("data", () => socket.end(token + "\n"));
    });
    resources.defer(
      "probe server",
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let requested!: () => void;
    const destructionRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let release: (() => void) | undefined;
    let closed = false;
    let settled = false;
    const pending = resources.operation("native lifetime probe", () =>
      probeFixtureLifetime(
        { pid: process.pid, port: address.port, token },
        "probe\n",
        {
          connect(port) {
            const socket = createConnection({ host: "127.0.0.1", port });
            const destroy = socket.destroy.bind(socket);
            socket.destroy = () => {
              requested();
              return socket;
            };
            release = () => {
              socket.destroy = destroy;
              destroy();
            };
            const cancel = release;
            resources.signal.addEventListener("abort", cancel, { once: true });
            resources.defer("probe cancellation link", () => {
              resources.signal.removeEventListener("abort", cancel);
              cancel();
            });
            socket.once("close", () => {
              closed = true;
            });
            return socket;
          },
        },
      ),
    );
    const outcome = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await destructionRequested;
      await Promise.resolve();
      assert.equal(closed, false, "a requested destroy is not native close");
      assert.equal(
        settled,
        false,
        "response classification cannot release the pending socket",
      );
    } finally {
      release?.();
      await outcome;
    }
    assert.deepEqual(await pending, { state: "alive" });
    assert.equal(
      closed,
      true,
      "the exact client close event precedes probe settlement",
    );
  });
});
