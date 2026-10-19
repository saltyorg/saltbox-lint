export interface InitialCodeActionOptions<T> {
  signal: AbortSignal;
  read(): Promise<T | undefined>;
  guard(): void;
  isCancellation(error: unknown): boolean;
  timeoutMs?: number;
  clock?: () => number;
}

/** Acquire a fixture precondition; never use this after the tested mutation. */
export async function initialCodeAction<T>(
  options: InitialCodeActionOptions<T>,
) {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError(
      "A positive finite initial action timeout is required",
    );
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  let queries = 0;
  let cancellations = 0;
  let firstCancellation: unknown;
  // Each observation is an awaited SDK request. No lint rechecks, source edits,
  // sleeps or detached requests are admitted while establishing this state.
  while (clock() - started < timeoutMs) {
    options.signal.throwIfAborted();
    options.guard();
    let value: T | undefined;
    queries++;
    try {
      value = await options.read();
    } catch (error) {
      options.signal.throwIfAborted();
      let cancelled: boolean;
      try {
        cancelled = options.isCancellation(error);
      } catch (classification) {
        throw new AggregateError(
          [error, classification],
          "Initial action request and cancellation classification failed",
          { cause: error },
        );
      }
      if (!cancelled) throw error;
      if (cancellations++ === 0) firstCancellation = error;
    }
    // An aborted owner still joins its admitted SDK request before rejection.
    options.signal.throwIfAborted();
    options.guard();
    const elapsedMs = clock() - started;
    if (elapsedMs >= timeoutMs) break;
    if (value !== undefined)
      return { value, queries, cancellations, elapsedMs };
  }
  throw new Error(
    `Initial SDK code action unavailable after ${timeoutMs}ms, ${queries} queries and ${cancellations} cancellations`,
    { cause: firstCancellation },
  );
}
