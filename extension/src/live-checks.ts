export const typingDebounceMs = 300;
export const typingDocumentLimit = 32;

interface Entry {
  timer?: ReturnType<typeof setTimeout>;
  active?: AbortController;
  work?: Promise<void>;
  ready: boolean;
  cancelled: boolean;
}

/** Bounds timers and queued/running requests by the actual document object. */
export class LiveChecks<Document extends object> {
  private readonly entries = new Map<Document, Entry>();
  private stopped = false;
  private readonly run: (
    document: Document,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly failed: (error: unknown) => void;
  constructor(
    run: (document: Document, signal: AbortSignal) => Promise<void>,
    failed: (error: unknown) => void,
  ) {
    this.run = run;
    this.failed = failed;
  }

  schedule(document: Document): void {
    if (this.stopped) return;
    let entry = this.entries.get(document);
    if (!entry) {
      if (this.entries.size >= typingDocumentLimit) {
        // A running slot remains charged until cancellation has joined. Only
        // a waiting timer can be replaced when the document limit is reached.
        const oldest = [...this.entries].find(([, value]) => !value.active);
        if (!oldest) return;
        this.cancel(oldest[0]);
      }
      entry = { ready: false, cancelled: false };
      this.entries.set(document, entry);
    }
    entry.cancelled = false;
    entry.ready = false;
    entry.active?.abort();
    if (entry.timer) clearTimeout(entry.timer);
    const owned = entry;
    entry.timer = setTimeout(() => {
      owned.timer = undefined;
      owned.ready = true;
      this.start(document, owned);
    }, typingDebounceMs);
  }

  private start(document: Document, entry: Entry): void {
    if (this.stopped || entry.cancelled || entry.active || !entry.ready) return;
    entry.ready = false;
    const abort = new AbortController();
    entry.active = abort;
    // The controller owns the complete editor operation, including publication.
    // A superseding timer can become ready while this operation joins.
    entry.work = this.run(document, abort.signal)
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        entry.active = undefined;
        if (entry.ready && !entry.cancelled && !this.stopped)
          this.start(document, entry);
        else if (!entry.timer) this.entries.delete(document);
      });
  }

  cancel(document: Document): void {
    const entry = this.entries.get(document);
    if (!entry) return;
    entry.cancelled = true;
    entry.ready = false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.active?.abort();
    if (!entry.active) this.entries.delete(document);
  }

  cancelWhere(predicate: (document: Document) => boolean): void {
    for (const document of this.entries.keys())
      if (predicate(document)) this.cancel(document);
  }

  dispose(): void {
    this.stopped = true;
    this.cancelWhere(() => true);
  }

  async join(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].flatMap((entry) =>
        entry.work ? [entry.work] : [],
      ),
    );
  }
}
