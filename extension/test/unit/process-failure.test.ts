import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";
import type { runProcess } from "../../src/process.ts";
import { processFailureCategories } from "../../src/process-failure.ts";

// Compile the actual process owner with only its spawn boundary controlled.
// No native process, editor host, listener campaign or wall-clock wait is added.
const bundled = await build({
  entryPoints: ["src/process.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "owned-process-boundary",
      setup(builder) {
        builder.onResolve({ filter: /^node:child_process$/ }, () => ({
          path: "spawn",
          namespace: "owned-process-boundary",
        }));
        builder.onLoad(
          { filter: /.*/, namespace: "owned-process-boundary" },
          () => ({
            contents: "export const spawn = globalThis.processIO.spawn",
            loader: "js",
          }),
        );
      },
    },
  ],
});

function control() {
  const child = Object.assign(new EventEmitter(), {
    pid: 701,
    stdin: Object.assign(new EventEmitter(), {
      end: (...args: unknown[]) => operations.push(["stdin", ...args]),
    }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => {
      operations.push(["kill"]);
      if (terminationError) throw terminationError;
      return true;
    },
  });
  const operations: unknown[][] = [];
  const timers: { callback: () => void; milliseconds: number }[] = [];
  const constructed: Error[] = [];
  const abort = new AbortController();
  let setupError: unknown;
  let terminationError: Error | undefined;
  const module = { exports: {} as { runProcess: typeof runProcess } };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process: { platform: "win32", env: { HELD_ENVIRONMENT: "exact" } },
    Buffer,
    TextDecoder,
    Error: class extends Error {
      constructor(message: string) {
        super(message);
        constructed.push(this);
      }
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      timers.push({ callback, milliseconds });
      operations.push(["timer", milliseconds]);
      return timers.length;
    },
    clearTimeout: (timer: number) => operations.push(["clear", timer]),
    processIO: {
      spawn: (...args: unknown[]) => {
        operations.push(["spawn", ...args]);
        if (setupError) throw setupError;
        return child;
      },
    },
  });
  return {
    child,
    abort,
    operations,
    timers,
    constructed,
    run: module.exports.runProcess,
    setup(error: unknown) {
      setupError = error;
    },
    termination(error: Error) {
      terminationError = error;
    },
  };
}
const request = {
  executable: "held-executable",
  cwd: "held-cwd",
  args: ["literal; $(false)"],
  input: Uint8Array.from([255, 13, 10]),
};

