import type * as vscode from "vscode";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";

/** Gate only this component provider's successful read, never a shared API. */
export function gateFormatterSource(
  uri: vscode.Uri,
  sourceIdentity: string,
  signal?: AbortSignal,
) {
  const owner = new AsyncLocalStorage<vscode.TextDocument>();
  const callbacks = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let automaticEntries = 0;
  let formatterEntries = 0;
  let invocations = 0;
  let active = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const cancel = () => {
    active = false;
    release();
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const readSource = (async (...args: Parameters<typeof readFile>) => {
    const bytes = await readFile(...args);
    if (!active || String(args[0]) !== sourceIdentity) return bytes;
    const document = owner.getStore();
    if (!document || document.uri.toString() !== uri.toString()) {
      automaticEntries++;
      return bytes;
    }
    formatterEntries++;
    enter();
    await gate;
    return bytes;
  }) as typeof readFile;
  return {
    entered,
    release,
    readFile: readSource,
    invoke<T>(
      document: vscode.TextDocument,
      perform: () => PromiseLike<T>,
    ): Promise<T> {
      if (!active) return Promise.resolve(perform());
      invocations++;
      const result = Promise.resolve().then(() => owner.run(document, perform));
      const settled = result.then(
        () => {
          callbacks.delete(settled);
        },
        (error: unknown) => {
          failures.push(error);
          callbacks.delete(settled);
        },
      );
      callbacks.add(settled);
      return result;
    },
    counts: () => ({ automaticEntries, formatterEntries, invocations }),
    async dispose() {
      cancel();
      signal?.removeEventListener("abort", cancel);
      await Promise.all([...callbacks]);
      owner.disable();
      if (failures.length)
        throw new AggregateError(
          failures.splice(0),
          "Formatter callbacks failed",
        );
    },
  };
}
