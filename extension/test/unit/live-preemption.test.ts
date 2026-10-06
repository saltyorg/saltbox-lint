import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { Dependencies } from "../../src/dependencies.ts";
import { hash, SnapshotIndex } from "../../src/protocol.ts";
import type { Scheduler } from "../../src/scheduler.ts";
import type { LiveChecks } from "../../src/live-checks.ts";
import { runProcess } from "../../src/process.ts";

const bundle = await build({
  stdin: {
    contents:
      'export {EditorIntegration} from "./src/editor.ts"; export {Scheduler} from "./src/scheduler.ts";',
    resolveDir: process.cwd(),
  },
  write: false,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  plugins: [
    {
      name: "snapshot-adapters",
      setup(builder) {
        builder.onResolve(
          { filter: /\/(process|identity|observations|diagnostics)\.ts$/ },
          (args) => ({ path: args.path, external: true }),
        );
      },
    },
  ],
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ProcessingBoundary = "identity" | "rules" | "render" | "observe";

function fixture(t: TestContext, boundary?: ProcessingBoundary) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let enabled = true;
  let marked = true;
  const folder = { uri: { toString: () => "folder" } };
  const document = (name: string) => ({
    uri: {
      scheme: "file",
      path: `/root/${name}.yml`,
      fsPath: `/root/${name}.yml`,
      toString: () => name,
    },
    languageId: "yaml",
    version: 1,
    isDirty: true,
    isClosed: false,
    getText: () => "value: 😀é\r\n",
  });
  const a = document("a"),
    b = document("b");
  const entered = latch(),
    aborted = latch(),
    release = latch();
  const seen: string[] = [];
  const published: string[] = [];
  const errors: unknown[] = [];
  let launches = 0;
  let completed = 0;
  const processing = latch();
  const publications: string[] = [];
  async function pause(at: ProcessingBoundary) {
    if (boundary !== at || completed !== 1) return;
    assert.equal(
      completed,
      1,
      "the subprocess has closed before processing pauses",
    );
    processing.resolve();
    await release.promise;
  }
  const module = {
    exports: {} as {
      EditorIntegration: { prototype: object };
      Scheduler: new (limit: "retain") => Scheduler;
    },
  };
  const realRequire = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    Buffer,
    AbortController,
    process,
    setTimeout,
    clearTimeout,
    require: (name: string): unknown => {
      if (name === "vscode")
        return {
          window: { tabGroups: { all: [] } },
          workspace: {
            isTrusted: true,
            textDocuments: [a, b],
            getWorkspaceFolder: () => folder,
            getConfiguration: () => ({ get: () => enabled }),
          },
          Uri: {
            file: (filename: string) => ({ toString: () => filename }),
            parse: (filename: string) => ({ toString: () => filename }),
          },
        };
      if (name === "./identity.ts")
        return {
          templatePath: () => false,
          identify: async (root: string, filename: string) => {
            await pause("identity");
            return { root, filename, path: filename.slice(6) };
          },
        };
      if (name === "./observations.ts")
        return {
          observeAnalysis: async () => {
            await pause("observe");
            return { changed: new Set(), fingerprints: new Map() };
          },
        };
      if (name === "./diagnostics.ts")
        return {
          renderDiagnostics: async () => {
            await pause("render");
            return [];
          },
        };
      if (name === "./process.ts")
        return {
          runProcess: async (
            request: { args: string[]; input: string },
            signal: AbortSignal,
          ) => {
            const filename =
              request.args[request.args.indexOf("--stdin-filename") + 1];
            const path = filename.slice(6);
            seen.push(path);
            if (++launches === 1 && !boundary) {
              entered.resolve();
              signal.addEventListener("abort", () => aborted.resolve(), {
                once: true,
              });
              await release.promise;
              seen.push("joined");
            }
            const report = JSON.stringify({
              schema_version: 2,
              diagnostics: [],
              fixes: [],
              analysis: {
                schema_version: 1,
                root: "/root",
                generation: hash("generation"),
                complete: true,
                sources: [
                  {
                    path,
                    source_sha256: hash(request.input),
                    identity: [],
                    discovery: [],
                    files: [
                      { path, state: "read", sha256: hash(request.input) },
                    ],
                    directories: [],
                  },
                ],
              },
            });
            if (!boundary) return report;
            // Run the process adapter through a real child close. Result
            // processing, rather than a native operation, owns the later latch.
            const wire = await runProcess(
              {
                executable: process.execPath,
                cwd: process.cwd(),
                args: ["-e", "process.stdout.write(process.argv[1])", report],
              },
              signal,
            );
            completed++;
            return wire;
          },
        };
      return realRequire(name);
    },
  });
  interface Subject {
    change(value: typeof a): void;
    check(value: typeof a, manual?: boolean): Promise<void>;
    close(value: typeof a): void;
    saved(value: typeof a): void;
    configureRoots(): void;
    rootRevision(folder: string): number;
    documentRevision(value: typeof a): number;
    disposed: boolean;
    lint: Scheduler;
    liveChecks?: LiveChecks<typeof a>;
    dependencies: Dependencies;
  }
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as Subject,
    {
      documentFolders: new Map(),
      sourceOwners: new Map(),
      documentRevisions: new WeakMap(),
      rootRevisions: new Map(),
      pendingDiskReload: new Set(),
      nextRevision: 0,
      relatedRevision: 0,
      closedTabs: new Set(),
      disposed: false,
      roots: {
        get: () => (marked ? "/root" : undefined),
        ready: async () => {},
        refresh: async () => {},
        configure() {},
        forgetSource() {},
      },
      lint: new module.exports.Scheduler("retain"),
      formatting: { cancel() {} },
      checking: new Map(),
      dependencies: new Dependencies(),
      results: {
        invalidateRelated: () => [],
        close() {},
        storeDocument: (key: string) => published.push(key),
      },
      collection: { delete() {} },
      failures: new Map(),
      eligibilityChanged: { fire() {} },
      repaint() {},
      revokeQueries() {},
      publish: (uri: { toString(): string }) =>
        publications.push(uri.toString()),
      contextEvent() {},
      updateStatus() {},
      queueFile: () => editor.check(b),
      admit: async () => true,
      documentedRules: async () => {
        await pause("rules");
        return new Set();
      },
      snapshot: async (value: typeof a) => ({
        root: "/root",
        filename: value.uri.fsPath,
        sourceFilename: value.uri.fsPath,
        path: `${value.uri}.yml`,
        folder: "folder",
        version: value.version,
        text: value.getText(),
        hash: hash(value.getText()),
        rootRevision: editor.rootRevision("folder"),
        documentRevision: editor.documentRevision(value),
        dependencyRevision: 0,
        index: new SnapshotIndex(value.getText()),
      }),
      error: (error: unknown) => errors.push(error),
    },
  );
  t.after(async () => {
    release.resolve();
    editor.liveChecks?.dispose();
    editor.lint.dispose();
    await editor.liveChecks?.join();
    await editor.lint.join();
    assert.deepEqual(errors, []);
  });
  return {
    editor,
    a,
    b,
    entered,
    aborted,
    release,
    seen,
    published,
    errors,
    processing,
    publications,
    completed: () => completed,
    disable: () => {
      enabled = false;
    },
    unmark: () => {
      marked = false;
    },
  };
}

