type Awaitable<T> = T | PromiseLike<T>;

export interface TestResourcesOptions {
  cleanupTimeoutMs: number;
  operationSignal?: AbortSignal;
  cleanupSignal?: AbortSignal;
  scheduleDeadline?: (expire: () => void, milliseconds: number) => () => void;
}

export class TestResourceError extends Error {
  readonly phase: "operation" | "cleanup";
  readonly resource: string;

  constructor(
    phase: "operation" | "cleanup",
    resource: string,
    cause: unknown,
  ) {
    super(`Test ${phase} ${JSON.stringify(resource)} failed`, { cause });
    this.name = "TestResourceError";
    this.phase = phase;
    this.resource = resource;
  }
}

type Cleanup = {
  name: string;
  restore: (signal: AbortSignal) => Awaitable<void>;
};
type Operation = { name: string; settled: Promise<void> };
type Phase = "open" | "joining" | "cleaning" | "closed";

/**
 * Owns work and restoration for one test. Resource adapters must register their
 * real close/join operation with defer(); delivering cancellation is not a join.
 * Cleanup deadlines abort their own signal and report failure, then still await
 * settlement. The external runner must reap a host whose cleanup ignores abort.
 */
export class TestResources {
  private readonly work = new AbortController();
  private readonly operations = new Set<Operation>();
  private readonly cleanups: Cleanup[] = [];
  private readonly failures: TestResourceError[] = [];
  private phase: Phase = "open";
  private activeCleanup: Cleanup | undefined;
  private closing: Promise<void> | undefined;
  private readonly options: TestResourcesOptions;
  private readonly cancelFromParent: (() => void) | undefined;

  constructor(options: TestResourcesOptions) {
    if (
      !Number.isFinite(options.cleanupTimeoutMs) ||
      options.cleanupTimeoutMs <= 0
    ) {
      throw new RangeError("A positive finite cleanup timeout is required");
    }
    this.options = { ...options };
    const parent = this.options.operationSignal;
    if (parent) {
      this.cancelFromParent = () => this.cancel(parent.reason);
      parent.addEventListener("abort", this.cancelFromParent, { once: true });
      if (parent.aborted) this.cancelFromParent();
    }
  }

  get signal(): AbortSignal {
    return this.work.signal;
  }

  /** Admission and tracking happen before the operation callback can run. */
  operation<T>(
    name: string,
    perform: (signal: AbortSignal) => Awaitable<T>,
  ): Promise<T> {
    if (this.phase !== "open") {
      throw new Error(
        `Cannot admit test operation ${JSON.stringify(name)} while ${this.phase}`,
      );
    }
    const result = Promise.resolve().then(() => perform(this.signal));
    const operation: Operation = {
      name,
      settled: result.then(
        () => {
          this.operations.delete(operation);
        },
        (error: unknown) => {
          this.failures.push(new TestResourceError("operation", name, error));
          this.operations.delete(operation);
        },
      ),
    };
    this.operations.add(operation);
    return result;
  }

  /**
   * Register restoration immediately after acquisition. An admitted acquisition
   * may finish during joining, and must still register its newly owned resource.
   */
  defer(name: string, restore: (signal: AbortSignal) => Awaitable<void>): void {
    if (this.phase === "cleaning" || this.phase === "closed") {
      throw new Error(
        `Cannot register test cleanup ${JSON.stringify(name)} while ${this.phase}`,
      );
    }
    this.cleanups.push({ name, restore });
  }

  cancel(reason: unknown = new Error("Test operations canceled")): void {
    this.work.abort(reason);
  }

  snapshot(): {
    phase: Phase;
    operations: readonly string[];
    cleanups: readonly string[];
  } {
    return {
      phase: this.phase,
      operations: [...this.operations].map((operation) => operation.name),
      cleanups: [
        ...this.cleanups.map((cleanup) => cleanup.name),
        ...(this.activeCleanup ? [this.activeCleanup.name] : []),
      ],
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.phase = "joining";
    this.closing = Promise.resolve().then(() => this.restore());
    this.cancel(new Error("Test resource owner is closing"));
    return this.closing;
  }

  private async restore(): Promise<void> {
    try {
      if (this.operations.size > 0) {
        await this.restoreOne({
          name: "admitted operations",
          restore: async () => {
            await Promise.all(
              [...this.operations].map((operation) => operation.settled),
            );
          },
        });
      }
      this.phase = "cleaning";
      while (this.cleanups.length > 0) {
        const cleanup = this.cleanups.pop();
        if (!cleanup) break;
        this.activeCleanup = cleanup;
        await this.restoreOne(cleanup);
        this.activeCleanup = undefined;
      }
      this.phase = "closed";
      const failures = this.failures.splice(0);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Owned test resources failed", {
          cause: failures[0],
        });
      }
    } finally {
      if (this.cancelFromParent)
        this.options.operationSignal?.removeEventListener(
          "abort",
          this.cancelFromParent,
        );
    }
  }

  private async restoreOne(cleanup: Cleanup): Promise<void> {
    const controller = new AbortController();
    const parentSignal = this.options.cleanupSignal;
    const abortFromParent = () =>
      controller.abort(
        new Error(`Cleanup ${JSON.stringify(cleanup.name)} canceled`, {
          cause: parentSignal?.reason,
        }),
      );
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    const failures: unknown[] = [];
    let cancelDeadline: (() => void) | undefined;
    try {
      const schedule = this.options.scheduleDeadline ?? scheduleDeadline;
      cancelDeadline = schedule(
        () =>
          controller.abort(
            new Error(
              `Cleanup ${JSON.stringify(cleanup.name)} exceeded ${this.options.cleanupTimeoutMs}ms`,
            ),
          ),
        this.options.cleanupTimeoutMs,
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanup.restore(controller.signal);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        cancelDeadline?.();
      } catch (error) {
        failures.push(error);
      }
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason;
      if (!failures.includes(reason)) failures.unshift(reason);
    }
    if (failures.length > 0) {
      this.failures.push(
        new TestResourceError(
          "cleanup",
          cleanup.name,
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Cleanup failed"),
        ),
      );
    }
  }
}

function scheduleDeadline(
  expire: () => void,
  milliseconds: number,
): () => void {
  const timer = setTimeout(expire, milliseconds);
  return () => clearTimeout(timer);
}

/** Run a body and preserve its failure together with independently failed cleanup. */
export async function withTestResources<T>(
  options: TestResourcesOptions,
  body: (resources: TestResources) => Awaitable<T>,
): Promise<T> {
  const resources = new TestResources(options);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    resources.signal.throwIfAborted();
    outcome = { ok: true, value: await body(resources) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failures: unknown[] = outcome.ok ? [] : [outcome.error];
  try {
    await resources.close();
  } catch (error) {
    if (error instanceof AggregateError) {
      for (const failure of error.errors as unknown[]) {
        if (
          !outcome.ok &&
          failure instanceof TestResourceError &&
          failure.phase === "operation" &&
          failure.cause === outcome.error
        ) {
          continue;
        }
        failures.push(failure);
      }
    } else {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Test body or owned resources failed", {
      cause: failures[0],
    });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
