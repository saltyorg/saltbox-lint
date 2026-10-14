import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  runProcess,
  type ProcessAdapters,
  type ProcessLifecycleObserver,
  type ProcessTerminationContext,
} from "../../src/process.ts";
import {
  groupHasLiveMembers,
  liveGroupMembers,
  type GroupQueryDependencies,
  type QueryError,
} from "../../src/native-group.ts";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { hostFailureEvidence } from "../support/host-failure.ts";
import { withTestResources } from "../support/test-resources.ts";

test("a no-input request omits the writer that rejects a closed owned child pipe", async () => {
  const joins: Promise<void>[] = [];
  const gateErrors: Error[] = [];
  const observations: {
    stdin: string;
    error?: string;
    code?: number | null;
    peerClosed: boolean;
    ready: boolean;
    forwarded: boolean;
    callback?: string | null;
    exited?: boolean;
  }[] = [];
  const adapters: ProcessAdapters = {
    spawn(file, args, options) {
      const stdio = options!.stdio as ["pipe" | "ignore", "pipe", "pipe"];
      const child = spawn(file, args, {
        ...options,
        // fd0 remains open in Windows libuv even after fs.closeSync(0).
        // This controlled peer uses fd3 so public Socket.destroy really
        // closes it. Normal stdin UTF8 and EOF use unmodified spawn below.
        stdio: ["ignore", stdio[1], stdio[2], "pipe", "ipc"],
      });
      const observation: (typeof observations)[number] = {
        stdin: stdio[0],
        peerClosed: false,
        ready: false,
        forwarded: false,
      };
      const peer = child.stdio[3];
      assert.ok(peer instanceof Socket);
      child.stdin = stdio[0] === "pipe" ? peer : null;
      observations.push(observation);
      child.on("message", (message) => {
        if (message === "peer-closed") observation.peerClosed = true;
      });
      child.once("exit", () => {
        observation.exited = true;
      });
      const finish = () =>
        child.send("finish", (error) => {
          if (error) gateErrors.push(error);
        });
      if (child.stdin) {
        const input = child.stdin;
        const end = input.end;
        // The child's ready output follows its stdin close. Delay only the
        // public stream operation until this exact state, without a sleep.
        Object.defineProperty(input, "end", {
          value: (...args: unknown[]) => {
            child.stdout!.once("data", () => {
              observation.ready = true;
              observation.forwarded = true;
              Reflect.apply(end, input, [
                ...args,
                (error?: NodeJS.ErrnoException | null) => {
                  observation.callback = error?.code ?? null;
                },
              ]);
            });
            return input;
          },
        });
        input.on("error", (error: NodeJS.ErrnoException) => {
          observation.error = error.code;
        });
      } else
        child.stdout!.once("data", () => {
          observation.ready = true;
          finish();
        });
      joins.push(
        new Promise<void>((resolve) => {
          child.once("close", (code) => {
            observation.code = code;
            resolve();
          });
        }),
      );
      return child;
    },
  };
  const abort = new AbortController();
  const request = {
    executable: process.execPath,
    cwd: process.cwd(),
    args: [
      "-e",
      // Initialize output and IPC before closing the dedicated owned peer.
      'const output=process.stdout;process.on("message",()=>process.exit(0));const input=new (require("node:net").Socket)({fd:3,readable:true,writable:false});input.once("close",()=>process.send("peer-closed",(error)=>{if(error)throw error;output.write("v1\\n");}));input.destroy();',
    ],
  };
  try {
    assert.equal(
      await runProcess(request, abort.signal, undefined, undefined, adapters),
      "v1\n",
    );
    await Promise.all(joins);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].stdin, "ignore");
    assert.equal(observations[0].code, 0);
    assert.equal(observations[0].peerClosed, true);
    assert.equal(observations[0].exited, true);
    assert.equal(observations[0].ready, true);
    assert.equal(observations[0].forwarded, false);
    assert.deepEqual(gateErrors, []);
    await assert.rejects(
      runProcess(
        { ...request, input: "source snapshot" },
        abort.signal,
        undefined,
        undefined,
        adapters,
      ),
      (error: NodeJS.ErrnoException) => error.code === "EPIPE",
    );
    await Promise.all(joins);
    assert.equal(observations[1].stdin, "pipe");
    assert.equal(observations[1].error, "EPIPE");
    assert.equal(observations[1].peerClosed, true);
    assert.equal(observations[1].exited, true);
    assert.equal(observations[1].callback, "EPIPE");
    assert.equal(observations[1].ready, true);
    assert.equal(observations[1].forwarded, true);
  } catch (error) {
    throw new Error(
      `Closed peer control phases: ${JSON.stringify(observations)}`,
      { cause: error },
    );
  } finally {
    abort.abort();
    await Promise.all(joins);
  }
});
const base = { executable: process.execPath, cwd: process.cwd() };
test("instance process observations receive native lifecycle without changing results", async () => {
  const events: string[] = [];
  assert.equal(
    await runProcess(
      {
        ...base,
        args: ["-e", 'process.stdout.write("owned");process.exitCode=1'],
        successCodes: [1],
      },
      new AbortController().signal,
      undefined,
      {
        spawned(pid) {
          assert.ok(pid);
          events.push("spawned");
          throw new Error("observer failure");
        },
        closed(code, signal) {
          assert.equal(code, 1);
          assert.equal(signal, null);
          events.push("closed");
          throw new Error("observer failure");
        },
      },
    ),
    "owned",
  );
  assert.deepEqual(events, ["spawned", "closed"]);
});
test("request environment is isolated and cannot disable editor ownership", async () => {
  const before = process.env.SALTBOX_PROCESS_REQUEST_TEST;
  const env = Object.freeze({
    SALTBOX_PROCESS_REQUEST_TEST: "request value",
    SALTBOX_LINT_EDITOR_PROCESS: "0",
  });
  const output = await runProcess(
    {
      ...base,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify([process.env.SALTBOX_PROCESS_REQUEST_TEST,process.env.SALTBOX_LINT_EDITOR_PROCESS,Boolean(process.env.PATH)]))",
      ],
      env,
    },
    new AbortController().signal,
  );
  assert.deepEqual(JSON.parse(output), ["request value", "1", true]);
  assert.equal(process.env.SALTBOX_PROCESS_REQUEST_TEST, before);
  assert.equal(env.SALTBOX_LINT_EDITOR_PROCESS, "0");
});
test("an explicit empty source snapshot still receives piped EOF", async () => {
  assert.equal(
    await runProcess(
      {
        ...base,
        args: [
          "-e",
          'process.stdin.on("end",()=>process.stdout.write("empty snapshot"));process.stdin.resume();',
        ],
        input: "",
      },
      new AbortController().signal,
    ),
    "empty snapshot",
  );
});
test("process sends exact UTF8 snapshot and argv without a shell", async () => {
  const result = await runProcess(
    {
      ...base,
      args: ["-e", "process.stdin.pipe(process.stdout)", "a; $(false)"],
      input: "a: 😀\r\n",
    },
    new AbortController().signal,
  );
  assert.equal(result, "a: 😀\r\n");
});
test("process sends raw unsupported UTF8 snapshot bytes without replacement", async () => {
  const bytes = Uint8Array.from([0xff, 0x00, 0x0d, 0x0a]);
  const result = await runProcess(
    {
      ...base,
      args: [
        "-e",
        'const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(chunks).toString("hex")));',
      ],
      input: bytes,
    },
    new AbortController().signal,
  );
  assert.equal(result, "ff000d0a");
});
test("process rejects stderr, operational failure and excessive output", async () => {
  for (const args of [
    ["-e", 'process.stderr.write("bad")'],
    ["-e", "process.exit(2)"],
    ["-e", 'process.stdout.write("x".repeat(10000))'],
  ]) {
    await assert.rejects(
      runProcess(
        { ...base, args, maxBytes: 100 },
        new AbortController().signal,
      ),
    );
  }
});
test("process deadline terminates a hung command", async () => {
  await assert.rejects(
    runProcess(
      { ...base, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 50 },
      new AbortController().signal,
    ),
  );
});
// Match the cancellation test's existing one-second observation window.
const terminationTimeoutMs = 1000;
function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}
async function processState(pid: number): Promise<string> {
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const state = /^\d+ \(.*\) ([A-Za-z]) /.exec(stat)?.[1];
      assert.ok(state, `Could not parse process ${pid} state: ${stat}`);
      return state;
    }
    throw new Error(
      "Native fixture observation requires its known Darwin identity",
    );
  } catch (error) {
    if (absent(error)) return "absent";
    throw error;
  }
}
async function awaitTermination(
  pid: number,
  timeoutMs = terminationTimeoutMs,
  observe: (pid: number, remainingMs: number) => Promise<string> = processState,
  timing: {
    now: () => number;
    wait: (milliseconds: number) => Promise<void>;
  } = { now: () => performance.now(), wait: delay },
): Promise<void> {
  const deadline = timing.now() + timeoutMs;
  let state = "unobserved";
  for (;;) {
    const remaining = deadline - timing.now();
    assert.ok(
      remaining > 0,
      `Process ${pid} survived ${timeoutMs}ms termination deadline; last state: ${state}`,
    );
    state = await observe(pid, remaining);
    if (state === "absent" || state === "Z") return;
    await timing.wait(Math.min(10, Math.max(0, deadline - timing.now())));
  }
}
interface FixtureIds {
  parent: number;
  descendant: number;
}
function canceledWithoutCleanupFailure(error: unknown): boolean {
  if (
    error instanceof Error &&
    !(error instanceof AggregateError) &&
    error.message === "Canceled"
  )
    return true;
  const message =
    error instanceof Error
      ? error.message.slice(0, 2048)
      : "Non-error rejection";
  throw new Error(
    `Unexpected cancellation failure: ${message}; original graph: ${JSON.stringify(hostFailureEvidence(error))}`,
    { cause: error },
  );
}
async function readFixtureIds(
  filename: string,
): Promise<FixtureIds | undefined> {
  let contents: string;
  try {
    contents = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const ids: FixtureIds = JSON.parse(contents);
  assert.ok(
    Number.isSafeInteger(ids.parent) &&
      ids.parent > 1 &&
      ids.parent <= 2147483647,
  );
  assert.ok(
    Number.isSafeInteger(ids.descendant) &&
      ids.descendant > 1 &&
      ids.descendant <= 2147483647,
  );
  return ids;
}
async function darwinFixtureState(
  pid: number,
  group: number,
  filename: string,
  remainingMs: number,
  execute: NonNullable<GroupQueryDependencies["execFile"]> = execFile,
): Promise<string> {
  const observed = await new Promise<{
    error: QueryError | null;
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    let result:
      | {
          error: QueryError | null;
          stdout: string;
          stderr: string;
        }
      | undefined;
    const query = execute(
      "/bin/ps",
      ["-p", String(pid), "-x", "-ww", "-o", "pid=,pgid=,uid=,state=,args="],
      {
        encoding: "utf8",
        timeout: Math.max(1, Math.ceil(remainingMs)),
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        env: { ...process.env, LC_ALL: "C", COMMAND_MODE: "unix2003" },
      },
      (error, stdout, stderr) => {
        result = { error, stdout, stderr };
      },
    );
    query.once("close", (code, signal) => {
      if (!result) reject(new Error("Missing native fixture identity result"));
      else resolve({ ...result, code, signal });
    });
  });
  if (
    observed.code === 1 &&
    observed.signal === null &&
    observed.error?.code === 1 &&
    observed.error.killed === false &&
    observed.error.signal === null &&
    observed.stdout === "" &&
    observed.stderr === ""
  )
    return "absent";
  if (observed.error) throw observed.error;
  assert.equal(observed.code, 0, "Native fixture identity query exit");
  assert.equal(observed.signal, null, "Native fixture identity query signal");
  assert.equal(observed.stderr, "", "Native fixture identity query stderr");
  assert.ok(
    observed.stdout.endsWith("\n"),
    "Incomplete native fixture identity row",
  );
  const rows = observed.stdout.trimEnd().split("\n");
  assert.equal(rows.length, 1, "Native fixture identity query row count");
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(rows[0]);
  assert.ok(match, "Malformed native fixture identity row");
  assert.equal(Number(match[1]), pid, "Native fixture PID identity");
  assert.equal(Number(match[2]), group, "Native fixture owned group identity");
  assert.equal(
    Number(match[3]),
    process.getuid?.(),
    "Native fixture UID identity",
  );
  if (!liveGroupMembers(`${group} ${pid} ${match[4]}\n`, group, "darwin"))
    return "Z";
  assert.ok(
    match[5].includes(filename),
    "Native fixture unique filename identity",
  );
  return "live";
}
async function startFixture(
  mode: "exit" | "live",
  adapters?: ProcessAdapters,
  lifecycle?: ProcessLifecycleObserver,
) {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-process-"));
  const filename = join(directory, "pids");
  const abort = new AbortController();
  let parent: ChildProcess | undefined;
  let parentClosed = false;
  let published: FixtureIds | undefined;
  const pending = runProcess(
    {
      ...base,
      args: [
        "-e",
        `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',process.argv[1]],{stdio:'ignore'}); const fs=require('node:fs'); fs.writeFileSync(process.argv[1]+'.tmp',JSON.stringify({parent:process.pid,descendant:child.pid})); fs.renameSync(process.argv[1]+'.tmp',process.argv[1]); console.log(child.pid); if(process.argv[2]==='exit') child.unref(); else setInterval(()=>{},1000);`,
        filename,
        mode,
      ],
      timeoutMs: mode === "exit" ? 2000 : 3000,
    },
    abort.signal,
    undefined,
    lifecycle,
    {
      ...adapters,
      spawn(file, args, options) {
        parent = (adapters?.spawn ?? spawn)(file, args, options);
        parent.once("close", () => {
          parentClosed = true;
        });
        return parent;
      },
    },
  );
  // Observe rejection immediately, even when an assertion fails before awaiting it.
  const settled = pending.then(
    () => {},
    () => {},
  );
  const observeFixture = async (
    pid: number,
    remainingMs: number,
  ): Promise<string> => {
    assert.ok(published, "Fixture identities have not been authenticated");
    assert.equal(
      published.parent,
      parent?.pid,
      "Known fixture parent identity changed",
    );
    assert.ok(
      pid === published.parent || pid === published.descendant,
      "Foreign fixture PID observation",
    );
    if (pid === published.parent && parentClosed) return "absent";
    return process.platform === "darwin"
      ? darwinFixtureState(pid, published.parent, filename, remainingMs)
      : processState(pid);
  };
  return {
    abort,
    pending,
    filename,
    state(pid: number): Promise<string> {
      return observeFixture(pid, terminationTimeoutMs);
    },
    awaitTermination(
      pid: number,
      timeoutMs = terminationTimeoutMs,
    ): Promise<void> {
      return awaitTermination(pid, timeoutMs, observeFixture);
    },
    async ids(): Promise<FixtureIds> {
      const deadline = performance.now() + terminationTimeoutMs;
      for (;;) {
        const ids = await readFixtureIds(filename);
        if (ids) {
          assert.equal(
            ids.parent,
            parent?.pid,
            "Published fixture parent is the actual native owner",
          );
          published = ids;
          return ids;
        }
        assert.ok(
          performance.now() < deadline,
          "Fixture did not publish its PIDs",
        );
        await delay(10);
      }
    },
    async cleanup(): Promise<void> {
      abort.abort();
      await settled;
      const failures: unknown[] = [];
      if (!parentClosed)
        failures.push(
          new Error("Native fixture parent closure was not joined"),
        );
      let ids: FixtureIds | undefined;
      try {
        // Read after the operation settles, including failure before ids() returns.
        ids = await readFixtureIds(filename);
        assert.ok(ids, "Native fixture did not publish both owned identities");
      } catch (error) {
        failures.push(error);
      }
      if (ids) {
        const owned = ids;
        if (!published && owned.parent === parent?.pid) published = owned;
        const results = await Promise.allSettled(
          [owned.parent, owned.descendant].map(async (pid, index) => {
            if (index === 0) {
              assert.equal(pid, parent?.pid, "Fixture parent identity changed");
              assert.equal(
                parentClosed,
                true,
                "Exact native parent close not observed",
              );
            }
            if (published)
              assert.equal(
                pid,
                index === 0 ? published.parent : published.descendant,
                "Published fixture identity changed",
              );
            if (process.platform === "darwin") {
              // Parent close identifies/reaps that exact child; the descendant
              // still needs its own bounded, marker-authenticated observation.
              if (index !== 0)
                await awaitTermination(
                  pid,
                  terminationTimeoutMs,
                  observeFixture,
                );
              return;
            }
            const state = await processState(pid);
            if (state !== "absent" && state !== "Z") {
              try {
                if (process.platform === "linux") {
                  // Never signal a reused PID that no longer carries our fixture identity.
                  const argv = await readFile(`/proc/${pid}/cmdline`, "utf8");
                  if (!argv.split("\0").includes(filename)) {
                    // A signaled fixture may become a zombie between the reads.
                    // Reobserve without signaling any identity we cannot verify.
                    await awaitTermination(pid);
                    return;
                  }
                }
                process.kill(pid, "SIGKILL");
              } catch (error) {
                if (!absent(error)) throw error;
              }
            }
            await awaitTermination(pid);
          }),
        );
        for (const result of results) {
          if (result.status === "rejected") failures.push(result.reason);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          `Retained unverified native fixture inputs: ${directory}`,
          { cause: failures[0] },
        );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test(
  "POSIX group cleanup kills descendants after parent exits normally",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await startFixture("exit");
    try {
      const result = await fixture.pending;
      const ids = await fixture.ids();
      assert.equal(Number(result.trim()), ids.descendant);
      await fixture.awaitTermination(ids.parent);
      await fixture.awaitTermination(ids.descendant);
    } finally {
      await fixture.cleanup();
    }
  },
);
test(
  "POSIX cancellation terminates a live parent and descendant",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await startFixture("live");
    try {
      const ids = await fixture.ids();
      for (const pid of [ids.parent, ids.descendant]) {
        assert.ok(!["absent", "Z"].includes(await fixture.state(pid)));
      }
      fixture.abort.abort();
      await assert.rejects(fixture.pending, canceledWithoutCleanupFailure);
      await fixture.awaitTermination(ids.parent);
      await fixture.awaitTermination(ids.descendant);
    } finally {
      await fixture.cleanup();
    }
  },
);
test(
  "native fixture observations accept defunct zombies and retain independent identity failures",
  { skip: process.platform === "win32" },
  async () => {
    await withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
      const fixture = await startFixture("live");
      let original: string | undefined;
      resources.defer("verified native fixture cleanup", () =>
        fixture.cleanup(),
      );
      resources.defer("original fixture identity bytes", async () => {
        if (original !== undefined) await writeFile(fixture.filename, original);
      });
      const ids = await fixture.ids();
      original = await readFile(fixture.filename, "utf8");
      for (const mode of [
        "zombie",
        "unmarked-live",
        "foreign-group",
        "foreign-uid",
        "malformed",
      ] as const) {
        let queryClosed = false;
        const state =
          mode === "unmarked-live"
            ? "S"
            : mode === "malformed"
              ? "unknown"
              : "Z";
        const snapshot = `${ids.descendant} ${ids.parent + (mode === "foreign-group" ? 1 : 0)} ${(process.getuid?.() ?? -1) + (mode === "foreign-uid" ? 1 : 0)} ${state} <defunct>\n`;
        const observation = darwinFixtureState(
          ids.descendant,
          ids.parent,
          fixture.filename,
          terminationTimeoutMs,
          (_file, _args, options, callback) => {
            const child = execFile(
              process.execPath,
              ["-e", `process.stdout.write(${JSON.stringify(snapshot)})`],
              options,
              callback,
            );
            child.once("close", () => {
              queryClosed = true;
            });
            return child;
          },
        );
        if (mode === "zombie") assert.equal(await observation, "Z");
        else await assert.rejects(observation, /identity|snapshot/);
        assert.equal(
          queryClosed,
          true,
          `${mode} observation joins its exact native pipes`,
        );
      }
      fixture.abort.abort();
      await assert.rejects(fixture.pending, canceledWithoutCleanupFailure);
      await fixture.awaitTermination(ids.parent);
      await fixture.awaitTermination(ids.descendant);
      const changed = JSON.stringify({
        parent: ids.parent + 1,
        descendant: ids.descendant + 1,
      });
      await writeFile(fixture.filename, changed);
      await assert.rejects(fixture.cleanup(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.ok(error.errors[0] instanceof Error);
        assert.ok(error.errors[1] instanceof Error);
        assert.equal(error.cause, error.errors[0]);
        assert.match(
          error.message,
          /Retained unverified native fixture inputs:/,
        );
        return true;
      });
      assert.equal(await readFile(fixture.filename, "utf8"), changed);
    });
  },
);
function failureContains(root: unknown, expected: unknown): boolean {
  const seen = new Set<object>();
  const visit = (error: unknown): boolean => {
    if (error === expected) return true;
    if (!error || typeof error !== "object" || seen.has(error)) return false;
    seen.add(error);
    return (
      ("cause" in error && visit(error.cause)) ||
      ("errors" in error &&
        Array.isArray(error.errors) &&
        error.errors.some(visit))
    );
  };
  return visit(root);
}
interface NativeCancellation {
  fixture: Awaited<ReturnType<typeof startFixture>>;
  ids: FixtureIds;
  fault: NodeJS.ErrnoException;
  kills: Readonly<ProcessTerminationContext>[];
  querySignals: (AbortSignal | undefined)[];
  queryFailures: unknown[];
  querySettled: number;
  nativeClosed?: { code: number | null; signal: NodeJS.Signals | null };
}
async function withNativeCancellation(
  body: (control: NativeCancellation) => Promise<void>,
  options: {
    code?: string;
    phase?: "abort" | "exit";
    query?: NonNullable<ProcessAdapters["groupHasLiveMembers"]>;
    platform?: NodeJS.Platform;
    releaseQuery?: () => void;
  } = {},
): Promise<void> {
  const fault = Object.assign(
    new Error("Controlled native group kill failed"),
    {
      code: options.code ?? "EPERM",
      errno: -1,
      syscall: "kill",
    },
  );
  const kills: Readonly<ProcessTerminationContext>[] = [];
  const querySignals: (AbortSignal | undefined)[] = [];
  const queryFailures: unknown[] = [];
  let querySettled = 0;
  let nativeClosed: NativeCancellation["nativeClosed"];
  const fixture = await startFixture(
    "live",
    {
      platform: options.platform ?? "darwin",
      killGroup(context) {
        assert.equal(Object.isFrozen(context), true);
        kills.push(context);
        if (context.phase === (options.phase ?? "exit")) throw fault;
        process.kill(context.target, context.signal);
      },
      async groupHasLiveMembers(group, signal) {
        querySignals.push(signal);
        try {
          return await (options.query ?? groupHasLiveMembers)(group, signal);
        } catch (error) {
          queryFailures.push(error);
          throw error;
        } finally {
          querySettled++;
        }
      },
    },
    {
      closed(code, signal) {
        // Node's actual close event follows native exit and both public pipes.
        nativeClosed = { code, signal };
      },
    },
  );
  return withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
    resources.defer("native cancellation fixture", () => fixture.cleanup());
    resources.defer("controlled cleanup query", () => options.releaseQuery?.());
    const ids = await fixture.ids();
    const state: NativeCancellation = {
      fixture,
      ids,
      fault,
      kills,
      querySignals,
      queryFailures,
      get querySettled() {
        return querySettled;
      },
      get nativeClosed() {
        return nativeClosed;
      },
    };
    await body(state);
  });
}
test(
  "Darwin exit sweep recovers only after actual canceled native group has no live members",
  { skip: process.platform === "win32" },
  async () => {
    await withNativeCancellation(async (f) => {
      assert.equal(await groupHasLiveMembers(f.ids.parent), true);
      f.fixture.abort.abort();
      const rejected = await f.fixture.pending.then(
        () => {
          throw new Error("Expected native cancellation");
        },
        (error: unknown) => error,
      );
      assert.deepEqual(
        f.kills.map(({ phase }) => phase),
        ["abort", "exit"],
      );
      for (const context of f.kills) {
        assert.equal(context.target, -f.ids.parent);
        assert.equal(context.signal, "SIGKILL");
      }
      assert.deepEqual(f.nativeClosed, { code: null, signal: "SIGKILL" });
      assert.equal(await groupHasLiveMembers(f.ids.parent), false);
      await f.fixture.awaitTermination(f.ids.parent);
      await f.fixture.awaitTermination(f.ids.descendant);
      if (rejected instanceof AggregateError) {
        assert.ok(rejected.cause instanceof Error);
        assert.equal(rejected.cause.message, "Canceled");
        assert.equal(rejected.errors[1], f.fault);
      }
      try {
        assert.equal(canceledWithoutCleanupFailure(rejected), true);
      } catch (error) {
        throw new Error(
          `Native cancellation joined: ${JSON.stringify({ kills: f.kills, closed: f.nativeClosed, queryCalls: f.querySignals.length, groupLive: false })}`,
          { cause: error },
        );
      }
      assert.equal(f.querySignals.length, 1);
      assert.equal(f.querySettled, 1);
      assert.ok(f.querySignals.every((signal) => !signal?.aborted));
      assert.deepEqual(f.queryFailures, []);
    });
  },
);
test(
  "Darwin exit sweep retains live or inconclusive native group observations",
  { skip: process.platform === "win32" },
  async () => {
    for (const mode of [
      "live",
      "empty",
      "malformed",
      "foreign-group",
      "spawn-error",
    ] as const) {
      let queryClosed = false;
      await withNativeCancellation(
        async (f) => {
          f.fixture.abort.abort();
          await assert.rejects(f.fixture.pending, (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.ok(error.cause instanceof Error);
            assert.equal(error.cause.message, "Canceled");
            assert.ok(failureContains(error, f.fault));
            assert.equal(
              queryClosed,
              true,
              `${mode} native query closed before rejection`,
            );
            if (mode !== "live") {
              assert.equal(f.queryFailures.length, 1);
              assert.ok(failureContains(error, f.queryFailures[0]));
            }
            return true;
          });
          assert.equal(f.querySettled, 1);
          assert.deepEqual(f.nativeClosed, { code: null, signal: "SIGKILL" });
          await f.fixture.awaitTermination(f.ids.parent);
          await f.fixture.awaitTermination(f.ids.descendant);
        },
        {
          query: (group, signal) =>
            groupHasLiveMembers(group, signal, {
              platform: "darwin",
              execFile(_file, _args, options, callback) {
                const snapshot =
                  mode === "live"
                    ? `${group} 123 S\n`
                    : mode === "malformed"
                      ? `${group} 123 invalid\n`
                      : mode === "foreign-group"
                        ? `${group + 1} 123 S\n`
                        : "";
                const child = execFile(
                  mode === "spawn-error"
                    ? `${process.execPath}.missing-query-fixture`
                    : process.execPath,
                  ["-e", `process.stdout.write(${JSON.stringify(snapshot)})`],
                  options,
                  callback,
                );
                child.once("close", () => {
                  queryClosed = true;
                });
                return child;
              },
            }),
        },
      );
    }
  },
);
test(
  "canceled native caller retains an independent failed group observation",
  { skip: process.platform === "win32" },
  async () => {
    const queryFailure = new Error("Independent native observation failure");
    await withNativeCancellation(
      async (f) => {
        f.fixture.abort.abort();
        await assert.rejects(f.fixture.pending, (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.ok(error.cause instanceof Error);
          assert.equal(error.cause.message, "Canceled");
          assert.ok(failureContains(error, f.fault));
          assert.ok(failureContains(error, queryFailure));
          return true;
        });
        assert.equal(f.querySettled, 1);
        assert.deepEqual(f.nativeClosed, { code: null, signal: "SIGKILL" });
      },
      {
        query: async () => {
          throw queryFailure;
        },
      },
    );
  },
);
test(
  "nonexit or other-platform native kill faults never recover from later absence",
  { skip: process.platform === "win32" },
  async () => {
    for (const options of [
      { phase: "abort" as const },
      { code: "EIO" },
      { platform: "linux" as const },
    ]) {
      await withNativeCancellation(async (f) => {
        f.fixture.abort.abort();
        await assert.rejects(f.fixture.pending, (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.ok(error.cause instanceof Error);
          assert.equal(error.cause.message, "Canceled");
          assert.ok(failureContains(error, f.fault));
          assert.match(error.message, /"phase":/);
          assert.ok(error.message.includes(`"target":${-f.ids.parent}`));
          assert.ok(error.message.includes(`"code":"${f.fault.code}"`));
          assert.match(error.message, /"errno":-1/);
          assert.match(error.message, /"syscall":"kill"/);
          if (options.phase === "abort")
            assert.match(error.message, /"nativeExitObserved":false/);
          return true;
        });
        assert.equal(f.querySignals.length, 0);
        assert.equal(f.querySettled, 0);
        assert.equal(await groupHasLiveMembers(f.ids.parent), false);
        assert.deepEqual(f.nativeClosed, { code: null, signal: "SIGKILL" });
        await f.fixture.awaitTermination(f.ids.parent);
        await f.fixture.awaitTermination(f.ids.descendant);
      }, options);
    }
  },
);
test(
  "canceled native caller joins an admitted cleanup query before settling",
  { skip: process.platform === "win32" },
  async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withNativeCancellation(
      async (f) => {
        f.fixture.abort.abort();
        let settled = false;
        type Outcome =
          { ok: true; output: string } | { ok: false; error: unknown };
        const outcome = f.fixture.pending.then(
          (output): Outcome => {
            settled = true;
            return { ok: true, output };
          },
          (error: unknown): Outcome => {
            settled = true;
            return { ok: false, error };
          },
        );
        try {
          const first = await Promise.race([
            entered.promise.then(() => "entered"),
            outcome,
          ]);
          if (typeof first !== "string")
            throw new Error(
              "Native operation settled before cleanup query admission",
              {
                cause: first.ok ? new Error("Unexpected success") : first.error,
              },
            );
          assert.equal(settled, false);
          assert.equal(f.querySettled, 0);
          assert.ok(f.querySignals.every((signal) => !signal?.aborted));
        } finally {
          release.resolve();
        }
        const result = await outcome;
        assert.equal(result.ok, false);
        if (result.ok) throw new Error("Expected native cancellation");
        assert.equal(canceledWithoutCleanupFailure(result.error), true);
        assert.equal(f.querySettled, 1);
        assert.deepEqual(f.nativeClosed, { code: null, signal: "SIGKILL" });
        await f.fixture.awaitTermination(f.ids.parent);
        await f.fixture.awaitTermination(f.ids.descendant);
      },
      {
        async query(group, signal) {
          entered.resolve();
          await release.promise;
          return groupHasLiveMembers(group, signal);
        },
        releaseQuery: () => release.resolve(),
      },
    );
  },
);
test(
  "Darwin cancellation after observed native exit qualifies only joined group absence",
  { skip: process.platform === "win32" },
  async () => {
    const fault = Object.assign(new Error("denied post-exit cancellation"), {
      code: "EPERM",
      errno: -1,
      syscall: "kill",
    });
    let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
    let nativeExit:
      { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let nativeClosed = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let queried = 0;
    const kills: Readonly<ProcessTerminationContext>[] = [];
    await withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
      const owned = await startFixture(
        "exit",
        {
          platform: "darwin",
          spawn(file, args, options) {
            const child = spawn(file, args, options);
            child.stdout?.once("close", () => {
              stdoutClosed = true;
            });
            child.stderr?.once("close", () => {
              stderrClosed = true;
            });
            // Node sets the public exit fields before emitting this event.
            // This listener precedes the producer's own exit sweep.
            child.once("exit", () => {
              nativeExit = { code: child.exitCode, signal: child.signalCode };
              fixture?.abort.abort();
            });
            return child;
          },
          killGroup(context) {
            kills.push(context);
            if (context.phase === "abort") throw fault;
            process.kill(context.target, context.signal);
          },
          async groupHasLiveMembers(group, signal) {
            queried++;
            assert.equal(nativeClosed && stdoutClosed && stderrClosed, true);
            assert.ok(signal && !signal.aborted);
            assert.ok(fixture);
            const ids = await fixture.ids();
            assert.equal(group, ids.parent);
            await fixture.awaitTermination(ids.descendant);
            return groupHasLiveMembers(group, signal);
          },
        },
        {
          closed() {
            nativeClosed = true;
          },
        },
      );
      fixture = owned;
      resources.defer("post-exit cancellation native fixture", () =>
        owned.cleanup(),
      );
      const ids = await owned.ids();
      await assert.rejects(owned.pending, (error: unknown) => {
        assert.deepEqual(nativeExit, { code: 0, signal: null });
        assert.equal(nativeClosed && stdoutClosed && stderrClosed, true);
        assert.equal(canceledWithoutCleanupFailure(error), true);
        assert.equal(queried, 1, "native absence is observed after closure");
        return true;
      });
      assert.equal(owned.abort.signal.aborted, true);
      assert.deepEqual(
        kills.map(({ phase }) => phase),
        ["abort", "exit"],
      );
      assert.ok(kills.every(({ target }) => target === -ids.parent));
      await owned.awaitTermination(ids.parent);
      await owned.awaitTermination(ids.descendant);
    });
  },
);

