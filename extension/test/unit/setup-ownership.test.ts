import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import type { EditorIntegration } from "../../src/editor.ts";
import type { RuleHelp } from "../../src/help.ts";
import type { MarkedRoots } from "../../src/roots.ts";
import type { ProcessRequest } from "../../src/process.ts";
import type {
  ProviderRegistration,
  updateProviders,
} from "../../src/providers.ts";
import {
  deferred,
  withNavigationFixture,
} from "../support/navigation-fixture.ts";

const bundled = await build({
  stdin: {
    contents:
      'export { EditorIntegration } from "./src/editor.ts"; export { RuleHelp } from "./src/help.ts"; export { MarkedRoots } from "./src/roots.ts"; export { updateProviders } from "./src/providers.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

function fixture(
  fail?: string,
  disposalFailures: ReadonlyMap<string, Error> = new Map(),
) {
  const primary = new Error(`failed acquiring ${fail}`);
  const acquired: string[] = [];
  const released: string[] = [];
  const attempts: string[] = [];
  const names = new Map<string, number>();
  let nextFailure = fail;
  function acquire(kind: string) {
    const count = (names.get(kind) ?? 0) + 1;
    names.set(kind, count);
    const name = `${kind}:${count}`;
    attempts.push(name);
    if (name === nextFailure) throw primary;
    acquired.push(name);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        released.push(name);
        const failure = disposalFailures.get(name);
        if (failure) throw failure;
      },
    };
  }
  class EventEmitter {
    private readonly resource = acquire("emitter");
    private readonly listeners = new Set<(value: unknown) => void>();
    readonly event = (listener: (value: unknown) => void) => {
      const resource = acquire("event listener");
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
  const api = {
    Uri,
    EventEmitter,
    Disposable: {
      from: (...items: { dispose(): void }[]) => ({
        dispose: () => items.forEach((item) => item.dispose()),
      }),
    },
    RelativePattern: class {
      readonly baseUri: Uri;
      readonly pattern: string;
      constructor(baseUri: Uri, pattern: string) {
        this.baseUri = baseUri;
        this.pattern = pattern;
      }
    },
    StatusBarAlignment: { Left: 1 },
    CodeActionKind: { QuickFix: {}, SourceFixAll: { append: () => ({}) } },
    workspace: {
      isTrusted: true,
      workspaceFolders: [] as { uri: Uri }[],
      textDocuments: [] as vscode.TextDocument[],
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      getWorkspaceFolder: () => undefined,
      registerTextDocumentContentProvider: () => acquire("content provider"),
      onDidChangeConfiguration: () => acquire("configuration listener"),
      createFileSystemWatcher: () => ({
        ...acquire("watcher"),
        onDidCreate: () => acquire("create listener"),
        onDidChange: () => acquire("change listener"),
        onDidDelete: () => acquire("delete listener"),
      }),
    },
    window: {
      tabGroups: { all: [] },
      onDidChangeActiveTextEditor: () => acquire("active listener"),
      createStatusBarItem: () => ({
        ...acquire("status"),
        text: "",
        command: "",
        show() {},
        hide() {},
      }),
      createOutputChannel: () => ({
        ...acquire("output"),
        appendLine() {},
        show() {},
      }),
      showErrorMessage: async () => undefined,
    },
    languages: {
      createDiagnosticCollection: () => ({
        ...acquire("diagnostics"),
        clear() {},
        forEach() {},
      }),
      registerHoverProvider: () => acquire("hover provider"),
      registerCodeActionsProvider: () => acquire("actions provider"),
      registerDefinitionProvider: () => acquire("definition provider"),
      registerReferenceProvider: () => acquire("references provider"),
      registerCompletionItemProvider: () => acquire("completion provider"),
      registerDocumentFormattingEditProvider: () => acquire("formatter"),
    },
  };
  const module = {
    exports: {} as {
      EditorIntegration: typeof EditorIntegration;
      RuleHelp: typeof RuleHelp;
      MarkedRoots: typeof MarkedRoots;
      updateProviders: typeof updateProviders;
    },
  };
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
  return {
    ...module.exports,
    api,
    acquired,
    released,
    attempts,
    primary,
    failNext(name: string) {
      nextFailure = name;
    },
  };
}

test("editor constructor releases every acquisition when output creation throws", () => {
  const f = fixture("output:1");
  assert.throws(() => new f.EditorIntegration("fixture-cli"), f.primary);
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});

test("help constructor releases its content provider and emitter after hover setup fails", () => {
  const f = fixture("hover provider:1");
  assert.throws(() => new f.RuleHelp("fixture-cli"), f.primary);
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});

test("failed per-document formatter registration rolls back earlier providers and preserves existing documents", () => {
  const f = fixture("formatter:1");
  const oldUri = f.api.Uri.file("/existing/tasks/main.yml") as vscode.Uri;
  const nextUri = f.api.Uri.file("/next/tasks/main.yml") as vscode.Uri;
  const documents = [oldUri, nextUri].map((uri) => ({
    uri,
    languageId: "yaml",
  })) as vscode.TextDocument[];
  let oldDisposed = false;
  const existing = {
    language: "yaml",
    writable: true,
    disposable: {
      dispose() {
        oldDisposed = true;
      },
    },
  };
  const registrations = new Map<string, ProviderRegistration>([
    [oldUri.toString(), existing],
  ]);
  const editor = {
    providerDocuments: () => documents,
    writable: () => true,
    actions: () => [],
    navigation: {} as EditorIntegration["navigation"],
    format: async () => [],
  };
  assert.throws(() => f.updateProviders(editor, registrations), f.primary);
  assert.equal(registrations.get(oldUri.toString()), existing);
  assert.equal(oldDisposed, false);
  assert.equal(registrations.has(nextUri.toString()), false);
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});

test("constructor rollback retains its primary failure and every disposal failure", () => {
  const statusFailure = new Error("status disposal denied");
  const diagnosticFailure = new Error("diagnostic disposal denied");
  const f = fixture(
    "output:1",
    new Map([
      ["status:1", statusFailure],
      ["diagnostics:1", diagnosticFailure],
    ]),
  );
  assert.throws(
    () => new f.EditorIntegration("fixture-cli"),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, f.primary);
      assert.deepEqual(error.errors, [
        f.primary,
        statusFailure,
        diagnosticFailure,
      ]);
      return true;
    },
  );
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});

test("every constructor acquisition either transfers to the returned owner or rolls back", async (context) => {
  const baseline = fixture();
  const owner = new baseline.EditorIntegration("fixture-cli");
  await owner.ready();
  owner.dispose();
  await owner.join();
  assert.deepEqual(
    [...baseline.released].sort(),
    [...baseline.acquired].sort(),
  );
  for (const acquisition of baseline.acquired) {
    await context.test(acquisition, () => {
      const f = fixture(acquisition);
      assert.throws(() => new f.EditorIntegration("fixture-cli"), f.primary);
      assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
    });
  }
});

test("disposing before initialization admits no watcher or marker probe", async () => {
  const f = fixture();
  f.api.workspace.workspaceFolders = [{ uri: f.api.Uri.file("/project") }];
  let probes = 0;
  const owner = new f.EditorIntegration("fixture-cli", {
    roots: {
      lstat: ((...args: Parameters<typeof lstat>) => {
        probes++;
        return lstat(...args);
      }) as typeof lstat,
    },
  });
  owner.dispose();
  await owner.join();
  assert.equal(probes, 0);
  assert.equal(
    f.attempts.some((name) => name.startsWith("watcher:")),
    false,
  );
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});

test("a first status command awaits initial marker readiness", async () => {
  const f = fixture();
  f.api.workspace.workspaceFolders = [{ uri: f.api.Uri.file("/project") }];
  const entered = deferred<void>();
  const marker = deferred<never>();
  const owner = new f.EditorIntegration("fixture-cli", {
    roots: {
      lstat: (() => {
        entered.resolve();
        return marker.promise;
      }) as typeof lstat,
    },
  });
  let finished = false;
  const command = owner.showStatus().then((value) => {
    finished = true;
    return value;
  });
  try {
    await entered.promise;
    assert.equal(finished, false);
    marker.reject(new Error("No opt-in marker"));
    assert.equal((await command).state, "disabled");
  } finally {
    marker.reject(new Error("fixture released"));
    owner.dispose();
    await Promise.allSettled([command, owner.join()]);
  }
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});

test("configuration failure keeps a returned owner and joins a previously admitted marker probe", async () => {
  const f = fixture("watcher:2");
  f.api.workspace.workspaceFolders = [
    { uri: f.api.Uri.file("/first") },
    { uri: f.api.Uri.file("/second") },
  ];
  const entered = deferred<void>();
  const marker = deferred<never>();
  const owner = new f.EditorIntegration("fixture-cli", {
    roots: {
      lstat: (() => {
        entered.resolve();
        return marker.promise;
      }) as typeof lstat,
    },
  });
  assert.equal(
    f.attempts.some((name) => name.startsWith("watcher:")),
    false,
  );
  let joined = false;
  try {
    await entered.promise;
    await assert.rejects(owner.ready(), f.primary);
    owner.dispose();
    const cleanup = owner.join().finally(() => {
      joined = true;
    });
    const observedCleanup = assert.rejects(cleanup, f.primary);
    await Promise.resolve();
    assert.equal(joined, false, "probe settlement is required after dispose");
    marker.reject(new Error("fixture released"));
    await observedCleanup;
  } finally {
    marker.reject(new Error("fixture released"));
    owner.dispose();
    await Promise.allSettled([owner.join()]);
  }
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});

test("marker watcher subscription failures release each earlier acquisition", async (context) => {
  for (const failed of [
    "create listener:1",
    "delete listener:1",
    "change listener:1",
  ]) {
    await context.test(failed, async () => {
      const f = fixture(failed);
      f.api.workspace.workspaceFolders = [{ uri: f.api.Uri.file("/project") }];
      let probes = 0;
      const owner = new f.EditorIntegration("fixture-cli", {
        roots: {
          lstat: (() => {
            probes++;
            return Promise.reject(new Error("missing marker"));
          }) as typeof lstat,
        },
      });
      try {
        await assert.rejects(owner.ready(), f.primary);
        assert.equal(probes, 0, "a partial watcher cannot start a probe");
      } finally {
        owner.dispose();
        await assert.rejects(owner.join(), f.primary);
      }
      assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
    });
  }
});

test("provider rollback reports all cleanup failures while retaining the setup error", () => {
  const actionsFailure = new Error("action disposal failed");
  const completionFailure = new Error("completion disposal failed");
  const f = fixture(
    "formatter:1",
    new Map([
      ["actions provider:1", actionsFailure],
      ["completion provider:1", completionFailure],
    ]),
  );
  const uri = f.api.Uri.file("/project/tasks/main.yml") as vscode.Uri;
  const registrations = new Map<string, ProviderRegistration>();
  assert.throws(
    () =>
      f.updateProviders(
        {
          providerDocuments: () => [
            { uri, languageId: "yaml" } as vscode.TextDocument,
          ],
          writable: () => true,
          actions: () => [],
          navigation: {} as EditorIntegration["navigation"],
          format: async () => [],
        },
        registrations,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, f.primary);
      assert.deepEqual(error.errors, [
        f.primary,
        completionFailure,
        actionsFailure,
      ]);
      return true;
    },
  );
  assert.equal(registrations.size, 0);
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});

