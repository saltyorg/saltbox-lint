import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { disposeResources, rollbackResources } from "../../src/disposables.ts";

interface FileURI {
  readonly scheme: string;
  readonly fsPath: string;
  toString(): string;
}
type CanonicalPath = (filename: string) => string;
type Outcome = { ok: true } | { ok: false; error: unknown };

/** Match this closed disk fixture without merging open document identities. */
export function classifyClosedFileEvent(
  event: FileURI,
  fixture: FileURI,
  capturedOwner: string,
  canonicalPath: CanonicalPath = realpathSync.native,
): "unrelated" | "target" | "retargeted" {
  if (event.scheme !== "file" || !isAbsolute(event.fsPath)) return "unrelated";
  const leaf = basename(fixture.fsPath);
  const parents = [dirname(fixture.fsPath), dirname(capturedOwner)];
  if (!parents.some((parent) => relative(parent, event.fsPath) === leaf))
    return "unrelated";
  return canonicalPath(fixture.fsPath) === capturedOwner &&
    canonicalPath(event.fsPath) === capturedOwner
    ? "target"
    : "retargeted";
}

function scheduleDeadline(expire: () => void, milliseconds: number) {
  const timer = setTimeout(expire, milliseconds);
  return () => clearTimeout(timer);
}

/** Own watcher readiness, including cancellation before a failed disk write. */
export function observeClosedFileEvent(
  fixture: FileURI,
  capturedOwner: string,
  subscribe: (listener: (event: FileURI) => void) => { dispose(): void },
  options: {
    expectedSha256: string;
    canonicalPath?: CanonicalPath;
    readBytes?: (filename: string) => Uint8Array;
    scheduleDeadline?: typeof scheduleDeadline;
  },
) {
  let settle!: (outcome: Outcome) => void;
  const pending = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  let disposed = false;
  let failureConsumed = false;
  const closed = new Error(
    "Closed template context observer disposed before its event",
  );
  const observed: string[] = [];
  let observedSha256: string | undefined;
  const evidence = () =>
    JSON.stringify({
      fixture: fixture.toString().slice(0, 2048),
      capturedOwner: capturedOwner.slice(0, 2048),
      expectedSha256: options.expectedSha256,
      observedSha256,
      observed,
    });
  const finish = (outcome: Outcome) => {
    if (settled) return;
    settled = true;
    settle(outcome);
  };
  let subscription: { dispose(): void } | undefined;
  let cancelDeadline: (() => void) | undefined;
  try {
    subscription = subscribe((event) => {
      if (disposed || settled) return;
      try {
        if (observed.length < 16)
          observed.push(event.toString().slice(0, 2048));
        const identity = classifyClosedFileEvent(
          event,
          fixture,
          capturedOwner,
          options.canonicalPath,
        );
        if (identity === "target") {
          observedSha256 = createHash("sha256")
            .update((options.readBytes ?? readFileSync)(event.fsPath))
            .digest("hex");
          if (observedSha256 === options.expectedSha256) finish({ ok: true });
        } else if (identity === "retargeted")
          finish({
            ok: false,
            error: new Error(
              "Closed template context owner changed: " + evidence(),
            ),
          });
      } catch (error) {
        finish({
          ok: false,
          error: new Error(
            "Closed template context identity failed: " + evidence(),
            {
              cause: error,
            },
          ),
        });
      }
    });
    cancelDeadline = (options.scheduleDeadline ?? scheduleDeadline)(
      () =>
        finish({
          ok: false,
          error: new Error(
            "closed template context event was not delivered: " + evidence(),
          ),
        }),
      10000,
    );
  } catch (error) {
    disposed = true;
    finish({ ok: false, error });
    rollbackResources(error, subscription ? [subscription] : []);
  }
  return {
    async changed() {
      const outcome = await pending;
      if (!outcome.ok) {
        failureConsumed = true;
        throw outcome.error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        disposeResources([
          { dispose: () => cancelDeadline?.() },
          { dispose: () => subscription?.dispose() },
        ]);
      } finally {
        finish({
          ok: false,
          error: closed,
        });
      }
    },
    async join() {
      const outcome = await pending;
      if (!outcome.ok && outcome.error !== closed && !failureConsumed)
        throw outcome.error;
    },
  };
}
