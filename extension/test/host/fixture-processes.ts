import assert from "node:assert/strict";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
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
  journal?: FixtureJournal,
): FixtureProcess {
  assert.ok(ready.instance, "readiness includes its instance endpoint");
  assert.equal(
    ready.instance.pid,
    ready.pid,
    "readiness instance owns its PID",
  );
  assert.ok(
    (journal ? journal.processes() : fixtureProcesses(filename)).some(
      (instance) =>
        instance.pid === ready.instance.pid &&
        instance.port === ready.instance.port &&
        instance.token === ready.instance.token,
    ),
    "readiness includes the exact recorded instance endpoint",
  );
  if (journal) journal.expect(ready.instance);
  return ready.instance;
}

// The journal is append-only. Keep independent earlier observations so two
// projections of a lost or truncated file cannot establish cleanup membership.
// Before the first complete observation a missing file is unrecorded startup.
export class FixtureJournal {
  private readonly observed = new Map<string, FixtureProcess>();
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
  }

  observations(): FixtureProcess[] {
    return [...this.observed.values()].map((instance) => ({
      ...instance,
      args: [...instance.args!],
    }));
  }

  expect(instance: FixtureProcess): void {
    assert.ok(
      Array.isArray(instance.args),
      "fixture instance includes actual argv",
    );
    assert.ok(instance.args.every((argument) => typeof argument === "string"));
    const previous = this.observed.get(instance.token);
    if (previous)
      assert.deepEqual(
        instance,
        previous,
        "observed fixture identity must not change",
      );
    // Own the record and argv, rather than mutable objects returned to callers.
    this.observed.set(instance.token, {
      ...instance,
      args: [...instance.args],
    });
  }

  processes(final = false): FixtureProcess[] {
    let source: string;
    try {
      source = readFileSync(this.filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      assert.ok(
        !final && this.observed.size === 0,
        "observed fixture journal is missing",
      );
      return [];
    }
    if (source === "") {
      assert.ok(
        !final && this.observed.size === 0,
        "observed fixture journal is empty",
      );
      return [];
    }
    assert.ok(
      source.endsWith("\n"),
      "fixture journal has an incomplete record",
    );
    const lines = source.slice(0, -1).split("\n");
    assert.ok(lines.every(Boolean), "fixture journal has an empty record");
    const instances = parseFixtureProcesses(source);
    assert.equal(
      new Set(instances.map((instance) => instance.token)).size,
      instances.length,
      "fixture journal has duplicate credentials",
    );
    const current = new Map(
      instances.map((instance) => [instance.token, instance]),
    );
    for (const [token, previous] of this.observed)
      assert.deepEqual(
        current.get(token),
        previous,
        "observed fixture journal lost or changed a record",
      );
    for (const instance of instances) this.expect(instance);
    return instances;
  }

  // Failure evidence keeps the old projection distinct from a fresh read.
  // A malformed tail must not discard earlier complete, validated records.
  failureSnapshot(): FixtureJournalSnapshot {
    const snapshot: FixtureJournalSnapshot = {
      capturedAt: new Date().toISOString(),
      state: "unavailable",
      cached: this.observations(),
      refreshed: [],
      retained: [],
    };
    try {
      const fd = openSync(this.filename, "r");
      try {
        const limit = 1024 * 1024;
        assert.ok(
          fstatSync(fd).size <= limit,
          "fixture journal exceeds failure capture bound",
        );
        const bytes = Buffer.alloc(limit + 1);
        const length = readSync(fd, bytes, 0, bytes.length, 0);
        assert.ok(
          length <= limit,
          "fixture journal exceeds failure capture bound",
        );
        snapshot.raw = bytes.subarray(0, length).toString("utf8");
      } finally {
        closeSync(fd);
      }
      snapshot.state = "partial";
      const lines = snapshot.raw.split("\n");
      const tail = lines.pop();
      const tokens = new Set<string>();
      for (const line of lines) {
        assert.ok(line, "fixture journal has an empty record");
        const instance = parseFixtureProcesses(line)[0];
        assert.ok(
          !tokens.has(instance.token),
          "fixture journal has duplicate credentials",
        );
        tokens.add(instance.token);
        this.expect(instance);
        snapshot.refreshed.push(instance);
      }
      assert.equal(tail, "", "fixture journal has an incomplete record");
      assert.ok(lines.length > 0, "fixture journal is empty");
      for (const previous of snapshot.cached)
        assert.ok(
          tokens.has(previous.token),
          "observed fixture journal lost a record",
        );
      snapshot.state = "complete";
    } catch (error) {
      snapshot.error = redactFixtureEvidence(
        error instanceof Error ? error.message : String(error),
      );
    }
    snapshot.retained = this.observations();
    return snapshot;
  }

  invocations(): string[] {
    return this.processes().map(
      (instance) => `${instance.pid} ${instance.args!.join(" ")}`,
    );
  }
}

export function fixtureProcesses(filename: string): FixtureProcess[] {
  let source: string;
  try {
    source = readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseFixtureProcesses(source);
}

function parseFixtureProcesses(source: string): FixtureProcess[] {
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

export interface FixtureJournalSnapshot {
  capturedAt: string;
  state: "complete" | "partial" | "unavailable";
  cached: FixtureProcess[];
  refreshed: FixtureProcess[];
  retained: FixtureProcess[];
  raw?: string;
  error?: string;
}

export function redactFixtureEvidence(text: string): string {
  return text.replace(/[a-f0-9]{64}/g, "<REDACTED>");
}

export interface FixtureProbe {
  instance: FixtureProcess;
  capturedAt: string;
  completedAt: string;
  state: "alive" | "endpoint-absent" | "mismatch" | "unavailable";
  error?: string;
}

// Observation only. A mismatch or failed probe cannot establish absence.
export function fixtureProbe(instance: FixtureProcess): Promise<FixtureProbe> {
  const capturedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: instance.port });
    let response = "";
    let settled = false;
    const finish = (state: FixtureProbe["state"], error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        instance,
        capturedAt,
        completedAt: new Date().toISOString(),
        state,
        ...(error ? { error } : {}),
      });
    };
    const timer = setTimeout(
      () => finish("unavailable", "lifetime probe timed out"),
      1000,
    );
    socket.on("data", (chunk) => {
      response += chunk.toString("ascii");
      if (response.length > 65)
        finish("unavailable", "lifetime response exceeds bound");
    });
    socket.once("end", () => {
      if (!/^[a-f0-9]{64}\n$/.test(response))
        finish("unavailable", "lifetime response is invalid");
      else finish(response === instance.token + "\n" ? "alive" : "mismatch");
    });
    socket.once("close", () =>
      finish("unavailable", "lifetime probe closed unexpectedly"),
    );
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish("endpoint-absent");
      else finish("unavailable", error.code ?? error.name);
    });
  });
}