for (const priority of ["manual", "save"] as const) {
  test(
    `${priority} on B joins interrupted typing A and checks its unchanged paused buffer later`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t);
      f.editor.change(f.a);
      t.mock.timers.tick(300);
      await f.entered.promise;
      const command =
        priority === "manual"
          ? f.editor.check(f.b, true)
          : (f.editor.saved(f.b), f.editor.check(f.b));
      await f.aborted.promise;
      assert.deepEqual(f.seen, ["a.yml"], "successor waits for global join");
      f.release.resolve();
      await command;
      await f.editor.liveChecks?.join();
      assert.deepEqual(f.seen, ["a.yml", "joined", "b.yml"]);
      t.mock.timers.tick(300);
      await f.editor.liveChecks?.join();
      assert.deepEqual(f.seen, ["a.yml", "joined", "b.yml", "a.yml"]);
      assert.deepEqual(f.published, ["b", "a"]);
      assert.equal(f.a.version, 1);
      assert.equal(f.a.isDirty, true);
    },
  );
}

for (const control of [
  "close",
  "setting",
  "root",
  "reconfigure",
  "dispose",
] as const) {
  test(
    `preempted typing cannot resume after ${control}`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture(t);
      f.editor.change(f.a);
      t.mock.timers.tick(300);
      await f.entered.promise;
      const command = f.editor.check(f.b, true);
      await f.aborted.promise;
      if (control === "close") {
        f.a.isClosed = true;
        f.editor.close(f.a);
      }
      if (control === "setting") f.disable();
      if (control === "root") f.unmark();
      if (control === "reconfigure") f.editor.configureRoots();
      if (control === "dispose") {
        f.editor.disposed = true;
        f.editor.liveChecks?.dispose();
        f.editor.lint.dispose();
      }
      f.release.resolve();
      await command;
      await f.editor.liveChecks?.join();
      t.mock.timers.tick(300);
      await f.editor.liveChecks?.join();
      assert.equal(f.seen.filter((value) => value === "a.yml").length, 1);
      assert.ok(!f.published.includes("a"));
    },
  );
}

