interface Request {
  key: string;
  priority: number;
  abort: AbortController;
  run: (signal: AbortSignal) => Promise<unknown>;
  finish: (value: unknown) => void;
  fail: (reason: unknown) => void;
  detach: () => void;
}
/** A single lane: latest key wins, canceled work is joined. */
export class Scheduler {
  private readonly pending = new Map<string, Request>();
  private active?: Request;
  private stopped = false;
  private readonly limit: number;
  constructor(limit: number | "retain" = 32) {
    this.limit = limit === "retain" ? Infinity : limit;
  }
  submit<T>(
    key: string,
    priority: number,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    this.cancel(key);
    if (this.stopped || signal?.aborted) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve, reject) => {
      const abort = new AbortController();
      const cancel = () => {
        if (this.active === request) request.abort.abort();
        if (this.pending.get(key) === request) this.cancel(key);
      };
      const request: Request = {
        key,
        priority,
        abort,
        run: operation,
        finish: (value) => resolve(value as T | undefined),
        fail: reject,
        detach: () => signal?.removeEventListener("abort", cancel),
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (this.pending.size >= this.limit) {
        const lowest = [...this.pending.values()].sort(
          (a, b) => a.priority - b.priority,
        )[0];
        if (lowest.priority > priority) {
          request.detach();
          resolve(undefined);
          return;
        }
        this.cancel(lowest.key);
      }
      this.pending.set(key, request);
      this.pump();
    });
  }
  cancel(key: string): void {
    if (this.active?.key === key) this.active.abort.abort();
    const queued = this.pending.get(key);
    if (queued) {
      this.pending.delete(key);
      queued.detach();
      queued.abort.abort();
      queued.finish(undefined);
    }
  }
  private pump(): void {
    if (this.active || this.stopped) return;
    const request = [...this.pending.values()].sort(
      (a, b) => b.priority - a.priority,
    )[0];
    if (!request) return;
    this.pending.delete(request.key);
    this.active = request;
    void this.execute(request);
  }
  private async execute(request: Request): Promise<void> {
    try {
      const value = await request.run(request.abort.signal);
      request.finish(request.abort.signal.aborted ? undefined : value);
    } catch (error) {
      if (request.abort.signal.aborted) request.finish(undefined);
      else request.fail(error);
    } finally {
      request.detach();
      this.active = undefined;
      this.pump();
    }
  }
  cancelAll(): void {
    this.active?.abort.abort();
    for (const key of this.pending.keys()) this.cancel(key);
  }
  dispose(): void {
    this.stopped = true;
    this.cancelAll();
  }
}
