type Outcome = { ok: true } | { ok: false; error: unknown };

function scheduleDeadline(expire: () => void) {
  const timer = setTimeout(expire, 15000);
  return () => clearTimeout(timer);
}

/** Observe before triggering, then join the operation even if readiness fails. */
export async function diagnosticTransition(options: {
  signal: AbortSignal;
  subscribe: (observe: () => void) => { dispose(): void };
  ready: () => boolean;
  trigger: () => PromiseLike<unknown>;
  scheduleDeadline?: typeof scheduleDeadline;
}): Promise<void> {
  const { signal } = options;
  signal.throwIfAborted();
  let finish!: (outcome: Outcome) => void;
  const ready = new Promise<Outcome>((resolve) => {
    finish = resolve;
  });
  const failures: unknown[] = [];
  let listener: { dispose(): void } | undefined;
  let stopDeadline: (() => void) | undefined;
  const cancel = () => {
    failures.push(signal.reason);
    finish({ ok: false, error: signal.reason });
  };
  const observe = () => {
    try {
      if (options.ready()) finish({ ok: true });
    } catch (error) {
      failures.push(error);
      finish({ ok: false, error });
    }
  };
  try {
    listener = options.subscribe(observe);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) signal.throwIfAborted();
    stopDeadline = (options.scheduleDeadline ?? scheduleDeadline)(() =>
      finish({
        ok: false,
        error: new Error("configuration diagnostics did not refresh"),
      }),
    );
    const operation = Promise.resolve()
      .then(options.trigger)
      .then(
        (): Outcome => {
          observe();
          return { ok: true };
        },
        (error: unknown): Outcome => {
          finish({ ok: false, error });
          return { ok: false, error };
        },
      );
    for (const outcome of await Promise.all([operation, ready]))
      if (!outcome.ok) failures.push(outcome.error);
  } catch (error) {
    failures.push(error);
  } finally {
    signal.removeEventListener("abort", cancel);
    for (const dispose of [stopDeadline, () => listener?.dispose()]) {
      try {
        dispose?.();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(
      [...new Set(failures)],
      "configuration diagnostic transition failed",
    );
}
