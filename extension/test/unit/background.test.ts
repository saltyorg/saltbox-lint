import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import ts from "typescript";

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
          builder.onResolve(
            { filter: /^vscode$|^node:fs\/promises$|^\.\/identity\.ts$/ },
            ({ path }) => ({ path, namespace: "background-io" }),
          );
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
    MarkedRoots: new (report: (error: unknown) => void) => {
      configure: () => void;
      ready: () => Promise<void>;
      dispose: () => void;
    };
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

test("event probe reports failure while readiness retains the original rejection", async () => {
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
            uri: { scheme: "file", fsPath: "/source", toString: () => "root" },
          },
        ],
        getConfiguration: () => ({ get: () => "" }),
        createFileSystemWatcher: () => {
          if (++registrations > 1) throw original;
          return watcher;
        },
      },
    },
    "node:fs/promises": { lstat: async () => ({ isFile: () => true }) },
    "./identity.ts": { canonicalRoot: async () => "/source" },
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

test("admission cleanup cancels its owner and joins the complete check before removing its gate", async () => {
  const source = ts.createSourceFile(
    "dependencies.ts",
    readFileSync("test/host/dependencies.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const run = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "runDependencies",
  );
  assert.ok(run?.body);
  const cleanup = run.body.statements.find(ts.isTryStatement)?.finallyBlock;
  assert.ok(cleanup);
  let release!: () => void;
  let drain!: () => void;
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
  const result = runInNewContext(`(async () => ${cleanup.getText(source)})()`, {
    aliasRefresh: {
      dispose: () => {
        aliasRefreshDisposed = true;
      },
    },
    aliasTemplateEvents: {
      dispose: () => {
        observerDisposed = true;
      },
    },
    editor: {
      dispose: () => {
        assert.equal(aliasRefreshDisposed, true);
        disposed = true;
        release();
      },
    },
    failed: false,
    admissionControl: Promise.allSettled([operation]),
    subscriptions: [],
    process: { env: {} },
    aliasDirectory: { fsPath: "owned-alias-directory" },
    temporary: "owned-gate-directory",
    rm: async (path: string) => {
      assert.equal(completed, true);
      assert.equal(disposed, true);
      removedPaths.push(path);
      removed = true;
    },
  }) as Promise<void>;
  try {
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
