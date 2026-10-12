import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  reserveProcess,
  processSupervisorEnvironment,
} from "../../src/process-reservation.ts";
import { runProcess } from "../../src/process.ts";
import { withTestResources } from "../support/test-resources.ts";

type Message = Record<string, unknown>;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function withPeer<T>(
  onMessage: (socket: Socket, message: Message) => void,
  body: (peer: {
    environment: string;
    records: Message[];
    reservation: Promise<Socket>;
    completion: Promise<{ socket: Socket; message: Message }>;
    sockets: Set<Socket>;
  }) => Promise<T>,
): Promise<T> {
  return withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
    const reserved = deferred<Socket>(),
      completed = deferred<{ socket: Socket; message: Message }>();
    const sockets = new Set<Socket>(),
      closures: Promise<void>[] = [],
      records: Message[] = [],
      failures: unknown[] = [];
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
        .setEncoding("utf8")
        .on("error", () => {})
        .on("data", (chunk: string) => {
          buffer += chunk;
          while (buffer.includes("\n")) {
            const at = buffer.indexOf("\n"),
              line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            try {
              const message: Message = JSON.parse(line);
              records.push(message);
              if (message.type === "reserve") reserved.resolve(socket);
              else completed.resolve({ socket, message });
              onMessage(socket, message);
            } catch (error) {
              failures.push(error);
              socket.destroy();
            }
          }
        });
    });
    resources.defer("TCP peer", async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      await Promise.all(closures);
      await closed;
      assert.deepEqual(failures, []);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return body({
      environment: JSON.stringify({
        address: `127.0.0.1:${address.port}`,
        token: "a".repeat(64),
      }),
      records,
      reservation: reserved.promise,
      completion: completed.promise,
      sockets,
    });
  });
}
function answer(socket: Socket, message: Message) {
  if (message.type === "reserve") socket.write('{"reserved":true}\n');
  else socket.end('{"completed":true}\n');
}
const native = { executable: process.execPath, cwd: process.cwd() };
const posix = { skip: process.platform === "win32" };

test(
  "reservation ACK precedes native spawn and joined completion follows actual close",
  posix,
  async () => {
    await withPeer(
      (socket, message) => {
        if (message.type !== "reserve") socket.end('{"completed":true}\n');
      },
      async (peer) => {
        let spawned = false,
          closed = false,
          pid: number | undefined;
        const pending = runProcess(
          {
            ...native,
            args: ["-e", 'process.stdout.write("owned")'],
            env: { [processSupervisorEnvironment]: peer.environment },
          },
          new AbortController().signal,
          undefined,
          {
            spawned(actual) {
              spawned = true;
              pid = actual;
            },
            closed() {
              closed = true;
            },
          },
        );
        const outcome = pending.then(
          (output) => ({ output }),
          (error: unknown) => ({ error }),
        );
        const socket = await peer.reservation;
        assert.equal(spawned, false);
        socket.write('{"reserved":true}\n');
        assert.deepEqual((await peer.completion).message, {
          joined: true,
          pid,
        });
        assert.equal(closed, true);
        assert.deepEqual(await outcome, { output: "owned" });
        assert.match(String(peer.records[0].nonce), /^[0-9a-f]{64}$/);
      },
    );
  },
);

test(
  "admission cancellation completes an independent no-child reservation",
  posix,
  async () => {
    await withPeer(
      (socket, message) => {
        if (message.type !== "reserve") socket.end('{"completed":true}\n');
      },
      async (peer) => {
        const abort = new AbortController();
        let spawned = false;
        const failed = assert.rejects(
          runProcess(
            {
              ...native,
              args: ["-e", "setInterval(()=>{},1000)"],
              env: { [processSupervisorEnvironment]: peer.environment },
            },
            abort.signal,
            undefined,
            {
              spawned() {
                spawned = true;
              },
            },
          ),
          /Canceled/,
        );
        const socket = await peer.reservation;
        abort.abort();
        socket.write('{"reserved":true}\n');
        assert.deepEqual((await peer.completion).message, { cancel: true });
        await failed;
        assert.equal(spawned, false);
      },
    );
  },
);

