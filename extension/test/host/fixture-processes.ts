import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

export interface FixtureProcess {
  pid: number;
  port: number;
  token: string;
  args?: string[];
}

// Readiness carries the publisher's credential. Historical records may reuse
// its PID, so only an exact credential match proves the published instance.
export function fixtureGateInstance(
  ready: { pid: number; instance: FixtureProcess },
  filename: string,
): FixtureProcess {
  assert.ok(ready.instance, "readiness includes its instance endpoint");
  assert.equal(
    ready.instance.pid,
    ready.pid,
    "readiness instance owns its PID",
  );
  assert.ok(
    fixtureProcesses(filename).some(
      (instance) =>
        instance.pid === ready.instance.pid &&
        instance.port === ready.instance.port &&
        instance.token === ready.instance.token,
    ),
    "readiness includes the exact recorded instance endpoint",
  );
  return ready.instance;
}

export function fixtureProcesses(filename: string): FixtureProcess[] {
  let source: string;
  try {
    source = readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return source
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const instance: FixtureProcess = JSON.parse(line);
      assert.ok(Number.isSafeInteger(instance.pid) && instance.pid > 1);
      assert.ok(
        Number.isSafeInteger(instance.port) &&
          instance.port > 0 &&
          instance.port <= 65535,
      );
      assert.match(instance.token, /^[a-f0-9]{64}$/);
      return instance;
    });
}

// One append owns both the actual argv and the credentialed lifetime. A
// cancellation between separate legacy log writes cannot lose this association.
export function fixtureInvocations(filename: string): string[] {
  return fixtureProcesses(filename).map((instance) => {
    assert.ok(
      Array.isArray(instance.args),
      "fixture instance includes actual argv",
    );
    assert.ok(instance.args.every((argument) => typeof argument === "string"));
    return `${instance.pid} ${instance.args.join(" ")}`;
  });
}

// Never probe or signal an old numeric PID. The fixture owns this endpoint
// until OS process exit, including while its real CLI or test gate is blocked.
export function fixtureRunning(instance: FixtureProcess): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: instance.port });
    let response = "";
    let settled = false;
    const finish = (error?: Error, running = false) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(running);
    };
    socket.setTimeout(1000, () =>
      finish(new Error(`Fixture ${instance.pid} lifetime probe timed out`)),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString("ascii");
      if (response.length > 65)
        finish(
          new Error(`Fixture ${instance.pid} lifetime response exceeds bound`),
        );
    });
    socket.once("end", () => {
      if (!/^[a-f0-9]{64}\n$/.test(response))
        finish(
          new Error(`Fixture ${instance.pid} lifetime response is invalid`),
        );
      else finish(undefined, response === instance.token + "\n");
    });
    socket.once("close", () => {
      if (!settled)
        finish(
          new Error(
            `Fixture ${instance.pid} lifetime probe closed unexpectedly`,
          ),
        );
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish();
      else finish(error);
    });
  });
}
