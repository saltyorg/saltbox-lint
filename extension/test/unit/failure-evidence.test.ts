import assert from "node:assert/strict";
import { test } from "node:test";
import {
  withFailureEvidence,
  publicFailureEvidence,
} from "../host/failure-evidence.ts";

test("failure evidence is unused on success and starts only after original rejection", async () => {
  const events: string[] = [];
  assert.equal(
    await withFailureEvidence(
      async () => 7,
      async () => {
        throw new Error("must not collect");
      },
      () => {
        throw new Error("must not log");
      },
    ),
    7,
  );
  const original = new Error("alias recovery");
  await assert.rejects(
    withFailureEvidence(
      async () => {
        events.push("reject");
        throw original;
      },
      async () => {
        events.push("collect");
        return "facts";
      },
      () => {
        events.push("log");
      },
    ),
    (error: unknown) => error === original,
  );
  assert.deepEqual(events, ["reject", "collect", "log"]);
});

test("collector and logger faults preserve the original assertion identity", async () => {
  const original = new Error("alias recovery");
  for (const failure of ["collector", "logger"]) {
    await assert.rejects(
      withFailureEvidence(
        async () => {
          throw original;
        },
        async () => {
          if (failure === "collector") throw new Error("capture failed");
          return {};
        },
        () => {
          throw new Error("logger failed");
        },
      ),
      (error: unknown) => error === original,
    );
  }
});

test("public evidence hides credentials while retaining digest, argv and content hashes", () => {
  const token = "a".repeat(64);
  const result = publicFailureEvidence({
    raw: token,
    instance: { token, pid: 123, port: 42, args: ["check", "alias.yml"] },
    textHash: "b".repeat(64),
  });
  assert.deepEqual(result, {
    instance: {
      token: "<REDACTED>",
      pid: 123,
      port: 42,
      args: ["check", "alias.yml"],
      credentialSha256:
        "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    },
    textHash: "b".repeat(64),
  });
});

test("a rejected collector reports unavailable evidence without replacing the original error", async () => {
  const original = new Error("alias recovery");
  let evidence: unknown;
  await assert.rejects(
    withFailureEvidence(
      async () => {
        throw original;
      },
      async () => {
        throw new Error("collector unavailable");
      },
      (facts) => {
        evidence = facts;
      },
    ),
    (error: unknown) => error === original,
  );
  assert.ok(evidence && typeof evidence === "object" && "phase" in evidence);
  assert.equal(evidence.phase, "failure collector rejected");
});
