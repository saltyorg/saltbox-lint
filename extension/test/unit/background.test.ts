import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDependencies } from "../support/dependency-cleanup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

async function owner(entry: string, io: Record<string, unknown>) {
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "background-io",
        setup(builder) {
          builder.onResolve({ filter: /^vscode$/ }, ({ path }) => ({
            path,
            namespace: "background-io",
          }));
          builder.onLoad(
            { filter: /.*/, namespace: "background-io" },
            ({ path }) => ({
              contents: `module.exports = globalThis.io[${JSON.stringify(path)}]`,
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    console,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    io,
  });
  return module.exports as {
    EditorIntegration: {
      prototype: {
        open: (document: unknown) => void;
        checkBackground: (document: unknown) => void;
      };
    };
    MarkedRoots: typeof import("../../src/roots.ts").MarkedRoots;
  };
}

test("opening a document owns background rejection without delaying admission", async () => {
  const { EditorIntegration } = await owner("src/editor.ts", { vscode: {} });
  let reject!: (error: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  // Observe the same operation independently so the original source can be
  // tested red without letting an intentionally missing handler escape Node.
  const settled = held.catch(() => {});
  const failures: { error: unknown; manual: boolean }[] = [];
  let admitted = 0;
  const integration = Object.assign(
    Object.create(EditorIntegration.prototype),
    {
      closedTabs: new Set(["file:///document"]),
      eligibilityChanged: { fire() {} },
      check: () => {
        admitted++;
        return held;
      },
      error: (error: unknown, manual: boolean) =>
        failures.push({ error, manual }),
    },
  );
  const document = { uri: { toString: () => "file:///document" } };
  assert.equal(integration.open(document), undefined);
  assert.equal(admitted, 1);
  assert.equal(integration.closedTabs.size, 0);
  assert.deepEqual(failures, []);
  const original = new Error("readiness rejected");
  reject(original);
  await settled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [{ error: original, manual: false }]);
});

test("startup background check preserves check-only admission and reports rejection", async () => {
  const { EditorIntegration } = await owner("src/editor.ts", { vscode: {} });
  const original = new Error("initial check rejected");
  const checked: unknown[] = [];
  const reported: unknown[] = [];
  const integration = Object.assign(
    Object.create(EditorIntegration.prototype),
    {
      // No tab cache or eligibility emitter exists here. Startup checks must
      // preserve the original check-only entry rather than opening a tab.
      check: (document: unknown) => {
        checked.push(document);
        return Promise.reject(original);
      },
      error: (error: unknown, manual: boolean) => {
        assert.equal(manual, false);
        reported.push(error);
      },
    },
  );
  const document = { identity: "already-open-at-activation" };
  assert.equal(integration.checkBackground(document), undefined);
  assert.deepEqual(checked, [document]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(reported, [original]);
});

test("event probe reports failure while readiness retains the original rejection", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-root-readiness-"));
  test.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  await writeFile(join(root, ".saltbox-lint"), "");
  const original = new Error("canonical watcher registration failed");
  const disposable = { dispose() {} };
  const watcher = {
    ...disposable,
    onDidCreate: () => disposable,
    onDidChange: () => disposable,
    onDidDelete: () => disposable,
  };
  let registrations = 0;
  const io = {
    vscode: {
      EventEmitter: class {
        event = () => disposable;
        fire() {}
        dispose() {}
      },
      RelativePattern: class {},
      Disposable: { from: () => disposable },
      Uri: { file: (path: string) => ({ fsPath: path }) },
      workspace: {
        workspaceFolders: [
          {
            uri: { scheme: "file", fsPath: root, toString: () => "root" },
          },
        ],
        getConfiguration: () => ({ get: () => "" }),
        createFileSystemWatcher: () => {
          if (++registrations > 1) throw original;
          return watcher;
        },
      },
    },
  };
  const { MarkedRoots } = await owner("src/roots.ts", io);
  const reported: unknown[] = [];
  const roots = new MarkedRoots((error) => reported.push(error));
  try {
    roots.configure();
    await assert.rejects(roots.ready(), (error) => error === original);
    assert.deepEqual(reported, [original]);
    // Reporting did not replace root.ready with a resolved catch result.
    await assert.rejects(roots.ready(), (error) => error === original);
  } finally {
    roots.dispose();
  }
});

for (const replaceOwner of [false, true]) {
  test(`root readiness joins a replacement ${replaceOwner ? "owner" : "probe"} when older work is pending`, async (test) => {
    const directory = await mkdtemp(join(tmpdir(), "saltbox-root-overlap-"));
    test.after(() => rm(directory, { recursive: true, force: true }));
    const root = await realpath(directory);
    await writeFile(join(root, ".saltbox-lint"), "");
    const replacement = join(root, "replacement");
    await mkdir(replacement);
    await writeFile(join(replacement, ".saltbox-lint"), "");
    let configuredRoot = "";
    const gates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const entered = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const disposable = { dispose() {} };
    let changed = () => {};
    let watched = false;
    let held = false;
    let reads = 0;
    const { MarkedRoots } = await owner("src/roots.ts", {
      vscode: {
        EventEmitter: class {
          event = () => disposable;
          fire() {}
          dispose() {}
        },
        RelativePattern: class {},
        Disposable: { from: () => disposable },
        Uri: { file: (path: string) => ({ fsPath: path }) },
        workspace: {
          workspaceFolders: [
            { uri: { scheme: "file", fsPath: root, toString: () => "root" } },
          ],
          getConfiguration: () => ({ get: () => configuredRoot }),
          createFileSystemWatcher: () => {
            const marker = !watched;
            watched = true;
            return {
              ...disposable,
              onDidCreate: () => disposable,
              onDidChange: () => disposable,
              onDidDelete: (listener: () => void) => {
                if (marker) changed = listener;
                return disposable;
              },
            };
          },
        },
      },
    });
    const roots = new MarkedRoots(undefined, {
      lstat: (async (...args: Parameters<typeof lstat>) => {
        const stat = await lstat(...args);
        if (held) {
          const index = reads++;
          assert.ok(index < gates.length, "only the two controlled probes run");
          entered[index].resolve();
          await gates[index].promise;
        }
        return stat;
      }) as typeof lstat,
    });
    let pending: Promise<void> | undefined;
    let settled = false;
    try {
      roots.configure();
      await roots.ready();
      assert.equal(roots.get("root"), root);
      held = true;
      changed();
      await entered[0].promise;
      pending = roots.ready().then(() => {
        settled = true;
      });
      if (replaceOwner) {
        configuredRoot = "replacement";
        roots.configure();
      } else changed();
      await entered[1].promise;
      gates[0].resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(roots.get("root"), undefined);
      assert.equal(
        settled,
        false,
        "superseded probe completion cannot establish current root readiness",
      );
      gates[1].resolve();
      await pending;
      assert.equal(roots.get("root"), replaceOwner ? replacement : root);
    } finally {
      for (const gate of gates) gate.resolve();
      await pending;
      roots.dispose();
      await roots.join();
    }
  });
}

test("admission cleanup cancels its owner and joins the complete check before removing its gate", async () => {
  let release!: () => void;
  let drain!: () => void;
  let canceled!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    canceled = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const joined = new Promise<void>((resolve) => {
    drain = resolve;
  });
  let completed = false;
  let removed = false;
  const removedPaths: string[] = [];
  let disposed = false;
  let observerDisposed = false;
  let aliasRefreshDisposed = false;
  const operation = (async () => {
    await gate;
    await joined;
    completed = true;
  })();
  const result = cleanupDependencies({
    observers: [
      {
        dispose: () => {
          aliasRefreshDisposed = true;
        },
      },
      {
        dispose: () => {
          observerDisposed = true;
        },
      },
    ],
    owner: {
      dispose: () => {
        assert.equal(aliasRefreshDisposed, true);
        disposed = true;
        release();
        canceled();
      },
    },
    admission: Promise.allSettled([operation]),
    afterDisposal: async () => {},
    subscriptions: [],
    releaseAliases: async () => {
      assert.equal(completed, true);
      assert.equal(disposed, true);
      removedPaths.push("owned-alias-directory");
      removed = true;
    },
    restoreEnvironment() {},
    releaseFiles: async () => {
      assert.equal(completed, true);
      assert.equal(disposed, true);
      removedPaths.push("owned-gate-directory");
      removed = true;
    },
  });
  try {
    await cancellation;
    assert.equal(
      disposed,
      true,
      "cancellation must happen before waiting for the check",
    );
    await gate;
    assert.equal(
      completed,
      false,
      "canceled subprocess is not the complete editor operation",
    );
    assert.equal(removed, false);
  } finally {
    drain();
    await result;
    await operation;
  }
  assert.equal(completed, true);
  assert.equal(removed, true);
  assert.deepEqual(removedPaths, [
    "owned-alias-directory",
    "owned-gate-directory",
  ]);
  assert.equal(observerDisposed, true);
  assert.equal(aliasRefreshDisposed, true);
});

test("disposing before root readiness joins its original probe and seals later configuration", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-root-cancellation-"));
  test.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  await writeFile(join(root, ".saltbox-lint"), "");
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let probes = 0,
    watchers = 0;
  const disposable = { dispose() {} };
  const watcher = {
    ...disposable,
    onDidCreate: () => disposable,
    onDidChange: () => disposable,
    onDidDelete: () => disposable,
  };
  const { MarkedRoots } = await owner("src/roots.ts", {
    vscode: {
      EventEmitter: class {
        event = () => disposable;
        fire() {}
        dispose() {}
      },
      RelativePattern: class {},
      Disposable: { from: () => disposable },
      Uri: { file: (path: string) => ({ fsPath: path }) },
      workspace: {
        workspaceFolders: [
          { uri: { scheme: "file", fsPath: root, toString: () => "root" } },
        ],
        getConfiguration: () => ({ get: () => "" }),
        createFileSystemWatcher: () => {
          watchers++;
          return watcher;
        },
      },
    },
  });
  const native = await import("node:fs/promises");
  const roots = new MarkedRoots(() => {}, {
    lstat: (async (...args: Parameters<typeof native.lstat>) => {
      probes++;
      entered.resolve();
      await release.promise;
      return Reflect.apply(native.lstat, undefined, args);
    }) as typeof native.lstat,
  });
  roots.configure();
  await entered.promise;
  roots.dispose();
  let joined = false;
  const pending = roots.join().then(() => {
    joined = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      joined,
      false,
      "clearing configured roots cannot discard the original filesystem promise",
    );
    roots.configure();
    await roots.refresh();
    assert.equal(probes, 1);
    assert.equal(watchers, 1);
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal(joined, true);
});
