import assert from "node:assert/strict";
import { test } from "node:test";
import Mocha from "mocha";
import {
  hostFailureEvidence,
  withHostFailureEvidence,
} from "../support/host-failure.ts";
import { runHostSuite } from "../support/host-suite.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { holdProcessAdmission } from "../support/process-admission.ts";
import { SubcaseFailures } from "../support/subcase-failures.ts";
import { withTestResources } from "../support/test-resources.ts";

class SilentReporter extends Mocha.reporters.Base {}

test("joined regression owners retain original native cleanup faults through the full Mocha wrapper chain", async () => {
  let entered!: () => void;
  const joining = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let run!: () => void;
  const running = new Promise<void>((resolve) => {
    run = resolve;
  });
  const cancellation = new Error("Canceled");
  const original = Object.assign(new Error("injected native cleanup fault"), {
    code: "EIO",
    phase: "exit",
    resource: "native group observation",
  });
  const native = new AggregateError(
    [cancellation, original],
    "Process and native cleanup failed",
    { cause: cancellation },
  );
  let nativeJoined = false;
  let caller: Promise<unknown> | undefined;
  const records: string[] = [];
  const pending = withHostFailureEvidence(
    () =>
      runHostSuite(
        "regressions",
        async () => {},
        [
          {
            name: "regressions behavior and owned cleanup",
            async exercise(resources) {
              await withTestResources(
                { cleanupTimeoutMs: 15000, operationSignal: resources.signal },
                async (cohort) => {
                  const failures = new SubcaseFailures();
                  try {
                    await withTestResources(
                      {
                        cleanupTimeoutMs: 15000,
                        operationSignal: cohort.signal,
                      },
                      async (owner) => {
                        const gate = holdProcessAdmission(
                          async (_request, _signal, observeFailure) => {
                            run();
                            await held;
                            nativeJoined = true;
                            observeFailure?.("cancelled");
                            throw native;
                          },
                          "format",
                        );
                        ownJoinedResource(
                          owner,
                          "unrelated edit format admission",
                          {
                            dispose: () => gate.dispose(),
                            async join() {
                              entered();
                              await gate.join();
                            },
                          },
                        );
                        caller = gate
                          .runProcess(
                            {
                              executable: "controlled native adapter",
                              cwd: "owned fixture",
                              args: ["format"],
                            },
                            owner.signal,
                          )
                          .then(
                            () => undefined,
                            (error: unknown) => error,
                          );
                        await gate.admission();
                        gate.release();
                        await running;
                      },
                    );
                  } catch (error) {
                    failures.record(
                      "I1 unrelated edits preserve current actions and pending format",
                      error,
                    );
                  }
                  failures.throwIfAny("review regressions");
                },
              );
            },
          },
        ],
        { reporter: SilentReporter },
      ),
    (line) => {
      assert.equal(nativeJoined, true);
      records.push(line);
    },
  );
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await Promise.race([
      joining,
      outcome.then((error) => {
        throw new Error("suite settled before owned cleanup readiness", {
          cause: error,
        });
      }),
    ]);
    assert.equal(nativeJoined, false);
    assert.equal(
      records.length,
      0,
      "failure evidence must wait for native join",
    );
    release();
    assert.ok((await outcome) instanceof AggregateError);
    assert.equal(await caller, native);
    assert.equal(records.length, 1);
    const evidence: unknown = JSON.parse(
      records[0].slice("SALTBOX_EDITOR_FAILURE ".length),
    );
    assert.ok(
      evidence &&
        typeof evidence === "object" &&
        "nodes" in evidence &&
        Array.isArray(evidence.nodes),
    );
    const leaf: unknown = evidence.nodes.find(
      (node: unknown) =>
        node &&
        typeof node === "object" &&
        "message" in node &&
        node.message === original.message,
    );
    assert.ok(
      leaf && typeof leaf === "object",
      "original cleanup cause missing",
    );
    assert.equal("code" in leaf && leaf.code, "EIO");
    assert.equal("phase" in leaf && leaf.phase, "exit");
    assert.equal(
      "resource" in leaf && leaf.resource,
      "native group observation",
    );
    assert.equal("truncated" in evidence && evidence.truncated, false);
  } finally {
    release();
    await outcome;
    await caller;
  }
});

