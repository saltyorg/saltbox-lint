import assert from "node:assert/strict";
import { test } from "node:test";
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
test(
  "POSIX group cleanup kills descendants after parent exits normally",
  { skip: process.platform === "win32" },
  async () => {
    const { readFile } = await import("node:fs/promises");
    const result = await runProcess(
      {
        ...base,
        args: [
          "-e",
          `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); child.unref();`,
        ],
        timeoutMs: 2000,
      },
      new AbortController().signal,
    );
    const pid = Number(result.trim());
    assert.ok(pid > 1);
    if (process.platform === "linux") {
      try {
        assert.match(
          await readFile(`/proc/${pid}/stat`, "utf8"),
          /^\d+ \(.+\) Z /,
        );
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        )
          throw error;
      }
    } else {
      // The OS may need a short interval to reap the signaled descendant.
      let alive = true;
      for (let n = 0; n < 20 && alive; n++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 10));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false);
    }
  },
);
test(
  "POSIX cancellation terminates a live parent and descendant",
  { skip: process.platform === "win32" },
  async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "saltbox-process-"));
    const filename = join(directory, "pid");
    const abort = new AbortController();
    let descendant = 0;
    const pending = runProcess(
      {
        ...base,
        args: [
          "-e",
          `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`,
          filename,
        ],
        timeoutMs: 3000,
      },
      abort.signal,
    );
    const rejected = assert.rejects(pending, /Canceled/);
    try {
      for (let n = 0; n < 100 && !descendant; n++) {
        try {
          descendant = Number(await readFile(filename, "utf8"));
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      assert.ok(descendant > 1);
      abort.abort();
      await rejected;
      let live = true;
      for (let n = 0; n < 100 && live; n++) {
        try {
          if (process.platform === "linux")
            live = !/^\d+ \(.+\) Z /.test(
              await readFile(`/proc/${descendant}/stat`, "utf8"),
            );
          else process.kill(descendant, 0);
        } catch {
          live = false;
        }
        if (live) await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(live, false);
    } finally {
      abort.abort();
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
