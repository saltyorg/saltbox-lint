import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, Socket, type AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  processLifetimeDescriptor,
  processLifetimeEnvironment,
  runProcess,
  type ProcessAdapters,
} from "../../src/process.ts";
import { withTestResources } from "../support/test-resources.ts";

const base = { executable: process.execPath, cwd: process.cwd() };
const readinessTimeoutMs = 15000;
const terminationTimeoutMs = 10000;

/** Bound one observation; the timer is always released. */
async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  failure: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure()), milliseconds);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    clearTimeout(timer);
  }
}

test("the owner lifetime pipe stays open until the joined child closes", async () => {
  assert.equal(processLifetimeEnvironment, "SALTBOX_LINT_EDITOR_LIFETIME");
  assert.equal(processLifetimeDescriptor, 3);
  const events: string[] = [];
  let lifetime: Socket | undefined;
  let observed:
    | { destroyed: boolean; writableEnded: boolean; readableEnded: boolean }
    | undefined;
  const adapters: ProcessAdapters = {
    spawn(file, args, options) {
      assert.ok(Array.isArray(options.stdio));
      assert.deepEqual(Array.from(options.stdio), [
        "ignore",
        "pipe",
        "pipe",
        "pipe",
      ]);
      // A private IPC control holds the child until the parent has observed
      // its own lifetime end; the production stdio entries stay unchanged.
      const child = spawn(file, args, {
        ...options,
        stdio: [...(options.stdio as ("pipe" | "ignore")[]), "ipc"],
      });
      const pipe = child.stdio[3];
      assert.ok(pipe instanceof Socket);
      lifetime = pipe;
      pipe.once("close", () => events.push("lifetime closed"));
      child.once("exit", () => events.push("child exited"));
      child.once("close", () => events.push("child closed"));
      child.on("message", (message) => {
        if (message !== "ready") return;
        observed = {
          destroyed: pipe.destroyed,
          writableEnded: pipe.writableEnded,
          readableEnded: pipe.readableEnded,
        };
        child.send("finish");
      });
      return child;
    },
  };
  const output = await runProcess(
    {
      ...base,
      // A request environment cannot redirect the lifetime descriptor.
      env: { [processLifetimeEnvironment]: "4" },
      // POSIX fstat identifies the pipe. Windows fstat does not classify pipe
      // handles, so there the proof is net.Socket({fd}), which throws
      // ERR_INVALID_FD_TYPE unless Node's handle probe reports a pipe or TCP.
      args: [
        "-e",
        'const fs=require("node:fs");const kind=fs.fstatSync(3);const lifetime=new (require("node:net").Socket)({fd:3,readable:true,writable:false});const pipe=process.platform==="win32"||kind.isFIFO()||kind.isSocket();let ended=false;lifetime.on("end",()=>{ended=true});lifetime.resume();process.once("message",()=>{lifetime.unref();process.stdout.write(JSON.stringify({env:process.env.SALTBOX_LINT_EDITOR_LIFETIME,pipe,ended}),()=>process.disconnect());});process.send("ready");',
      ],
    },
    new AbortController().signal,
    undefined,
    undefined,
    adapters,
  );
  assert.deepEqual(JSON.parse(output), { env: "3", pipe: true, ended: false });
  // While the child was live, this owner had neither ended nor closed it.
  assert.deepEqual(observed, {
    destroyed: false,
    writableEnded: false,
    readableEnded: false,
  });
  // The parent's end closes only after the child released it, and the
  // operation settles only after that closure has been joined.
  assert.equal(lifetime?.destroyed, true);
  assert.deepEqual(events.toSorted(), [
    "child closed",
    "child exited",
    "lifetime closed",
  ]);
  assert.equal(events.at(-1), "child closed");
});

test("host death closes the lifetime pipe of an owned child", async () => {
  await withTestResources({ cleanupTimeoutMs: 10000 }, async (resources) => {
    const server = createServer();
    const connections = new Set<Socket>();
    const transportErrors: string[] = [];
    server.on("connection", (connection) => {
      connections.add(connection);
      // A Windows job termination resets the connection; 'close' still
      // follows and remains the completion observation.
      connection.on("error", (error: NodeJS.ErrnoException) =>
        transportErrors.push(error.code ?? error.message),
      );
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    resources.defer("lifetime listener", async () => {
      // Closing the payload connection also ends any surviving payload.
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await listening;
    const { port } = server.address() as AddressInfo;
    const accepted = once(server, "connection") as Promise<[Socket]>;
    // The payload stands in for the CLI: it reports readiness, then reports
    // lifetime EOF before exiting.
    const payload = `const net=require("node:net");const c=net.connect(${port},"127.0.0.1",()=>c.write("ready "+process.pid+"\\n"));const lifetime=new net.Socket({fd:3,readable:true,writable:false});lifetime.resume();lifetime.on("end",()=>c.end("lost\\n",()=>process.exit(0)));c.on("end",()=>process.exit(0));c.on("error",()=>process.exit(0));`;
    const processModule = pathToFileURL(
      join(import.meta.dirname, "../../src/process.ts"),
    ).href;
    const host = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `const {runProcess}=await import(${JSON.stringify(processModule)});await runProcess({executable:process.execPath,cwd:process.cwd(),args:["-e",${JSON.stringify(payload)}],timeoutMs:600000},new AbortController().signal);`,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const hostClosed = once(host, "close");
    resources.defer("editor host", async () => {
      host.kill("SIGKILL");
      await hostClosed;
    });
    // An early host exit, such as a payload without its lifetime descriptor,
    // fails readiness instead of waiting for a connection.
    const [connection] = await within(
      Promise.race([
        accepted,
        hostClosed.then(() => {
          throw new Error("Editor host closed before payload readiness");
        }),
      ]),
      readinessTimeoutMs,
      () => new Error("Payload did not connect"),
    );
    connection.setEncoding("utf8");
    let received = "";
    const closed = new Promise<void>((resolve) =>
      connection.once("close", () => resolve()),
    );
    const ready = new Promise<void>((resolve, reject) => {
      connection.on("data", (data: string) => {
        received += data;
        if (received.includes("\n")) resolve();
      });
      connection.once("close", () =>
        reject(new Error(`Payload closed before readiness: ${received}`)),
      );
    });
    await within(
      ready,
      readinessTimeoutMs,
      () => new Error(`Payload readiness timed out: ${received}`),
    );
    assert.match(received, /^ready \d+\n$/);
    assert.notEqual(Number(received.split(" ")[1]), host.pid);
    // The host dies without deactivation, timers or process cleanup.
    host.kill("SIGKILL");
    await hostClosed;
    await within(
      closed,
      terminationTimeoutMs,
      () => new Error(`Owned child survived host death: ${received}`),
    );
    // POSIX children are detached, so only the lifetime pipe can stop them.
    // On Windows libuv's kill-on-close job may terminate the child first.
    if (process.platform !== "win32") {
      assert.equal(received, received.split("\n")[0] + "\nlost\n");
      assert.deepEqual(transportErrors, []);
    }
  });
});
