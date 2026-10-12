export interface TabCleanupChange<Tab> {
  closed: readonly Tab[];
}

/** Public editor operations supplied by one isolated host. */
export interface TabCleanupAdapter<Tab, Document> {
  tabs(): readonly Tab[];
  key(tab: Tab): string;
  dirtyDocuments(tab: Tab): readonly Document[];
  activeDocumentTab(document: Document): Tab | undefined;
  onChange(listener: (event: TabCleanupChange<Tab>) => void): {
    dispose(): void;
  };
  showDocument(document: Document, tab: Tab): PromiseLike<unknown>;
  discardActive(): PromiseLike<unknown>;
  closeClean(tab: Tab): PromiseLike<boolean>;
}

type Observation<Value> =
  { observed: true; value: Value } | { observed: false; reason: unknown };

function observe<Tab, Value>(
  adapter: Pick<TabCleanupAdapter<Tab, unknown>, "onChange">,
  inspect: (event: TabCleanupChange<Tab> | undefined) => Value | undefined,
  signal: AbortSignal | undefined,
) {
  let settle!: (result: Observation<Value>) => void;
  const pending = new Promise<Observation<Value>>((resolve) => {
    settle = resolve;
  });
  const check = (event?: TabCleanupChange<Tab>) => {
    try {
      const value = inspect(event);
      if (value !== undefined) settle({ observed: true, value });
    } catch (reason) {
      settle({ observed: false, reason });
    }
  };
  const subscription = adapter.onChange(check);
  const abort = () =>
    settle({
      observed: false,
      reason: signal?.reason ?? new Error("Tab cleanup canceled"),
    });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    check,
    async wait(): Promise<{ value: Value }> {
      const result = await pending;
      if (!result.observed) throw result.reason;
      return { value: result.value };
    },
    dispose() {
      subscription.dispose();
      signal?.removeEventListener("abort", abort);
      settle({
        observed: false,
        reason: new Error("Tab observation disposed"),
      });
    },
  };
}

/** Close fresh public tab objects and join each exact closure before advancing. */
export async function closeTabs<Tab extends object, Document>(
  adapter: TabCleanupAdapter<Tab, Document>,
  signal?: AbortSignal,
): Promise<void> {
  while (true) {
    if (signal?.aborted) throw signal.reason;
    const tab = adapter.tabs()[0];
    if (tab === undefined) return;
    const dirty = adapter.dirtyDocuments(tab)[0];
    let target = tab;
    if (dirty !== undefined) {
      // Showing a dirty diff resource can open a separate text tab. Resolve
      // its current public tab only after activation, rather than reusing the
      // original diff or a saved group snapshot.
      let shown = false;
      const active = observe<Tab, Tab>(
        adapter,
        () => (shown ? adapter.activeDocumentTab(dirty) : undefined),
        signal,
      );
      try {
        if (signal?.aborted) throw signal.reason;
        await adapter.showDocument(dirty, tab);
        shown = true;
        active.check();
        target = (await active.wait()).value;
      } finally {
        active.dispose();
      }
    }
    const key = adapter.key(target);
    const closed = observe<Tab, true>(
      adapter,
      (event) =>
        event?.closed.includes(target) ||
        !adapter.tabs().some((current) => adapter.key(current) === key)
          ? true
          : undefined,
      signal,
    );
    try {
      if (signal?.aborted) throw signal.reason;
      if (dirty !== undefined) await adapter.discardActive();
      else if (!(await adapter.closeClean(target)))
        throw new Error("Owned tab close was refused");
      closed.check();
      await closed.wait();
    } finally {
      closed.dispose();
    }
  }
}
