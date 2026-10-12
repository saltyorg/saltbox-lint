import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcess } from "../../src/process.ts";
import { processSupervisorEnvironment } from "../../src/process-reservation.ts";
import { createLiveProcessTracker } from "../support/live-processes.ts";
import { withTestResources } from "../support/test-resources.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withReservationPeer(
  body: (peer: {
    environment: string;
    reserved: Promise<Socket>;
    completed: Promise<{ socket: Socket; message: Record<string, unknown> }>;
    acknowledgeReservation(): void;
    release(): void;
  }) => Promise<void>,
) {
  await withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
    const reserved = deferred<Socket>();
    const completed = deferred<{
      socket: Socket;
      message: Record<string, unknown>;
    }>();
    const sockets = new Set<Socket>();
    const closures: Promise<void>[] = [];
    let automatic = false;
    let acknowledged = false;
    let reserveSocket: Socket | undefined;
    let completeSocket: Socket | undefined;
    const server = createServer((socket) => {
      sockets.add(socket);
      closures.push(
        new Promise<void>((resolve) =>
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          }),
        ),
      );
      let buffer = "";
      socket
        .on("error", () => {})
        .setEncoding("utf8")
        .on("data", (chunk: string) => {
          buffer += chunk;
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n");
            const message: Record<string, unknown> = JSON.parse(
              buffer.slice(0, end),
            );
            buffer = buffer.slice(end + 1);
            if (message.type === "reserve") {
              reserveSocket = socket;
              reserved.resolve(socket);
              if (automatic) {
                acknowledged = true;
                socket.write('{"reserved":true}\n');
              }
            } else {
              completeSocket = socket;
              completed.resolve({ socket, message });
              if (automatic) socket.end('{"completed":true}\n');
            }
          }
        });
    });
    resources.defer("reservation peer", async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      await Promise.all(closures);
      await closed;
    });
    await new Promise<void>((resolve, reject) =>
      server.once("error", reject).listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await body({
      environment: JSON.stringify({
        address: `127.0.0.1:${address.port}`,
        token: "a".repeat(64),
      }),
      reserved: reserved.promise,
      completed: completed.promise,
      acknowledgeReservation() {
        assert.ok(reserveSocket);
        acknowledged = true;
        reserveSocket.write('{"reserved":true}\n');
      },
      release() {
        automatic = true;
        if (reserveSocket && !acknowledged && !reserveSocket.destroyed) {
          acknowledged = true;
          reserveSocket.write('{"reserved":true}\n');
        }
        if (
          completeSocket &&
          !completeSocket.writableEnded &&
          !completeSocket.destroyed
        )
          completeSocket.end('{"completed":true}\n');
      },
    });
  });
}