test(
  "spawned cancellation before Go binding remains a joined-child completion",
  posix,
  async () => {
    await withPeer(answer, async (peer) => {
      const abort = new AbortController();
      let pid: number | undefined,
        closed = false;
      await assert.rejects(
        runProcess(
          {
            ...native,
            args: ["-e", "setInterval(()=>{},1000)"],
            env: { [processSupervisorEnvironment]: peer.environment },
          },
          abort.signal,
          undefined,
          {
            spawned(actual) {
              pid = actual;
              abort.abort();
            },
            closed() {
              closed = true;
            },
          },
        ),
        /Canceled/,
      );
      assert.equal(closed, true);
      assert.deepEqual(peer.records[1], { joined: true, pid });
    });
  },
);

test(
  "missing executable cancels instead of claiming a joined child",
  posix,
  async () => {
    await withPeer(answer, async (peer) => {
      await assert.rejects(
        runProcess(
          {
            ...native,
            executable: "/saltbox-absent-reservation-executable",
            args: [],
            env: { [processSupervisorEnvironment]: peer.environment },
          },
          new AbortController().signal,
        ),
      );
      assert.deepEqual(peer.records[1], { cancel: true });
    });
  },
);

test(
  "failure observation awaits ownership ACK and closure",
  posix,
  async () => {
    await withPeer(
      (socket, message) => {
        if (message.type === "reserve") socket.write('{"reserved":true}\n');
      },
      async (peer) => {
        const labels: string[] = [];
        const failure = runProcess(
          {
            ...native,
            args: ["-e", "process.exit(2)"],
            env: { [processSupervisorEnvironment]: peer.environment },
          },
          new AbortController().signal,
          (label) => labels.push(label),
        ).catch((error: unknown) => error);
        const { socket } = await peer.completion;
        assert.deepEqual(labels, []);
        socket.end('{"completed":true}\n');
        assert.match(String(await failure), /exited with status 2/);
        assert.deepEqual(labels, ["exit-status"]);
      },
    );
  },
);

test(
  "process failure and ownership failure are both retained",
  posix,
  async () => {
    await withPeer(
      (socket, message) => {
        if (message.type === "reserve") socket.write('{"reserved":true}\n');
        else socket.destroy();
      },
      async (peer) => {
        const labels: string[] = [];
        await assert.rejects(
          runProcess(
            {
              ...native,
              args: ["-e", "process.exit(2)"],
              env: { [processSupervisorEnvironment]: peer.environment },
            },
            new AbortController().signal,
            (label) => labels.push(label),
          ),
          (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.match(String(error.errors[0]), /exited with status 2/);
            assert.match(
              String(error.errors[1]),
              /reservation connection closed/,
            );
            return true;
          },
        );
        assert.deepEqual(labels, ["exit-status"]);
      },
    );
  },
);