test("joined Mocha cleanup failures expose nested causes without replacing the original suite error", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = new Error(
    "the loaded product exposes its standard deactivation hook",
  );
  const records: string[] = [];
  const pending = withHostFailureEvidence(
    () =>
      runHostSuite(
        "cleanup evidence",
        async () => {},
        [
          {
            name: "installed lifecycle",
            async exercise(resources) {
              resources.defer("installed product lifecycle", async () => {
                enter();
                await held;
                throw new AggregateError(
                  [original],
                  "Owned installed product lifecycle failed to close",
                );
              });
            },
          },
        ],
        { reporter: SilentReporter },
      ),
    (line) => {
      records.push(line);
    },
  );
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered;
    assert.equal(
      records.length,
      0,
      "evidence is not completion before cleanup joins",
    );
    release();
    assert.ok((await outcome) instanceof AggregateError);
    assert.equal(records.length, 1);
    const evidence: unknown = JSON.parse(
      records[0].slice("SALTBOX_EDITOR_FAILURE ".length),
    );
    assert.ok(
      evidence &&
        typeof evidence === "object" &&
        "nodes" in evidence &&
        Array.isArray(evidence.nodes),
    );
    assert.ok(
      evidence.nodes.some(
        (node: unknown) =>
          node &&
          typeof node === "object" &&
          "message" in node &&
          node.message === original.message,
      ),
    );
  } finally {
    release();
    await outcome;
  }
});

test("successful observation rethrows the exact original failure", async () => {
  const original = new Error("original failure");
  const lines: string[] = [];
  await assert.rejects(
    withHostFailureEvidence(
      () => Promise.reject(original),
      (line) => {
        lines.push(line);
      },
    ),
    (error: unknown) => error === original,
  );
  assert.equal(lines.length, 1);
});

test("failed evidence output retains both original and observation errors", async () => {
  const original = new Error("original failure");
  const observer = new Error("output failed");
  await assert.rejects(
    withHostFailureEvidence(
      () => Promise.reject(original),
      () => {
        throw observer;
      },
    ),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.cause === original &&
      error.errors[0] === original &&
      error.errors[1] === observer,
  );
});

test("cycles and oversized error graphs remain bounded and explicitly truncated", () => {
  const root = new AggregateError(
    Array.from({ length: 100 }, () => new Error("x".repeat(10000))),
    "root",
  );
  root.cause = root;
  const evidence = hostFailureEvidence(root);
  assert.equal(evidence.truncated, true);
  assert.ok(evidence.nodes.length <= 32);
  assert.ok(evidence.nodes.some((node) => node.reference === 0));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 65536);

  let deep = new Error("deepest original failure");
  for (let index = 0; index < 40; index++)
    deep = new Error("x".repeat(10000), { cause: deep });
  const chain = hostFailureEvidence(deep);
  assert.equal(chain.truncated, true);
  assert.ok(chain.nodes.length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(chain)) < 65536);
});

test("native payload fields and lifetime credentials cannot enter failure evidence", () => {
  const token = "a".repeat(64);
  const native = Object.assign(new Error("raw child payload"), {
    stdout: "private source",
    stderr: "private output",
    argv: ["private argument"],
    env: { SECRET: "private environment" },
  });
  const root = new AggregateError(
    [native, new Error("credential " + token)],
    "root\u001b[31m",
  );
  const result = JSON.stringify(hostFailureEvidence(root));
  for (const excluded of [
    token,
    "private source",
    "private output",
    "private argument",
    "private environment",
    "raw child payload",
  ])
    assert.equal(result.includes(excluded), false);
  assert.equal(result.includes("\\u001b"), false);
});

test("failed error-property observation remains a separate failure", async () => {
  const observer = new Error("property failed");
  const original = Object.defineProperty(new Error("original"), "cause", {
    get() {
      throw observer;
    },
  });
  await assert.rejects(
    withHostFailureEvidence(
      () => Promise.reject(original),
      () => {},
    ),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors[0] === original &&
      error.errors[1] === observer,
  );
});