test("a real pre-spawn canceled reservation settles as no child without a phantom native close", async () => {
  const tracker = createLiveProcessTracker(runProcess);
  const cancel = new AbortController();
  if (process.platform === "win32") {
    cancel.abort();
    await assert.rejects(
      tracker.runner(
        { executable: process.execPath, cwd: process.cwd(), args: ["-e", ""] },
        cancel.signal,
      ),
      /Canceled/,
    );
  } else {
    await withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
      const directory = await mkdtemp(
        join(tmpdir(), "saltbox-live-admission-"),
      );
      resources.defer("admission marker directory", () =>
        rm(directory, { recursive: true, force: true }),
      );
      const marker = join(directory, "spawned");
      await withReservationPeer(async (peer) => {
        const pending = tracker.runner(
          {
            executable: process.execPath,
            cwd: process.cwd(),
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)},'created')`,
            ],
            env: { [processSupervisorEnvironment]: peer.environment },
          },
          cancel.signal,
        );
        const outcome = pending.then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          const socket = await peer.reserved;
          assert.equal(tracker.requests.length, 1);
          assert.equal(tracker.invocations.length, 0);
          cancel.abort();
          peer.acknowledgeReservation();
          const completion = await peer.completed;
          assert.deepEqual(completion.message, { cancel: true });
          assert.equal(
            tracker.requests[0].settled,
            undefined,
            "the independent no-child cleanup ACK is still owned",
          );
          assert.throws(() => tracker.assertJoined(), /admitted/);
          assert.equal(existsSync(marker), false);
          completion.socket.end('{"completed":true}\n');
          assert.match(String(await outcome), /Canceled/);
          assert.equal(existsSync(marker), false);
        } finally {
          cancel.abort();
          peer.release();
          await outcome;
        }
      });
    });
  }
  assert.deepEqual(tracker.accounting(), {
    admitted: 1,
    settled: 1,
    cancelledBeforeSpawn: 1,
  });
  assert.equal(tracker.invocations.length, 0);
  tracker.assertJoined();
});

test("actual native close does not substitute for the runner's reservation completion", async () => {
  const tracker = createLiveProcessTracker(runProcess);
  const cancel = new AbortController();
  const request = {
    executable: process.execPath,
    cwd: process.cwd(),
    args: ["-e", "process.stdout.write('owned')"],
  };
  if (process.platform === "win32") {
    assert.equal(await tracker.runner(request, cancel.signal), "owned");
  } else {
    await withReservationPeer(async (peer) => {
      const pending = tracker.runner(
        {
          ...request,
          env: { [processSupervisorEnvironment]: peer.environment },
        },
        cancel.signal,
      );
      const outcome = pending.then(
        (output) => ({ output }),
        (error: unknown) => ({ error }),
      );
      try {
        await peer.reserved;
        peer.acknowledgeReservation();
        const completion = await peer.completed;
        assert.equal(completion.message.joined, true);
        assert.equal(tracker.invocations.length, 1);
        assert.ok(tracker.invocations[0].closed !== undefined);
        assert.equal(tracker.requests[0].settled, undefined);
        assert.throws(() => tracker.assertJoined(), /admitted/);
        completion.socket.end('{"completed":true}\n');
        assert.deepEqual(await outcome, { output: "owned" });
      } finally {
        cancel.abort();
        peer.release();
        await outcome;
      }
    });
  }
  tracker.assertJoined();
  assert.deepEqual(tracker.accounting(), {
    admitted: 1,
    settled: 1,
    cancelledBeforeSpawn: 0,
  });
});

test("a real ENOENT request cannot become a canceled no-child exemption", async () => {
  const tracker = createLiveProcessTracker(runProcess);
  const request = {
    executable: process.execPath + ".missing-live-collector",
    cwd: process.cwd(),
    args: ["--version"],
  };
  if (process.platform === "win32") {
    await assert.rejects(
      tracker.runner(request, new AbortController().signal),
      /ENOENT/,
    );
  } else {
    await withReservationPeer(async (peer) => {
      const pending = tracker.runner(
        {
          ...request,
          env: { [processSupervisorEnvironment]: peer.environment },
        },
        new AbortController().signal,
      );
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await peer.reserved;
        peer.acknowledgeReservation();
        const completion = await peer.completed;
        assert.deepEqual(completion.message, { cancel: true });
        completion.socket.end('{"completed":true}\n');
        assert.match(String(await outcome), /ENOENT/);
      } finally {
        peer.release();
        await outcome;
      }
    });
  }
  assert.equal(tracker.invocations.length, 0);
  assert.equal(tracker.accounting().cancelledBeforeSpawn, 0);
  assert.throws(() => tracker.assertJoined(), /explicit canceled/);
});

for (const behavior of [
  "successful no child",
  "setup no child",
  "missing native pid",
  "missing native close",
  "cancel cleanup failure",
] as const) {
  test(`live process accounting rejects ${behavior}`, async () => {
    const tracker = createLiveProcessTracker(
      async (_request, _signal, failure, lifecycle) => {
        if (behavior === "setup no child") {
          failure?.("setup");
          throw new Error("setup rejected");
        }
        if (behavior === "cancel cleanup failure") {
          failure?.("cancelled");
          throw new AggregateError([
            new Error("Canceled"),
            new Error("ownership cleanup failed"),
          ]);
        }
        if (behavior === "missing native pid") lifecycle?.spawned?.(undefined);
        if (behavior === "missing native close") lifecycle?.spawned?.(123);
        return "invalid completion";
      },
    );
    const cancellation = new AbortController();
    if (behavior === "cancel cleanup failure") cancellation.abort();
    await tracker
      .runner(
        { executable: "fixture", cwd: "fixture", args: ["check"] },
        cancellation.signal,
      )
      .catch(() => undefined);
    assert.throws(() => tracker.assertJoined());
  });
}
