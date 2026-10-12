import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { classifyClosedFileEvent } from "./closed-file-event.ts";

type FileURI = Parameters<typeof classifyClosedFileEvent>[0];
type CanonicalPath = (filename: string) => string;
interface CapturedFile {
  fixture: FileURI;
  owner: string;
  failures: unknown[];
  consumedFailures: number;
}

function capture(fixture: FileURI, canonicalPath: CanonicalPath): CapturedFile {
  assert.equal(fixture.scheme, "file");
  assert.ok(isAbsolute(fixture.fsPath));
  return {
    fixture,
    // The leaf may be created after admission; its existing parent is fixed.
    owner: join(
      canonicalPath(dirname(fixture.fsPath)),
      basename(fixture.fsPath),
    ),
    failures: [],
    consumedFailures: 0,
  };
}

function classify(
  file: CapturedFile,
  event: FileURI,
  canonicalPath: CanonicalPath,
  allowMissing = false,
): "unrelated" | "target" | "failed" | "missing" {
  try {
    const result = classifyClosedFileEvent(
      event,
      file.fixture,
      file.owner,
      canonicalPath,
    );
    if (result !== "retargeted") return result;
    throw new Error("Closed file owner changed");
  } catch (error) {
    if (allowMissing && missing(error))
      try {
        if (sameParents(file, event, canonicalPath)) return "missing";
      } catch {
        // An absent/retargeted parent cannot establish this captured owner.
      }
    file.failures.push(
      new Error(
        "Closed file callback identity failed: " +
          JSON.stringify({
            fixture: file.fixture.toString().slice(0, 2048),
            owner: file.owner.slice(0, 2048),
            event: event.toString().slice(0, 2048),
          }),
        { cause: error },
      ),
    );
    return "failed";
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sameParents(
  file: CapturedFile,
  event: FileURI,
  canonicalPath: CanonicalPath,
): boolean {
  return (
    canonicalPath(dirname(file.fixture.fsPath)) === dirname(file.owner) &&
    canonicalPath(dirname(event.fsPath)) === dirname(file.owner)
  );
}

function assertNoFailures(
  files: readonly CapturedFile[],
  unconsumedOnly = false,
): void {
  const failures = files.flatMap((file) =>
    file.failures.slice(unconsumedOnly ? file.consumedFailures : 0),
  );
  for (const file of files) file.consumedFailures = file.failures.length;
  if (failures.length)
    throw new AggregateError(failures, "Closed file callback control failed", {
      cause: failures[0],
    });
}

/** Hold actual native callbacks for an admitted set of closed disk leaves. */
export function holdClosedFileEvents(
  fixtures: readonly FileURI[],
  canonicalPath: CanonicalPath = realpathSync.native,
) {
  const files = fixtures.map(
    (fixture): CapturedFile & { callbacks: (() => void)[] } => ({
      ...capture(fixture, canonicalPath),
      callbacks: [],
    }),
  );
  let released = false;
  return {
    hold(event: FileURI, callback: () => void): boolean {
      if (released) return false;
      for (const file of files) {
        const result = classify(file, event, canonicalPath);
        if (result === "unrelated") continue;
        if (result === "target") file.callbacks.push(callback);
        return true;
      }
      return false;
    },
    ready(): boolean {
      assertNoFailures(files);
      return files.every((file) => file.callbacks.length > 0);
    },
    release(): void {
      if (released) return;
      released = true;
      const failures: unknown[] = [];
      try {
        assertNoFailures(files, true);
      } catch (error) {
        failures.push(error);
      }
      for (const file of files)
        for (const callback of file.callbacks.splice(0))
          try {
            callback();
          } catch (error) {
            failures.push(error);
          }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Held closed file callbacks failed",
          {
            cause: failures[0],
          },
        );
    },
  };
}

/** A later native callback must handle the intended current disk bytes. */
export function observeClosedFileDeliveries(
  readText: (event: FileURI) => string | undefined,
  canonicalPath: CanonicalPath = realpathSync.native,
) {
  const files: Array<
    CapturedFile & {
      active: boolean;
      latest?: { sequence: number; text?: string };
    }
  > = [];
  let sequence = 0;
  let disposed = false;
  return {
    delivered(
      event: FileURI,
      kind: "create" | "change" | "delete" = "change",
    ): void {
      if (disposed) return;
      const current = ++sequence;
      for (const file of files) {
        if (!file.active) continue;
        const result = classify(file, event, canonicalPath, true);
        if (result === "failed" || result === "unrelated") continue;
        if (result === "missing" || kind === "delete") {
          file.latest = { sequence: current };
          continue;
        }
        try {
          file.latest = { sequence: current, text: readText(event) };
        } catch (error) {
          try {
            if (missing(error) && sameParents(file, event, canonicalPath)) {
              file.latest = { sequence: current };
              continue;
            }
          } catch {
            // Preserve the original read failure when current ownership is unknown.
          }
          file.failures.push(error);
        }
      }
    },
    next(fixture: FileURI, text: string): () => boolean {
      assert.equal(disposed, false, "Closed file delivery observer is closed");
      const file = capture(fixture, canonicalPath);
      const entry: (typeof files)[number] = { ...file, active: true };
      files.push(entry);
      const before = sequence;
      let accepted = false;
      return () => {
        assert.equal(
          disposed,
          false,
          "Closed file delivery observer is closed",
        );
        try {
          assertNoFailures([entry]);
        } catch (error) {
          entry.active = false;
          throw error;
        }
        if (accepted) return true;
        accepted =
          !!entry.latest &&
          entry.latest.sequence > before &&
          entry.latest.text === text;
        if (accepted) entry.active = false;
        return accepted;
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        assertNoFailures(files, true);
      } finally {
        files.length = 0;
      }
    },
  };
}
