import type * as vscode from "vscode";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

// Observe new public registrations and delay only successful source reads made
// by their actual formatter callback. Background admission is never held.
export function gateFormatterSource(
  uri: vscode.Uri,
  sourceIdentity: string,
  api: Pick<typeof vscode, "languages" | "Disposable">,
) {
  const require = createRequire(__filename);
  const filesystem =
    require("node:fs/promises") as typeof import("node:fs/promises");
  const originalRealpath = filesystem.realpath;
  const realpathDescriptor = Object.getOwnPropertyDescriptor(
    filesystem,
    "realpath",
  )!;
  const originalRegister = api.languages.registerDocumentFormattingEditProvider;
  const registerDescriptor = Object.getOwnPropertyDescriptor(
    api.languages,
    "registerDocumentFormattingEditProvider",
  )!;
  const owner = new AsyncLocalStorage<vscode.TextDocument>();
  const registrations: {
    selector: vscode.DocumentSelector;
    active: boolean;
  }[] = [];
  const reads: Promise<unknown>[] = [];
  const callbacks: Promise<unknown>[] = [];
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
  Object.defineProperty(filesystem, "realpath", {
    ...realpathDescriptor,
    value: async (...args: Parameters<typeof originalRealpath>) => {
      const document = owner.getStore();
      const resolved = await originalRealpath(...args);
      if (resolved !== sourceIdentity) return resolved;
      if (!document || document.uri.toString() !== uri.toString()) {
        automaticEntries++;
        return resolved;
      }
      formatterEntries++;
      enter();
      const read = gate.then(() => resolved);
      reads.push(read);
      return read;
    },
  });
  Object.defineProperty(
    api.languages,
    "registerDocumentFormattingEditProvider",
    {
      ...registerDescriptor,
      value: (
        selector: vscode.DocumentSelector,
        provider: vscode.DocumentFormattingEditProvider,
      ) => {
        const registration = { selector, active: true };
        const disposable = originalRegister.call(api.languages, selector, {
          ...provider,
          provideDocumentFormattingEdits(document, options, token) {
            if (!active || document.uri.toString() !== uri.toString())
              return provider.provideDocumentFormattingEdits(
                document,
                options,
                token,
              );
            invocations++;
            const result = owner.run(document, () =>
              Promise.resolve(
                provider.provideDocumentFormattingEdits(
                  document,
                  options,
                  token,
                ),
              ),
            );
            callbacks.push(result);
            return result;
          },
        });
        registrations.push(registration);
        return new api.Disposable(() => {
          registration.active = false;
          disposable.dispose();
        });
      },
    },
  );
  return {
    entered,
    release,
    registered: (document: vscode.TextDocument) =>
      registrations.some(
        (registration) =>
          registration.active &&
          api.languages.match(registration.selector, document) > 0,
      ),
    counts: () => ({ automaticEntries, formatterEntries, invocations }),
    async dispose() {
      active = false;
      release();
      Object.defineProperty(filesystem, "realpath", realpathDescriptor);
      Object.defineProperty(
        api.languages,
        "registerDocumentFormattingEditProvider",
        registerDescriptor,
      );
      await Promise.allSettled([...reads, ...callbacks]);
      owner.disable();
    },
  };
}