test(
  "manual supersession on A publishes once without another typing request",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    f.editor.change(f.a);
    t.mock.timers.tick(300);
    await f.entered.promise;
    const command = f.editor.check(f.a, true);
    await f.aborted.promise;
    f.release.resolve();
    await command;
    await f.editor.liveChecks?.join();
    t.mock.timers.tick(300);
    await f.editor.liveChecks?.join();
    assert.deepEqual(f.seen, ["a.yml", "joined", "a.yml"]);
    assert.deepEqual(f.published, ["a"]);
  },
);

test(
  "new typing while preemption joins replaces the interrupted snapshot",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    f.editor.change(f.a);
    t.mock.timers.tick(300);
    await f.entered.promise;
    const command = f.editor.check(f.b, true);
    await f.aborted.promise;
    f.a.version++;
    f.editor.change(f.a);
    t.mock.timers.tick(300);
    assert.deepEqual(f.seen, ["a.yml"]);
    f.release.resolve();
    await command;
    await f.editor.liveChecks?.join();
    await f.editor.liveChecks?.join();
    assert.deepEqual(f.seen, ["a.yml", "joined", "b.yml", "a.yml"]);
    assert.deepEqual(f.published, ["b", "a"]);
    t.mock.timers.tick(300);
    await f.editor.liveChecks?.join();
    assert.equal(f.seen.length, 4);
  },
);

test(
  "unclassified scheduler cancellation cannot create a typing retry",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    f.editor.change(f.a);
    t.mock.timers.tick(300);
    await f.entered.promise;
    f.editor.lint.cancel("a");
    await f.aborted.promise;
    f.release.resolve();
    await f.editor.liveChecks?.join();
    t.mock.timers.tick(300);
    await f.editor.liveChecks?.join();
    assert.deepEqual(f.seen, ["a.yml", "joined"]);
    assert.deepEqual(f.published, []);
  },
);

for (const boundary of ["identity", "rules", "render", "observe"] as const) {
  for (const control of [
    "enabled",
    "setting",
    "cancel",
    "close",
    "supersede",
    "newer buffer",
    "root",
    "reconfigure",
    "dispose",
  ] as const) {
    test(
      `completed typing result at ${boundary} handles ${control} after subprocess close`,
      { timeout: 5000 },
      async (t) => {
        const f = fixture(t, boundary);
        const acceptance = t.mock.method(f.editor.dependencies, "accept");
        f.editor.change(f.a);
        t.mock.timers.tick(300);
        await f.processing.promise;
        assert.equal(f.completed(), 1);
        assert.equal(acceptance.mock.callCount(), 0);
        assert.deepEqual(f.published, []);
        if (control === "setting") {
          f.disable();
          // The configuration listener cancels ineligible typing entries.
          f.editor.liveChecks?.cancelWhere(() => true);
        }
        if (control === "cancel") f.editor.liveChecks?.cancel(f.a);
        if (control === "close") {
          f.a.isClosed = true;
          f.editor.close(f.a);
        }
        if (control === "supersede") f.editor.change(f.a);
        if (control === "newer buffer") {
          f.a.version++;
          f.editor.change(f.a);
        }
        if (control === "root") f.unmark();
        if (control === "reconfigure") f.editor.configureRoots();
        if (control === "dispose") {
          f.editor.disposed = true;
          f.editor.liveChecks?.dispose();
          f.editor.lint.dispose();
        }
        // Ignore invalidation publications emitted by the control itself.
        f.publications.length = 0;
        f.release.resolve();
        await f.editor.liveChecks?.join();
        assert.equal(
          f.completed(),
          1,
          "cancelled results do not launch retries",
        );
        const accepted = control === "enabled";
        assert.equal(acceptance.mock.callCount(), accepted ? 1 : 0);
        assert.deepEqual(f.published, accepted ? ["a"] : []);
        assert.deepEqual(f.publications, accepted ? ["a"] : []);
        if (control === "supersede" || control === "newer buffer") {
          t.mock.timers.tick(300);
          await f.editor.liveChecks?.join();
          assert.equal(f.completed(), 2);
          assert.equal(acceptance.mock.callCount(), 1);
          assert.deepEqual(f.published, ["a"]);
          assert.deepEqual(f.publications, ["a"]);
        } else {
          t.mock.timers.tick(300);
          await f.editor.liveChecks?.join();
          assert.equal(f.completed(), 1);
        }
      },
    );
  }
}
