import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runProcess } from "../../src/process.ts";
const base = { executable: process.execPath, cwd: process.cwd() };
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
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (absent(error)) return "absent";
    throw error;
  }
}
async function awaitTermination(
  pid: number,
  timeoutMs = terminationTimeoutMs,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let state: string;
  for (;;) {
    state = await processState(pid);
    if (state === "absent" || state === "Z") return;
    const remaining = deadline - performance.now();
    assert.ok(
      remaining > 0,
      `Process ${pid} survived ${timeoutMs}ms termination deadline; last state: ${state}`,
    );
    await delay(Math.min(10, remaining));
  }
}
interface FixtureIds {
  parent: number;
  descendant: number;
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
  assert.ok(Number.isSafeInteger(ids.parent) && ids.parent > 1);
  assert.ok(Number.isSafeInteger(ids.descendant) && ids.descendant > 1);
  return ids;
}
async function startFixture(mode: "exit" | "live") {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-process-"));
  const filename = join(directory, "pids");
  const abort = new AbortController();
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
  );
  // Observe rejection immediately, even when an assertion fails before awaiting it.
  const settled = pending.then(
    () => {},
    () => {},
  );
  return {
    abort,
    pending,
    async ids(): Promise<FixtureIds> {
      const deadline = performance.now() + terminationTimeoutMs;
      for (;;) {
        const ids = await readFixtureIds(filename);
        if (ids) return ids;
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
      try {
        // Read after the operation settles, including failure before ids() returns.
        const ids = await readFixtureIds(filename);
        if (ids) {
          const results = await Promise.allSettled(
            [ids.parent, ids.descendant].map(async (pid) => {
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
            if (result.status === "rejected") throw result.reason;
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
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
      await awaitTermination(ids.parent);
      await awaitTermination(ids.descendant);
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
        assert.ok(!["absent", "Z"].includes(await processState(pid)));
      }
      fixture.abort.abort();
      await assert.rejects(fixture.pending, /Canceled/);
      await awaitTermination(ids.parent);
      await awaitTermination(ids.descendant);
    } finally {
      await fixture.cleanup();
    }
  },
);
test(
  "POSIX termination observer rejects a surviving fixture and cleans up after failure",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await startFixture("live");
    let ids: FixtureIds | undefined;
    await assert.rejects(async () => {
      try {
        ids = await fixture.ids();
        await awaitTermination(ids.descendant, 30);
      } finally {
        await fixture.cleanup();
      }
    }, /survived 30ms termination deadline; last state:/);
    // Check both identities after the deliberate observation failure and cleanup.
    assert.ok(ids);
    await awaitTermination(ids.parent);
    await awaitTermination(ids.descendant);
  },
);