test("the first navigation request waits for initial configuration before capturing its generation", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let requests = 0;
  // The actual fixture wire is assigned before its first request is released.
  let wire: (request: ProcessRequest) => string;
  await withNavigationFixture(
    {
      roots: {
        lstat: (async (...args: Parameters<typeof lstat>) => {
          entered.resolve();
          await release.promise;
          return lstat(...args);
        }) as typeof lstat,
      },
      runProcess: async (request) => {
        requests++;
        return wire(request);
      },
    },
    async (f) => {
      wire = f.wire;
      f.resources.defer("initial marker gate", () => release.resolve());
      const token: vscode.CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      };
      const query = f.resources.operation("first navigation request", () =>
        f.editor.navigation.definition(
          f.document.asDocument(),
          f.position,
          token,
        ),
      );
      await entered.promise;
      assert.equal(requests, 0);
      release.resolve();
      assert.equal((await query).length, 1);
      assert.equal(requests, 1);
    },
    { waitForReady: false },
  );
});

test("a partial context watcher group is rolled back after real marker readiness", async (context) => {
  for (const failed of ["watcher:3", "change listener:3"]) {
    await context.test(failed, async () => {
      const directory = await mkdtemp(join(tmpdir(), "saltbox-root-setup-"));
      const f = fixture(failed);
      let owner: EditorIntegration | undefined;
      try {
        const root = await realpath(directory);
        await writeFile(join(root, ".saltbox-lint"), "");
        f.api.workspace.workspaceFolders = [{ uri: f.api.Uri.file(root) }];
        owner = new f.EditorIntegration("fixture-cli", {
          schedule: () => () => {},
        });
        await assert.rejects(owner.ready(), f.primary);
      } finally {
        owner?.dispose();
        if (owner) await owner.join();
        await rm(directory, { recursive: true, force: true });
      }
      assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
    });
  }
});

