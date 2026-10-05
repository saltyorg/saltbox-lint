import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FixtureJournal,
  fixtureProbe,
  redactFixtureEvidence,
} from "./fixture-processes.ts";

// The operation and its error remain authoritative. Collection and logging
// start only after rejection and cannot replace that original error.
export async function withFailureEvidence<T>(
  operation: () => Promise<T>,
  collect: (error: unknown) => Promise<unknown>,
  log: (evidence: unknown) => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    let evidence: unknown;
    try {
      evidence = await collect(error);
    } catch (captureError) {
      evidence = {
        schemaVersion: 1,
        phase: "failure collector rejected",
        capturedAt: new Date().toISOString(),
        error: failureReason(captureError),
        originalError: failureReason(error),
      };
    }
    try {
      log(evidence);
    } catch {
      // Failure logging must not replace the assertion being investigated.
    }
    throw error;
  }
}

export function failureReason(error: unknown) {
  return {
    name: error instanceof Error ? error.name : "unknown error",
    message: redactFixtureEvidence(
      error instanceof Error ? error.message : String(error),
    ),
  };
}

export function publicFailureEvidence(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => {
      if (key === "raw") return undefined;
      if (item && typeof item === "object" && "token" in item) {
        const { token, ...rest } = item as Record<string, unknown>;
        if (typeof token === "string")
          return {
            ...rest,
            token: "<REDACTED>",
            credentialSha256: createHash("sha256").update(token).digest("hex"),
          };
      }
      return item;
    }),
  );
}

export function logFailureEvidence(
  prefix: string,
  evidence: unknown,
  write: (message: string) => void = console.error,
): void {
  const text = JSON.stringify(publicFailureEvidence(evidence));
  const sha256 = createHash("sha256").update(text).digest("hex");
  // VS Code bounds serialized console arguments. Small numbered records keep
  // complete redacted evidence reconstructable, even for a large journal.
  const chunkSize = 4096;
  const count = Math.ceil(text.length / chunkSize);
  for (let index = 0; index < count; index++)
    write(
      prefix +
        " " +
        JSON.stringify({
          schemaVersion: 1,
          index,
          count,
          sha256,
          text: text.slice(index * chunkSize, (index + 1) * chunkSize),
        }),
    );
}

export async function journalFailureEvidence(journal: FixtureJournal) {
  const startedAt = new Date().toISOString();
  const snapshot = journal.failureSnapshot();
  const endpoints = await Promise.all(snapshot.retained.map(fixtureProbe));
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    journal: snapshot,
    endpoints,
  };
}

// Retained only on failure. This directory is outside the disposable fixture
// tree. CI logs carry redacted facts; this local path is not a durable CI artifact.
export async function retainFailureEvidence(evidence: unknown) {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "saltbox-failure-evidence-"));
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, "before-disposal.json"),
      JSON.stringify(evidence),
      { mode: 0o600 },
    );
    return {
      state: "retained",
      directory,
      reason: "original failure evidence; review at next diagnosis handoff",
      access:
        process.platform === "win32"
          ? "mode bits do not enforce a private Windows ACL"
          : "directory 0700; file 0600",
      ciDurability:
        "runner-local raw files unavailable after CI unless separately retained",
    };
  } catch (error) {
    return {
      state: "unavailable",
      directory,
      error: redactFixtureEvidence(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

export async function retainAfterDisposal(
  directory: string,
  evidence: unknown,
) {
  await writeFile(
    join(directory, "after-disposal.json"),
    JSON.stringify(evidence),
    { mode: 0o600 },
  );
}
