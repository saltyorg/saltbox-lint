import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { lstat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { resolve } from "node:path";
import type * as vscode from "vscode";
import type { EditorAdapters } from "../../src/editor.ts";
import { disposeResources } from "../../src/disposables.ts";

const bundled = await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface Entry {
  activate(
    context: Pick<vscode.ExtensionContext, "asAbsolutePath" | "subscriptions">,
    adapters?: Partial<EditorAdapters>,
  ): void;
  deactivate(): Promise<void>;
}

/** Load the complete standard entry and real editor with one private host API. */
function fixture(
  options: { disposalFailure?: Error; setupFailure?: Error } = {},
) {
  const acquisitions: { name: string; disposed: boolean }[] = [];
  let outputCount = 0;
  let watcherCount = 0;
  let releaseObserver: (() => void) | undefined;
  const acquired = (name: string, failure?: Error) => {
    const resource = { name, disposed: false };
    acquisitions.push(resource);
    return {
      dispose() {
        if (resource.disposed) return;
        resource.disposed = true;
        if (name === "output:1") releaseObserver?.();
        if (failure) throw failure;
      },
    };
  };
  class Disposable {
    private readonly release: () => void;
    constructor(release: () => void) {
      this.release = release;
    }
    dispose() {
      this.release();
    }
  }
  class EventEmitter {
    private readonly resource = acquired("emitter");
    private readonly listeners = new Set<(value: unknown) => unknown>();
    readonly event = (listener: (value: unknown) => unknown) => {
      const resource = acquired("event listener");
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
          resource.dispose();
        },
      };
    };
    fire(value: unknown) {
      for (const listener of this.listeners) listener(value);
    }
    dispose() {
      this.listeners.clear();
      this.resource.dispose();
    }
  }
  class Uri {
    readonly scheme = "file";
    readonly fsPath: string;
    constructor(fsPath: string) {
      this.fsPath = fsPath;
    }
    toString() {
      return `file://${this.fsPath}`;
    }
    static file(filename: string) {
      return new Uri(filename);
    }
  }
  const listen = () => acquired("host listener");
  const api = {
    Uri,
    EventEmitter,
    Disposable,
    RelativePattern: class {},
    StatusBarAlignment: { Left: 1 },
    workspace: {
      isTrusted: true,
      workspaceFolders: [] as { uri: Uri }[],
      textDocuments: [],
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      getWorkspaceFolder: () => undefined,
      registerTextDocumentContentProvider: () => acquired("content provider"),
      onDidChangeConfiguration: listen,
      onDidOpenTextDocument: listen,
      onDidSaveTextDocument: listen,
      onDidChangeTextDocument: listen,
      onDidCloseTextDocument: listen,
      onDidRenameFiles: listen,
      onDidChangeWorkspaceFolders: listen,
      createFileSystemWatcher: () => {
        watcherCount++;
        if (watcherCount === 2 && options.setupFailure)
          throw options.setupFailure;
        return {
          ...acquired("watcher"),
          onDidCreate: listen,
          onDidChange: listen,
          onDidDelete: listen,
        };
      },
    },
    window: {
      tabGroups: { all: [], onDidChangeTabs: listen },
      onDidChangeActiveTextEditor: listen,
      createStatusBarItem: () => ({
        ...acquired("status"),
        text: "",
        command: "",
        show() {},
        hide() {},
      }),
      createOutputChannel: () => ({
        ...acquired(
          `output:${++outputCount}`,
          outputCount === 1 ? options.disposalFailure : undefined,
        ),
        appendLine() {},
      }),
    },
    languages: {
      createDiagnosticCollection: () => ({
        ...acquired("diagnostics"),
        clear() {},
        forEach() {},
      }),
      registerHoverProvider: () => acquired("hover provider"),
    },
    commands: { registerCommand: () => acquired("command") },
  };
  const module = { exports: {} as Entry };
  const nativeRequire = createRequire(import.meta.url);
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) => (name === "vscode" ? api : nativeRequire(name)),
    process,
    Buffer,
    AbortController,
    Error,
    AggregateError,
    setTimeout,
    clearTimeout,
  });
  const contexts: Pick<
    vscode.ExtensionContext,
    "asAbsolutePath" | "subscriptions"
  >[] = [];
  const operations: Promise<void>[] = [];
  const gates: ReturnType<typeof deferred<never>>[] = [];
  const activate = (adapters?: Partial<EditorAdapters>) => {
    const context = {
      subscriptions: [] as vscode.Disposable[],
      asAbsolutePath: (filename: string) => resolve(filename),
    };
    contexts.push(context);
    // Include the unmodified one-argument SDK caller in the default path.
    if (adapters) module.exports.activate(context, adapters);
    else module.exports.activate(context);
  };
  const deactivate = () => {
    const operation = module.exports.deactivate();
    operations.push(operation);
    operation.catch(() => undefined);
    return operation;
  };
  return {
    activate,
    deactivate,
    releaseObserver(value: () => void) {
      releaseObserver = value;
    },
    disposedOutputs: () =>
      acquisitions.filter(
        (item) => item.name.startsWith("output:") && item.disposed,
      ).length,
    markerGate() {
      const entered = deferred<void>();
      const marker = deferred<never>();
      gates.push(marker);
      api.workspace.workspaceFolders = [
        { uri: Uri.file(resolve("first-project")) },
        ...(options.setupFailure
          ? [{ uri: Uri.file(resolve("second-project")) }]
          : []),
      ];
      return {
        entered: entered.promise,
        release: () => marker.reject(new Error("No opt-in marker")),
        adapters: {
          roots: {
            lstat: (() => {
              entered.resolve();
              return marker.promise;
            }) as typeof lstat,
          },
        },
      };
    },
    async close() {
      for (const gate of gates) gate.reject(new Error("Fixture released"));
      await Promise.allSettled([...operations, deactivate()]);
      for (const context of contexts) disposeResources(context.subscriptions);
      assert.ok(
        acquisitions.every((item) => item.disposed),
        "every acquired host resource must be released",
      );
    },
  };
}