test(
  "Darwin cancellation after observed native exit retains live or failed observations",
  { skip: process.platform === "win32" },
  async () => {
    for (const mode of ["live", "query-error", "unknown", "aborted"] as const) {
      const fault = Object.assign(
        new Error(`denied post-exit ${mode} cleanup`),
        {
          code: "EPERM",
          errno: -1,
          syscall: "kill",
        },
      );
      const queryFault = Object.assign(
        new Error("independent group query failed"),
        { code: "EIO" },
      );
      let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
      let nativeClosed = false;
      let nativeExit:
        { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let observed = 0;
      let queryJoined = false;
      let queryAbortReason: unknown;
      const kills: Readonly<ProcessTerminationContext>[] = [];
      await withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
        const owned = await startFixture(
          "exit",
          {
            platform: "darwin",
            spawn(file, args, options) {
              const child = spawn(file, args, options);
              child.once("exit", () => {
                nativeExit = { code: child.exitCode, signal: child.signalCode };
                fixture?.abort.abort();
              });
              return child;
            },
            killGroup(context) {
              kills.push(context);
              if (
                context.phase === "abort" ||
                (mode === "live" && context.phase === "exit")
              )
                throw fault;
              process.kill(context.target, context.signal);
            },
            async groupHasLiveMembers(group, signal) {
              observed++;
              assert.equal(
                nativeClosed,
                true,
                "native close precedes observation",
              );
              assert.ok(signal && !signal.aborted);
              assert.ok(fixture);
              assert.equal(group, (await fixture.ids()).parent);
              try {
                if (mode === "live")
                  return await groupHasLiveMembers(group, signal);
                if (mode === "query-error") throw queryFault;
                if (mode === "unknown") {
                  // Deliberately violate the typed boundary to exercise its
                  // runtime guard; an unqualified result cannot prove absence.
                  return undefined as unknown as boolean;
                }
                await new Promise<void>((resolve) => {
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                queryAbortReason = signal.reason;
                signal.throwIfAborted();
                throw new Error("Cleanup query resumed without cancellation");
              } finally {
                queryJoined = true;
              }
            },
          },
          {
            closed() {
              nativeClosed = true;
            },
          },
        );
        fixture = owned;
        resources.defer("post-exit denied native fixture", () =>
          owned.cleanup(),
        );
        // A deliberately denied exit sweep leaves a real descendant alive.
        // Register its independent release before checking the failed result.
        resources.defer("surviving denied native group", async () => {
          if (mode !== "live") return;
          const ids = await owned.ids();
          const state = await owned.state(ids.descendant);
          if (state === "absent" || state === "Z") return;
          if (process.platform === "linux") {
            const argv = await readFile(
              `/proc/${ids.descendant}/cmdline`,
              "utf8",
            );
            assert.ok(
              argv.split("\0").includes(owned.filename),
              "live descendant retains its private identity",
            );
          }
          process.kill(-ids.parent, "SIGKILL");
          await owned.awaitTermination(ids.descendant);
        });
        const ids = await owned.ids();
        await assert.rejects(owned.pending, (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.ok(error.cause instanceof Error);
          assert.equal(error.cause.message, "Canceled");
          assert.equal(error.errors[1], fault);
          assert.match(error.message, /"phase":"abort"/);
          assert.match(error.message, /"nativeExitObserved":true/);
          assert.equal(
            observed,
            1,
            `${mode} receives its independent observation`,
          );
          assert.equal(
            queryJoined,
            true,
            `${mode} query settles before the caller`,
          );
          assert.deepEqual(nativeExit, { code: 0, signal: null });
          assert.equal(nativeClosed, true);
          if (mode === "live") assert.equal(error.errors.length, 2);
          else {
            assert.equal(error.errors.length, 3);
            if (mode === "query-error")
              assert.equal(error.errors[2], queryFault);
            else {
              assert.ok(error.errors[2] instanceof Error);
              assert.match(
                error.errors[2].message,
                mode === "unknown" ? /Unqualified/ : /timed out/,
              );
              if (mode === "aborted")
                assert.equal(error.errors[2], queryAbortReason);
            }
          }
          return true;
        });
        assert.deepEqual(
          kills.map(({ phase }) => phase),
          ["abort", "exit"],
        );
        assert.ok(kills.every(({ target }) => target === -ids.parent));
        if (mode === "live")
          assert.equal(await groupHasLiveMembers(ids.parent), true);
      });
    }
  },
);

test(
  "POSIX termination observer rejects a surviving fixture and cleans up after failure",
  { skip: process.platform === "win32" },
  async () => {
    let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
    let ids: FixtureIds | undefined;
    let elapsed = 0;
    const samples: { pid: number; remainingMs: number; state: string }[] = [];
    await assert.rejects(
      withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
        const owned = await startFixture("live");
        fixture = owned;
        resources.defer("surviving native fixture cleanup", () =>
          owned.cleanup(),
        );
        ids = await owned.ids();
        await awaitTermination(
          ids.descendant,
          30,
          async (pid, remainingMs) => {
            // The deliberate logical deadline must not time out native ps.
            // Each state still uses the fixture's independent query budget.
            const state = await owned.state(pid);
            samples.push({ pid, remainingMs, state });
            return state;
          },
          {
            now: () => elapsed,
            wait: async (milliseconds) => {
              elapsed += milliseconds;
            },
          },
        );
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1, "native cleanup must also pass");
        assert.equal(error.cause, error.errors[0]);
        assert.ok(error.cause instanceof Error);
        assert.match(
          error.cause.message,
          /survived 30ms termination deadline; last state:/,
        );
        return true;
      },
    );
    assert.equal(elapsed, 30, "logical time reaches the survivor deadline");
    assert.ok(ids);
    const ownedIds = ids;
    assert.deepEqual(
      samples.map(({ pid, remainingMs }) => ({ pid, remainingMs })),
      [30, 20, 10].map((remainingMs) => ({
        pid: ownedIds.descendant,
        remainingMs,
      })),
    );
    assert.ok(samples.every(({ state }) => !["absent", "Z"].includes(state)));
    // Check both identities after the deliberate observation failure and cleanup.
    assert.ok(fixture);
    await fixture.awaitTermination(ids.parent);
    await fixture.awaitTermination(ids.descendant);
  },
);