test("source watcher acquisition rolls back an earlier alias watcher without discarding root ownership", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "saltbox-source-watch-setup-"),
  );
  const f = fixture();
  const owner = new f.MarkedRoots(() => {});
  try {
    const root = await realpath(directory);
    await writeFile(join(root, ".saltbox-lint"), "");
    f.api.workspace.workspaceFolders = [{ uri: f.api.Uri.file(root) }];
    owner.configure();
    await owner.ready();
    const before = new Set(f.acquired);
    // Marker plus five context watchers are already owned. The alias watcher
    // succeeds, then its distinct canonical filename watcher fails.
    f.failNext("watcher:8");
    assert.throws(
      () =>
        owner.watchSource(
          f.api.Uri.file(join(root, "alias/main.yml")) as vscode.Uri,
          {
            root,
            path: "roles/source/tasks/main.yml",
            filename: join(root, "roles/source/tasks/main.yml"),
          },
        ),
      f.primary,
    );
    const partial = f.acquired.filter((name) => !before.has(name));
    assert.deepEqual([...f.released].sort(), [...partial].reverse().sort());
    assert.equal(
      owner.get(f.api.workspace.workspaceFolders[0].uri.toString()),
      root,
    );
  } finally {
    owner.dispose();
    await owner.join();
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual([...f.released].sort(), [...f.acquired].sort());
});