test("standard activation deactivates once and empty or repeated deactivation is harmless", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  await f.deactivate();
  f.activate();
  const first = f.deactivate();
  assert.equal(f.deactivate(), first);
  await first;
  await f.deactivate();
  assert.equal(f.disposedOutputs(), 1);
});

test("disposal failure still joins an admitted marker probe and duplicate calls share cleanup", async (t) => {
  const failure = new Error("output disposal failed");
  const f = fixture({ disposalFailure: failure });
  t.after(() => f.close());
  const gate = f.markerGate();
  f.activate(gate.adapters);
  await gate.entered;
  const first = f.deactivate();
  const observed = assert.rejects(first, (error: unknown) => error === failure);
  assert.equal(f.deactivate(), first);
  let settled = false;
  const settlement = observed.then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(f.disposedOutputs(), 1);
  assert.equal(
    settled,
    false,
    "dispose failure cannot substitute for probe joining",
  );
  gate.release();
  await settlement;
  await f.deactivate();
  assert.equal(f.disposedOutputs(), 1);
});

for (const disposalFailed of [false, true]) {
  test(`deactivation joins failed setup and preserves ${disposalFailed ? "both failures" : "the join failure"}`, async (t) => {
    const disposalFailure = new Error("output disposal failed");
    const setupFailure = new Error("second watcher setup failed");
    const f = fixture({
      setupFailure,
      disposalFailure: disposalFailed ? disposalFailure : undefined,
    });
    t.after(() => f.close());
    const gate = f.markerGate();
    f.activate(gate.adapters);
    await gate.entered;
    let settled = false;
    const pending = assert
      .rejects(f.deactivate(), (error: unknown) => {
        if (!disposalFailed) return error === setupFailure;
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, disposalFailure);
        assert.deepEqual(error.errors, [disposalFailure, setupFailure]);
        return true;
      })
      .then(() => {
        settled = true;
      });
    await setImmediate();
    assert.equal(
      settled,
      false,
      "failed setup must still join its earlier probe",
    );
    gate.release();
    await pending;
  });
}

test("reentrant disposal sees the already admitted deactivation owner", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  let reentrant: Promise<void> | undefined;
  f.releaseObserver(() => {
    reentrant = f.deactivate();
  });
  f.activate();
  const first = f.deactivate();
  await first;
  assert.equal(reentrant, first);
  assert.equal(f.disposedOutputs(), 1);
});

test("completed old deactivation cannot clear a subsequently activated owner", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const gate = f.markerGate();
  f.activate(gate.adapters);
  await gate.entered;
  const first = f.deactivate();
  // The first owner's probe remains admitted while the next owner activates.
  f.activate();
  gate.release();
  await first;
  assert.equal(f.disposedOutputs(), 1);
  const second = f.deactivate();
  assert.notEqual(second, first);
  await second;
  assert.equal(f.disposedOutputs(), 2);
});
