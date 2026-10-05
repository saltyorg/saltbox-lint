import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FixtureJournal,
  FixtureGateCohort,
  fixtureGateInstance,
  fixtureInvocations,
  fixtureProcesses,
  fixtureRunning,
  fixtureProbe,
} from "../host/fixture-processes.ts";

async function endpoint(answer: string | undefined, closeTimeoutMs = 5000) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (answer !== undefined) socket.end(answer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    instance: { pid: process.pid, port: address.port, token: "a".repeat(64) },
    async close() {
      for (const socket of sockets) socket.destroy();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), closeTimeoutMs);
      try {
        const closed = once(server, "close", { signal: controller.signal });
        server.close();
        await closed;
      } catch (error) {
        throw new Error(
          `Owned fixture endpoint ${process.pid}:${address.port} close failed within ${closeTimeoutMs}ms`,
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }
    },
    server,
  };
}

test("fixture lifetime rejects quiescence while the exact instance is alive", async () => {
  const live = await endpoint("a".repeat(64) + "\n");
  try {
    assert.equal(await fixtureRunning(live.instance), true);
    // A numeric PID is informational. An incorrect or reused PID cannot hide
    // a live owned instance, nor make an exited instance look live.
    assert.equal(await fixtureRunning({ ...live.instance, pid: 999999 }), true);
  } finally {
    await live.close();
  }
  process.kill(live.instance.pid, 0);
  assert.equal(await fixtureRunning(live.instance), false);
});

test("gate readiness keeps its exact live instance when historical PIDs repeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-gate-instance-"));
  const historical = await endpoint("a".repeat(64) + "\n");
  await historical.close();
  const live = await endpoint("b".repeat(64) + "\n");
  live.instance.token = "b".repeat(64);
  try {
    const filename = join(directory, "instances.jsonl");
    await writeFile(
      filename,
      [historical.instance, live.instance]
        .map((instance) => JSON.stringify(instance))
        .join("\n") + "\n",
    );
    const ready = { pid: live.instance.pid, instance: live.instance };
    const oldSelection = fixtureProcesses(filename).find(
      (instance) => instance.pid === ready.pid,
    );
    assert.deepEqual(oldSelection, historical.instance);
    assert.ok(oldSelection);
    assert.equal(await fixtureRunning(oldSelection), false);
    const selected = fixtureGateInstance(ready, filename);
    assert.deepEqual(selected, live.instance);
    assert.equal(await fixtureRunning(selected), true);
    await writeFile(
      filename,
      [live.instance, historical.instance]
        .map((instance) => JSON.stringify(instance))
        .join("\n") + "\n",
    );
    assert.deepEqual(fixtureGateInstance(ready, filename), live.instance);
    assert.equal(
      await fixtureRunning(fixtureGateInstance(ready, filename)),
      true,
    );
    assert.throws(
      () => fixtureGateInstance(JSON.parse('{"pid":123}'), filename),
      /readiness includes its instance endpoint/,
    );
    assert.throws(
      () => fixtureGateInstance({ ...ready, pid: ready.pid + 1 }, filename),
      /instance owns its PID/,
    );
    assert.throws(
      () =>
        fixtureGateInstance(
          { ...ready, instance: { ...live.instance, token: "c".repeat(64) } },
          filename,
        ),
      /exact recorded instance endpoint/,
    );
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing endpoint close notification fails within its cleanup deadline", async () => {
  const live = await endpoint("a".repeat(64) + "\n", 50);
  const emit = live.server.emit;
  live.server.emit = function (event, ...args) {
    if (event === "close") return false;
    return Reflect.apply(emit, this, [event, ...args]);
  };
  assert.equal(await fixtureRunning(live.instance), true);
  await assert.rejects(live.close(), /Owned fixture endpoint .*50ms/);
  assert.equal(live.server.listening, false);
  assert.equal(await fixtureRunning(live.instance), false);
  assert.equal(live.server.listenerCount("close"), 0);
});

