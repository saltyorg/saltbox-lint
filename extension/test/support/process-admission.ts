import type { ProcessRequest, runProcess } from "../../src/process.ts";
import type { ProcessFailureCategory } from "../../src/process-failure.ts";

type Admission =
  | { ok: true; request: Readonly<ProcessRequest> }
  | { ok: false; reason: Error };

/** Hold one captured request at its runner boundary, before any native spawn. */
export function holdProcessAdmission(
  run: typeof runProcess,
  command: "query" | "format",
) {
  let admit!: (value: Admission) => void;
  const admitted = new Promise<Admission>((resolve) => {
    admit = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  let disposed = false;
  const closed = new Error("Process admission owner closed");
  const operations = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const controlledRun: typeof runProcess = (
    request,
    signal,
    observeFailure,
    lifecycle,
  ) => {
    if (disposed) return Promise.reject(closed);
    let failureCategory: ProcessFailureCategory | undefined;
    const work = (async () => {
      if (!held && request.args[0] === command) {
        held = true;
        admit({ ok: true, request });
        await released;
      }
      if (disposed) throw closed;
      return run(
        request,
        signal,
        (category) => {
          failureCategory = category;
          observeFailure?.(category);
        },
        lifecycle,
      );
    })();
    const settled = work.then(
      () => {
        operations.delete(settled);
      },
      (error: unknown) => {
        const cancellation =
          signal.aborted &&
          (error === closed || failureCategory === "cancelled");
        // A cancellation outcome is expected; native/ownership cleanup failures
        // remain failures even when the operation signal has been aborted.
        if (!cancellation || error instanceof AggregateError)
          failures.push(error);
        operations.delete(settled);
      },
    );
    operations.add(settled);
    return work;
  };
  return {
    runProcess: controlledRun,
    async admission(): Promise<Readonly<ProcessRequest>> {
      const result = await admitted;
      if (!result.ok) throw result.reason;
      return result.request;
    },
    release,
    dispose() {
      disposed = true;
      release();
      admit({ ok: false, reason: closed });
    },
    async join() {
      while (operations.size) await Promise.all(operations);
      if (failures.length)
        throw new AggregateError(failures, "Process runner operations failed", {
          cause: failures[0],
        });
    },
  };
}

/** Subscribe before the edit; disposal also settles an unobserved mutation. */
export function observeDocumentChange<Document>(
  document: Document,
  onChange: (
    listener: (event: {
      document: Document;
      contentChanges: readonly unknown[];
    }) => void,
  ) => { dispose(): void },
) {
  let settle!: (changed: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const subscription = onChange((event) => {
    if (event.document === document && event.contentChanges.length)
      settle(true);
  });
  let disposed = false;
  return {
    async changed() {
      if (!(await pending))
        throw new Error("Document change owner closed before its event");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        subscription.dispose();
      } finally {
        settle(false);
      }
    },
    async join() {
      await pending;
    },
  };
}
