import assert from "node:assert/strict";
import { test } from "node:test";
import Mocha from "mocha";
import {
  hostFailureEvidence,
  withHostFailureEvidence,
} from "../support/host-failure.ts";
import { runHostSuite } from "../support/host-suite.ts";

class SilentReporter extends Mocha.reporters.Base {}

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