test(
  "ownership connection loss stops and joins the live native child",
  posix,
  async () => {
    await withPeer(answer, async (peer) => {
      let closed = false;
      const labels: string[] = [];
      await assert.rejects(
        runProcess(
          {
            ...native,
            args: ["-e", "setInterval(()=>{},1000)"],
            env: { [processSupervisorEnvironment]: peer.environment },
          },
          new AbortController().signal,
          (label) => labels.push(label),
          {
            spawned() {
              for (const socket of peer.sockets) socket.destroy();
            },
            closed() {
              closed = true;
            },
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.match(String(error.errors[0]), /Canceled/);
          assert.match(
            String(error.errors[1]),
            /reservation connection closed/,
          );
          return true;
        },
      );
      assert.equal(closed, true);
      assert.deepEqual(labels, ["termination"]);
    });
  },
);

test("nonce forwarding preserves the caller's environment", posix, async () => {
  await withPeer(answer, async (peer) => {
    const env = Object.freeze({
      [processSupervisorEnvironment]: peer.environment,
    });
    const output = await runProcess(
      {
        ...native,
        args: [
          "-e",
          `process.stdout.write(process.env.${processSupervisorEnvironment})`,
        ],
        env,
      },
      new AbortController().signal,
    );
    assert.equal(JSON.parse(output).nonce, peer.records[0].nonce);
    assert.equal(env[processSupervisorEnvironment], peer.environment);
  });
});

test(
  "post-spawn setup failure joins the actual child before completing ownership",
  posix,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "saltbox-setup-join-"));
    const gate = join(directory, "release");
    const closed = deferred<void>();
    let childClosed = false;
    try {
      await withPeer(answer, async (peer) => {
        try {
          await assert.rejects(
            runProcess(
              {
                ...native,
                args: [
                  "-e",
                  'const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);}},10);',
                  gate,
                ],
                // Deliberately invalid runtime input makes stdin.end fail after spawn.
                input: Object.create(null) as Uint8Array,
                env: { [processSupervisorEnvironment]: peer.environment },
              },
              new AbortController().signal,
              undefined,
              {
                closed() {
                  childClosed = true;
                  closed.resolve();
                },
              },
            ),
          );
          assert.equal(
            childClosed,
            true,
            "setup rejection must still join native close",
          );
        } finally {
          await writeFile(gate, "");
          await closed.promise;
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("invalid configuration and already-canceled work admit no socket", async () => {
  for (const value of [
    "",
    "not JSON",
    "null",
    "[]",
    JSON.stringify({ address: "localhost:1", token: "a".repeat(64) }),
    JSON.stringify({ address: "127.0.0.1:01", token: "a".repeat(64) }),
    JSON.stringify({ address: "127.0.0.1:65536", token: "a".repeat(64) }),
    JSON.stringify({ address: "127.0.0.1:1", token: "A".repeat(64) }),
    JSON.stringify({
      address: "127.0.0.1:1",
      token: "a".repeat(64),
      nonce: "b".repeat(64),
    }),
  ])
    await assert.rejects(
      reserveProcess(value, new AbortController().signal),
      /Invalid process supervisor configuration/,
    );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    reserveProcess("private invalid configuration", abort.signal),
    /Canceled/,
  );
});

test("strict reservation acknowledgements reject invalid frames and join sockets", async () => {
  for (const ack of [
    '{"reserved":false}\n',
    '{"reserved":true,"extra":1}\n',
    "[]\n",
    '{"completed":true}\n',
    '{"reserved":true}\nextra',
    '{"reserved":',
  ]) {
    await withPeer(
      (socket) => socket.end(ack),
      async (peer) => {
        await assert.rejects(
          reserveProcess(peer.environment, new AbortController().signal),
          /acknowledgement|connection closed/,
        );
      },
    );
  }
});

test("completion is idempotent while invalid PID and outcome changes fail", async () => {
  await withPeer(answer, async (peer) => {
    const reservation = await reserveProcess(
      peer.environment,
      new AbortController().signal,
    );
    for (const pid of [0, 1, NaN, Infinity, 1.5])
      await assert.rejects(
        reservation.completeJoinedChild(pid),
        /actual native PID/,
      );
    assert.equal(peer.records.length, 1);
    const completion = reservation.cancelNoChild();
    assert.equal(reservation.cancelNoChild(), completion);
    await completion;
    await assert.rejects(reservation.completeJoinedChild(123), /cannot change/);
    assert.deepEqual(peer.records[1], { cancel: true });
  });
});

test("independent cleanup timeout destroys and joins the socket after work cancellation", async () => {
  await withPeer(
    (socket, message) => {
      if (message.type === "reserve") socket.write('{"reserved":true}\n');
    },
    async (peer) => {
      const abort = new AbortController();
      const reservation = await reserveProcess(peer.environment, abort.signal, {
        cleanupTimeoutMs: 30,
      });
      abort.abort();
      await assert.rejects(reservation.cancelNoChild(), /cleanup timed out/);
      assert.equal(reservation.signal.aborted, true);
    },
  );
});
