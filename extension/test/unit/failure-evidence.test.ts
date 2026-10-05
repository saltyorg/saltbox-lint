import assert from "node:assert/strict";
import { test } from "node:test";
import {
  withFailureEvidence,
  publicFailureEvidence,
  logFailureEvidence,
} from "../host/failure-evidence.ts";
import { createHash } from "node:crypto";

test("large failure evidence survives the editor console limit without credentials", () => {
  const evidence = {
    phase: "alias assertion rejected before disposal",
    records: Array.from({ length: 600 }, (_, index) => ({
      index,
      pid: index + 100,
      token: "private fixture credential",
      args: ["check", "--stdin-filename", "a".repeat(300) + "😀"],
    })),
  };
  const messages: string[] = [];
  logFailureEvidence("SALTBOX_DEPENDENCY_FAILURE", evidence, (message) => {
    // VS Code 1.100 replaces a serialized console argument over 100000
    // characters with an omission message. Keep every real argument bounded.
    assert.ok(JSON.stringify([message]).length < 100000);
    assert.ok(!message.includes("private fixture credential"));
    messages.push(message);
  });
  const chunks = messages.map((message) =>
    JSON.parse(message.slice("SALTBOX_DEPENDENCY_FAILURE ".length)),
  ) as { index: number; count: number; sha256: string; text: string }[];
  assert.ok(chunks.length > 1);
  assert.deepEqual(
    chunks.map((chunk) => chunk.index),
    chunks.map((_, index) => index),
  );
  const text = chunks.map((chunk) => chunk.text).join("");
  const digest = createHash("sha256").update(text).digest("hex");
  assert.ok(
    chunks.every(
      (chunk) => chunk.count === chunks.length && chunk.sha256 === digest,
    ),
  );
  assert.deepEqual(JSON.parse(text), publicFailureEvidence(evidence));
});

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
