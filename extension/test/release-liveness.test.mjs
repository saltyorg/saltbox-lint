import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ownedCommand } from "../scripts/owned-command.mjs";
import { stageBinary } from "../scripts/stage-binary.mjs";

const fixture = fileURLToPath(
  new URL("testdata/owned-builder.mjs", import.meta.url),
);

async function record(filename) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try {
      return JSON.parse(readFileSync(filename));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`Owned builder did not publish ${filename}`);
}

function running(instance) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: instance.port });
    let response = "";
    const finish = (error, alive) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(alive);
    };
    socket.setTimeout(1000, () =>
      finish(new Error("Owned builder probe timed out")),
    );
    socket.on("data", (chunk) => (response += chunk.toString("ascii")));
    socket.once("end", () =>
      finish(undefined, response === instance.token + "\n"),
    );
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") finish(undefined, false);
      else finish(error);
    });
  });
}

test("release probes preserve output and identify command failures", async () => {
  assert.equal(
    await ownedCommand(
      process.execPath,
      ["-e", 'process.stdout.write("release")'],
      {
        phase: "version control",
        timeoutMs: 30000,
      },
    ),
    "release",
  );
  await assert.rejects(
    ownedCommand(
      process.execPath,
      ["-e", 'console.error("builder failure"); process.exit(7)'],
      {
        phase: "metadata control",
        timeoutMs: 30000,
      },
    ),
    /metadata control: .*owned (?:Job launcher )?PID \d+.*exited 7\nbuilder failure/s,
  );
  await assert.rejects(
    ownedCommand("saltbox-missing-owned-builder", [], {
      phase: "spawn control",
      timeoutMs: 30000,
    }),
    /spawn control: .*ENOENT/s,
  );
});

test("staging deadline names its command and closes the owned builder tree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "saltbox-owned-build-"));
  const filename = join(directory, "builder.json");
  // Attach rejection handling before observing the live resources.
  const result = stageBinary({
    command: process.execPath,
    prefix: [fixture, "tree", filename],
    output: join(directory, "saltbox-lint"),
    timeoutMs: 30000,
  }).then(
    () => undefined,
    (error) => error,
  );
  try {
    const parent = await record(filename);
    const child = await record(filename + ".child");
    assert.equal(
      await running(parent),
      true,
      "owned builder is live before the deadline",
    );
    assert.equal(
      await running(child),
      true,
      "owned descendant is live before the deadline",
    );
    const failure = await result;
    assert.ok(failure instanceof Error);
    assert.match(
      failure.message,
      /stage release CLI: .*owned (?:Job launcher )?PID \d+.*timed out after 30000ms/s,
    );
    assert.match(failure.message, /owned-builder\.mjs/);
    assert.equal(
      await running(parent),
      false,
      "owned builder endpoint is absent after cleanup",
    );
    assert.equal(
      await running(child),
      false,
      "owned descendant endpoint is absent after cleanup",
    );
  } finally {
    await result;
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mode of ["exit", "error-exit"]) {
  test(`staging reaps retained descendant pipes after builder ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "saltbox-exited-build-"));
    const filename = join(directory, "builder.json");
    const result = stageBinary({
      command: process.execPath,
      prefix: [fixture, mode, filename],
      output: join(directory, "saltbox-lint"),
      timeoutMs: 30000,
    }).then(
      () => undefined,
      (error) => error,
    );
    try {
      const parent = await record(filename);
      const child = await record(filename + ".child");
      assert.equal(await running(parent), true);
      assert.equal(
        await running(child),
        true,
        "owned descendant is live before parent exit",
      );
      const trigger = createConnection({
        host: "127.0.0.1",
        port: parent.port,
      });
      trigger.on("error", () => {});
      trigger.end("exit\n");
      const failure = await result;
      trigger.destroy();
      if (mode === "error-exit") {
        assert.ok(failure instanceof Error);
        assert.match(failure.message, /stage release CLI: .*exited 7/s);
        assert.doesNotMatch(failure.message, /timed out/);
      } else
        assert.equal(
          failure,
          undefined,
          "successful builder exit remains successful",
        );
      assert.equal(await running(parent), false);
      assert.equal(
        await running(child),
        false,
        "exited parent's owned descendant endpoint is absent",
      );
    } finally {
      await result;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