test("termination observer retains independent query and identity errors", async () => {
  for (const failure of [
    new Error("native identity query failed"),
    new Error("native fixture identity changed"),
  ]) {
    let observed = 0;
    let waited = false;
    await assert.rejects(
      awaitTermination(
        1200,
        30,
        async () => {
          observed++;
          throw failure;
        },
        {
          now: () => 0,
          wait: async () => {
            waited = true;
          },
        },
      ),
      (error: unknown) => error === failure,
    );
    assert.equal(observed, 1, "query failure stops observation admission");
    assert.equal(waited, false, "query failure cannot become a survival poll");
  }
});

test(
  "native stderr, nonzero exit and setup errors survive denied group cleanup",
  { skip: process.platform === "win32" },
  async (testContext) => {
    for (const mode of ["stderr", "exit-status", "setup"] as const) {
      try {
        await withTestResources(
          { cleanupTimeoutMs: 5000 },
          async (resources) => {
            const cleanup = Object.assign(
              new Error("injected denied group cleanup"),
              { code: "EPERM", errno: -1, syscall: "kill" },
            );
            let nativeClosed = false;
            let stdoutClosed = false;
            let stderrClosed = false;
            let inputClosed = false;
            let observedChild: ChildProcess | undefined;
            const streamJoining: Promise<void>[] = [];
            resources.defer("admitted native stdio close", async () => {
              await Promise.all(streamJoining);
              assert.equal(stdoutClosed && stderrClosed && inputClosed, true);
            });
            let nativePID: number | undefined;
            let queries = 0;
            const labels: string[] = [];
            const adapters: ProcessAdapters = {
              platform: "darwin",
              spawn(file, args, options) {
                const child = spawn(file, args, options);
                observedChild = child;
                nativePID = child.pid;
                assert.ok(child.stdout && child.stderr);
                const output = child.stdout,
                  errors = child.stderr;
                streamJoining.push(
                  new Promise<void>((resolve) =>
                    output.once("close", () => {
                      stdoutClosed = true;
                      resolve();
                    }),
                  ),
                );
                streamJoining.push(
                  new Promise<void>((resolve) =>
                    errors.once("close", () => {
                      stderrClosed = true;
                      resolve();
                    }),
                  ),
                );
                assert.ok(Array.isArray(options.stdio));
                if (options.stdio[0] === "ignore") {
                  assert.ok(child.stdin === null || child.stdin === undefined);
                  inputClosed = true;
                } else {
                  assert.equal(options.stdio[0], "pipe");
                  const input = child.stdin;
                  assert.ok(input, "an admitted input pipe must be present");
                  streamJoining.push(
                    new Promise<void>((resolve) =>
                      input.once("close", () => {
                        inputClosed = true;
                        resolve();
                      }),
                    ),
                  );
                }
                return child;
              },
              killGroup(context) {
                assert.ok(
                  context.target < 0,
                  "only this instance's owned process group reaches the adapter",
                );
                assert.ok(nativePID);
                assert.equal(context.target, -nativePID);
                assert.equal(Object.isFrozen(context), true);
                assert.equal(context.signal, "SIGKILL");
                throw cleanup;
              },
              async groupHasLiveMembers(group, signal) {
                queries++;
                assert.equal(group, nativePID);
                assert.equal(nativeClosed, true);
                assert.equal(observedChild?.stdout?.closed, true);
                assert.equal(observedChild?.stderr?.closed, true);
                assert.ok(signal && !signal.aborted);
                // This component control models a remaining live member after denied
                // signaling; the tiny real payload itself has already closed.
                return true;
              },
            };
            const request = {
              ...base,
              args: [
                "-e",
                mode === "stderr"
                  ? 'process.stderr.write("primary stderr")'
                  : mode === "exit-status"
                    ? "process.exit(2)"
                    : "process.exit(0)",
              ],
              // This deliberate invalid runtime value fails stdin setup after native spawn.
              ...(mode === "setup"
                ? { input: Object.create(null) as Uint8Array }
                : {}),
            };
            await assert.rejects(
              runProcess(
                request,
                new AbortController().signal,
                (label) => labels.push(label),
                {
                  closed() {
                    nativeClosed = true;
                  },
                },
                adapters,
              ),
              (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(nativeClosed, true);
                assert.equal(error.errors.length, 2);
                assert.equal(error.errors[1], cleanup);
                assert.equal(error.cause, error.errors[0]);
                assert.match(error.message, /"code":"EPERM"/);
                assert.match(error.message, /"errno":-1/);
                assert.match(error.message, /"syscall":"kill"/);
                assert.ok(nativePID);
                assert.ok(error.message.includes(`"target":${-nativePID}`));
                assert.ok(
                  error.message.includes(
                    `"phase":"${mode === "setup" ? "setup" : "exit"}"`,
                  ),
                );
                if (mode === "stderr")
                  assert.match(String(error.errors[0]), /primary stderr/);
                if (mode === "exit-status")
                  assert.match(String(error.errors[0]), /exited with status 2/);
                if (mode === "setup")
                  assert.equal(
                    (error.errors[0] as NodeJS.ErrnoException).code,
                    "ERR_INVALID_ARG_TYPE",
                  );
                return true;
              },
            );
            assert.deepEqual(labels, [mode]);
            assert.equal(queries, mode === "setup" ? 0 : 1);
          },
        );
      } catch (error) {
        try {
          testContext.diagnostic(
            "SALTBOX_PROCESS_CASE_FAILURE " +
              JSON.stringify({ mode, evidence: hostFailureEvidence(error) }),
          );
        } catch (diagnostic) {
          throw new AggregateError(
            [error, diagnostic],
            "Native process case failure evidence could not be recorded",
            { cause: error },
          );
        }
        throw error;
      }
    }
  },
);