test("a different valid instance token does not identify an owned survivor", async () => {
  const other = await endpoint("b".repeat(64) + "\n");
  try {
    assert.equal(await fixtureRunning(other.instance), false);
  } finally {
    await other.close();
  }
});

test("unknown or unresponsive lifetime endpoints fail conservatively", async () => {
  for (const answer of [undefined, "", "incomplete\n", "x".repeat(66)]) {
    const unknown = await endpoint(answer);
    try {
      await assert.rejects(fixtureRunning(unknown.instance), /lifetime/);
    } finally {
      await unknown.close();
    }
  }
});

test("a cancelled fixture keeps its exact argv and lifetime in one journal record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-instance-argv-"));
  const live = await endpoint("a".repeat(64) + "\n");
  try {
    const filename = join(directory, "instances.jsonl");
    const args = [
      "check",
      "--root",
      "root with spaces",
      "--",
      "roles/main.yml",
    ];
    await writeFile(
      filename,
      JSON.stringify({ ...live.instance, args }) + "\n",
    );
    // Cancellation may prevent a subsequent legacy process-log append. The
    // completed identity record still accounts for the exact invocation.
    assert.deepEqual(fixtureInvocations(filename), [
      `${live.instance.pid} ${args.join(" ")}`,
    ]);
    assert.deepEqual(fixtureProcesses(filename), [{ ...live.instance, args }]);
    assert.equal(await fixtureRunning(fixtureProcesses(filename)[0]), true);
    await live.close();
    assert.equal(await fixtureRunning(fixtureProcesses(filename)[0]), false);
    await writeFile(filename, JSON.stringify(live.instance) + "\n");
    assert.throws(() => fixtureInvocations(filename), /includes actual argv/);
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("observed fixture journal fails closed when complete membership regresses", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "saltbox-journal-membership-"),
  );
  const filename = join(directory, "instances.jsonl");
  const first = {
    pid: 123,
    port: 321,
    token: "a".repeat(64),
    args: ["check", "--root", "root with spaces"],
  };
  const middle = {
    pid: 124,
    port: 322,
    token: "b".repeat(64),
    args: ["check", "--", "middle.yml"],
  };
  const last = {
    pid: 125,
    port: 323,
    token: "c".repeat(64),
    args: ["check", "--", "last.yml"],
  };
  const rows = (...instances: (typeof first)[]) =>
    instances.map((instance) => JSON.stringify(instance) + "\n").join("");
  try {
    for (const [name, corrupted] of [
      ["missing", undefined],
      ["empty", ""],
      ["older valid prefix", rows(first)],
      ["omitted earlier row", rows(middle, last)],
      ["omitted middle row", rows(first, last)],
      ["mutated argv", rows(first, { ...middle, args: ["rules"] }, last)],
      ["mutated PID", rows(first, { ...middle, pid: 999 }, last)],
      ["mutated endpoint", rows(first, { ...middle, port: 999 }, last)],
      [
        "mutated credential",
        rows(first, { ...middle, token: "d".repeat(64) }, last),
      ],
      ["duplicate credential", rows(first, middle, last, middle)],
      ["incomplete JSON", rows(first, middle) + "{"],
      ["missing newline", rows(first, middle, last).slice(0, -1)],
      ["blank row", rows(first, middle, last) + "\n"],
      [
        "missing argv",
        rows(
          first,
          { ...middle, args: undefined } as unknown as typeof first,
          last,
        ),
      ],
      [
        "malformed argv",
        rows(first, { ...middle, args: [1] } as unknown as typeof first, last),
      ],
    ] as const) {
      const journal = new FixtureJournal(filename);
      await writeFile(filename, rows(first));
      assert.equal(journal.invocations().length, 1);
      // A later real complete read expands the retained membership. Neither a
      // suffix truncation nor a middle omission can forget this observation.
      await writeFile(filename, rows(first, middle, last));
      assert.equal(journal.invocations().length, 3);
      if (corrupted === undefined) await rm(filename);
      else await writeFile(filename, corrupted);
      assert.throws(() => journal.processes(true), name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal readiness binds exact argv and owns copies of complete observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-journal-ready-"));
  const filename = join(directory, "instances.jsonl");
  const live = await endpoint("a".repeat(64) + "\n");
  const instance = { ...live.instance, args: ["check", "--", "real path.yml"] };
  const journal = new FixtureJournal(filename);
  try {
    assert.deepEqual(journal.processes(), []);
    assert.throws(() => journal.processes(true), /journal is missing/);
    await writeFile(filename, "");
    assert.deepEqual(journal.processes(), []);
    assert.throws(() => journal.processes(true), /journal is empty/);
    await writeFile(filename, JSON.stringify(instance) + "\n");
    const ready = { pid: instance.pid, instance };
    assert.deepEqual(fixtureGateInstance(ready, filename, journal), instance);
    assert.equal(await fixtureRunning(journal.processes(true)[0]), true);
    assert.throws(
      () =>
        fixtureGateInstance(
          { ...ready, instance: { ...instance, args: ["rules"] } },
          filename,
          journal,
        ),
      /identity must not change/,
    );
    // Mutating a returned observation cannot alter retained expected membership.
    const returned = journal.processes()[0];
    returned.args![0] = "rules";
    returned.port = 1;
    assert.deepEqual(journal.processes(true), [instance]);
    await live.close();
    assert.equal(await fixtureRunning(journal.processes(true)[0]), false);
    await rm(filename);
    assert.throws(() => journal.processes(true), /journal is missing/);
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure snapshot refreshes the real journal without losing cached evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-journal-failure-"));
  const filename = join(directory, "instances.jsonl");
  const first = {
    pid: 123,
    port: 321,
    token: "a".repeat(64),
    args: ["check", "first.yml"],
  };
  const appended = {
    pid: 124,
    port: 322,
    token: "b".repeat(64),
    args: ["check", "alias.yml"],
  };
  const rows = (...instances: (typeof first)[]) =>
    instances.map((instance) => JSON.stringify(instance) + "\n").join("");
  try {
    await writeFile(filename, rows(first));
    const journal = new FixtureJournal(filename);
    journal.processes();
    await writeFile(filename, rows(first, appended));
    assert.deepEqual(
      journal.observations(),
      [first],
      "original cached catch omits the append",
    );
    const snapshot = journal.failureSnapshot();
    assert.deepEqual(snapshot.cached, [first]);
    assert.deepEqual(snapshot.refreshed, [first, appended]);
    assert.deepEqual(snapshot.retained, [first, appended]);
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.state, "complete");
    assert.equal(snapshot.raw, rows(first, appended));
    assert.ok(Number.isFinite(Date.parse(snapshot.capturedAt)));
    const tailRecord = {
      pid: 125,
      port: 323,
      token: "c".repeat(64),
      args: ["check", "fresh-tail.yml"],
    };
    await writeFile(filename, rows(first, appended, tailRecord) + "{");
    const malformed = journal.failureSnapshot();
    assert.equal(malformed.state, "partial");
    assert.deepEqual(malformed.refreshed, [first, appended, tailRecord]);
    assert.deepEqual(malformed.retained, [first, appended, tailRecord]);
    assert.match(malformed.error!, /incomplete/);
    await rm(filename);
    const missing = journal.failureSnapshot();
    assert.equal(missing.state, "unavailable");
    assert.deepEqual(missing.cached, [first, appended, tailRecord]);
    assert.deepEqual(missing.retained, [first, appended, tailRecord]);
    assert.match(missing.error!, /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure endpoint observations never count unknown or mismatched credentials as absent", async () => {
  for (const [answer, state] of [
    ["a".repeat(64) + "\n", "alive"],
    ["b".repeat(64) + "\n", "mismatch"],
    [undefined, "unavailable"],
    ["invalid\n", "unavailable"],
  ] as const) {
    const owned = await endpoint(answer);
    try {
      const result = await fixtureProbe(owned.instance);
      assert.equal(result.state, state);
      assert.deepEqual(result.instance, owned.instance);
    } finally {
      await owned.close();
    }
    assert.equal((await fixtureProbe(owned.instance)).state, "endpoint-absent");
  }
});

test("gated control membership excludes background and stale calls while retaining all cleanup credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-gate-cohort-"));
  const endpoints: Awaited<ReturnType<typeof endpoint>>[] = [];
  const args = [
    "format",
    "--root",
    directory,
    "--stdin-filename",
    join(directory, "selected.yaml"),
    "--mode",
    "canonical",
    "-",
  ];
  const instances: ReturnType<typeof fixtureProcesses>[number][] = [];
  const filename = join(directory, "instances.jsonl");
  const record = async (argv: string[]) => {
    const token = (instances.length + 1).toString(16).padStart(64, "0");
    const live = await endpoint(token + "\n");
    endpoints.push(live);
    const instance = { ...live.instance, token, args: argv };
    instances.push(instance);
    await writeFile(
      filename,
      instances.map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    return instance;
  };
  try {
    const stale = await record(args);
    const journal = new FixtureJournal(filename);
    const labels = [
      "canonical:stable",
      "canonical:retarget",
      "lint-fixes:stable",
      "lint-fixes:retarget",
      "fixAll:stable",
      "fixAll:retarget",
    ];
    const cohort = new FixtureGateCohort(filename, journal, labels);
    const foreign = await record(["check", "--", "unrelated.yaml"]);
    const first = await record(args);
    const ready = { pid: first.pid, instance: first, nonce: "current", args };
    assert.throws(() => cohort.complete(), /every intended control/);
    assert.throws(
      () =>
        cohort.capture(
          labels[0],
          { ...ready, nonce: "previous" },
          "current",
          args,
        ),
      /current control nonce/,
    );
    assert.throws(
      () =>
        cohort.capture(
          labels[0],
          {
            ...ready,
            args: args.map((a) =>
              a === join(directory, "selected.yaml")
                ? join(directory, "foreign.yaml")
                : a,
            ),
          },
          "current",
          args,
        ),
      /complete control argv/,
    );
    assert.throws(
      () =>
        cohort.capture(
          labels[0],
          { ...ready, instance: stale },
          "current",
          args,
        ),
      /new to this cohort/,
    );
    assert.throws(
      () => cohort.capture("unsolicited", ready, "current", args),
      /intended control/,
    );
    assert.throws(
      () =>
        cohort.capture(
          labels[0],
          { ...ready, instance: { ...foreign, args } },
          "current",
          args,
        ),
      /observed fixture identity must not change/,
    );
    assert.equal(
      await fixtureRunning(cohort.capture(labels[0], ready, "current", args)),
      true,
    );
    assert.throws(
      () => cohort.capture(labels[0], ready, "current", args),
      /not duplicated/,
    );
    assert.throws(
      () => cohort.capture(labels[1], ready, "current", args),
      /independent credentials/,
    );
    for (const label of labels.slice(1)) {
      const instance = await record(args);
      const nonce = label;
      assert.equal(
        await fixtureRunning(
          cohort.capture(
            label,
            { pid: instance.pid, instance, nonce, args },
            nonce,
            args,
          ),
        ),
        true,
      );
    }
    cohort.complete();
    assert.equal(
      journal.processes(true).length,
      8,
      "six controls plus stale/background calls all remain owned",
    );
  } finally {
    for (const live of endpoints) await live.close();
    for (const instance of instances)
      assert.equal((await fixtureProbe(instance)).state, "endpoint-absent");
    await rm(directory, { recursive: true, force: true });
  }
});