for (const category of processFailureCategories) {
  for (const observerThrows of [false, true]) {
    test(`actual ${category} rejection preserves the boundary when observer throws=${observerThrows}`, async () => {
      const owned = control();
      const labels: string[] = [];
      const original = new Error("private original failure");
      Object.defineProperty(original, "message", {
        get() {
          assert.fail("classification must not read the error message");
        },
      });
      if (category === "setup") owned.setup(original);
      if (category === "cancelled") owned.abort.abort();
      const pending = owned.run(
        category === "output-limit" ? { ...request, maxBytes: 1 } : request,
        owned.abort.signal,
        (label) => {
          labels.push(label);
          owned.operations.push(["observed", label]);
          if (observerThrows) throw new Error("observer failure");
        },
      );
      let settled = false;
      const caught = pending.then(
        () => assert.fail("expected rejection"),
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      if (category !== "setup" && category !== "cancelled") {
        if (category === "spawn") owned.child.emit("error", original);
        if (category === "stdin") owned.child.stdin.emit("error", original);
        if (category === "termination") {
          owned.termination(original);
          owned.child.emit("exit", 0);
        }
        if (category === "timeout") owned.timers[0].callback();
        if (category === "output-limit")
          owned.child.stdout.emit("data", Buffer.from("overflow"));
        if (category === "stderr")
          owned.child.stderr.emit("data", Buffer.from("private stderr"));
        if (category === "utf8")
          owned.child.stdout.emit("data", Buffer.from([255]));
        await Promise.resolve();
        assert.equal(settled, false, "rejection still joins child close");
        assert.deepEqual(labels, [], "observation runs only at rejection");
        owned.child.emit("close", category === "exit-status" ? 2 : 0);
      }
      const error = await caught;
      assert.deepEqual(labels, [category]);
      if (["setup", "spawn", "stdin", "termination"].includes(category))
        assert.equal(error, original);
      else {
        assert.ok(error instanceof Error);
        assert.equal(error, owned.constructed[0]);
      }
      if (category !== "setup" && category !== "cancelled") {
        assert.deepEqual(owned.operations.slice(-2), [
          ["clear", 1],
          ["observed", category],
        ]);
        assert.equal(owned.timers[0].milliseconds, 60000);
      }
      if (category === "cancelled")
        assert.deepEqual(owned.operations, [["observed", category]]);
    });
  }
}

test("first stored error and category survive later stdin, termination, timeout and abort events", async () => {
  for (const first of [
    "spawn",
    "stdin",
    "termination",
    "timeout",
    "output-limit",
    "cancelled",
  ] as const) {
    const owned = control();
    const original = new Error("first original error");
    const labels: string[] = [];
    const pending = owned.run(
      { ...request, maxBytes: 1 },
      owned.abort.signal,
      (label) => labels.push(label),
    );
    const caught = pending.catch((error: unknown) => error);
    if (first === "spawn") owned.child.emit("error", original);
    if (first === "stdin") owned.child.stdin.emit("error", original);
    if (first === "termination") {
      owned.termination(original);
      owned.child.emit("exit", 0);
    }
    if (first === "timeout") owned.timers[0].callback();
    if (first === "output-limit")
      owned.child.stdout.emit("data", Buffer.from("too large"));
    if (first === "cancelled") owned.abort.abort();
    owned.termination(new Error("later kill error"));
    owned.child.stdin.emit("error", new Error("later stdin error"));
    owned.child.emit("error", new Error("later spawn error"));
    owned.timers[0].callback();
    owned.abort.abort();
    owned.child.stderr.emit("data", Buffer.from("later stderr"));
    assert.deepEqual(labels, []);
    owned.child.emit("close", 2);
    const error = await caught;
    assert.deepEqual(labels, [first]);
    if (["spawn", "stdin", "termination"].includes(first))
      assert.equal(error, original);
    else {
      assert.ok(error instanceof Error);
      assert.equal(error, owned.constructed[0]);
    }
  }
});

test("absent observer and success preserve argv, input, defaults and stream operations", async () => {
  for (const observe of [
    undefined,
    () => assert.fail("success must not observe a failure"),
  ]) {
    const owned = control();
    const pending = owned.run(
      { ...request, successCodes: [3], timeoutMs: 700, maxBytes: 4 },
      owned.abort.signal,
      observe,
    );
    const spawning = owned.operations[0];
    assert.deepEqual(spawning.slice(0, 3), [
      "spawn",
      request.executable,
      request.args,
    ]);
    const options = spawning[3] as {
      cwd: string;
      shell: boolean;
      windowsHide: boolean;
      detached: boolean;
      stdio: string[];
      env: Record<string, string>;
    };
    assert.equal(options.cwd, request.cwd);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, false);
    assert.deepEqual(Array.from(options.stdio), ["pipe", "pipe", "pipe"]);
    assert.equal(options.env.SALTBOX_LINT_EDITOR_PROCESS, "1");
    assert.equal(options.env.HELD_ENVIRONMENT, "exact");
    assert.equal(owned.operations[2][1], request.input);
    assert.equal(owned.operations[2][2], "utf8");
    assert.equal(owned.timers[0].milliseconds, 700);
    owned.child.stdout.emit("data", Buffer.from("pass"));
    owned.child.emit("exit", 3);
    owned.child.emit("close", 3);
    assert.equal(await pending, "pass");
    owned.abort.abort();
    assert.deepEqual(
      owned.operations.slice(3),
      [["kill"], ["clear", 1]],
      "abort listener removed after close",
    );
  }
});

test("default absent rejection observer preserves the original error and close join", async () => {
  const owned = control();
  const error = new Error("held original error");
  const pending = owned.run(request, owned.abort.signal);
  const caught = pending.catch((actual: unknown) => actual);
  owned.child.emit("error", error);
  owned.child.emit("close", 1);
  assert.equal(await caught, error);
  assert.deepEqual(
    owned.operations.map((item) => item[0]),
    ["spawn", "timer", "stdin", "clear"],
  );
});
