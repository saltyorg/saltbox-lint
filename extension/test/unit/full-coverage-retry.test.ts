import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { WorkspaceFolder } from "vscode";
import { Dependencies } from "../../src/dependencies.ts";
import { Results } from "../../src/results.ts";
import { observeAnalysis } from "../../src/observations.ts";
import { hash, type AnalysisRecord } from "../../src/protocol.ts";

// Run the actual saved-check, observation and coverage queue. Only the process
// boundary supplies a wire report; no CLI or installed editor is launched.
const bundled = await build({
  entryPoints: ["src/editor.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "coverage-api",
      setup(builder) {
        builder.onResolve(
          { filter: /^vscode$|^\.\/process\.ts$/ },
          ({ path }) => ({ path, namespace: "coverage-api" }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "coverage-api" },
          ({ path }) => ({
            contents:
              path === "vscode"
                ? "module.exports = globalThis.api"
                : "exports.runProcess = globalThis.runProcess",
            loader: "js",
          }),
        );
      },
    },
  ],
});

interface SavedEditor {
  checkSaved(
    folder: WorkspaceFolder,
    manual: boolean,
    selected?: Map<
      string,
      { filename: string; sourceHash: string; uri: ReturnType<typeof uri> }
    >,
  ): Promise<Set<string> | undefined>;
  disposed: boolean;
  pendingRefresh: Set<string>;
  rootRevisions: Map<string, number>;
  scanRevisions: Map<string, number>;
}
const uri = (filename: string) => ({
  fsPath: filename,
  path: filename.replaceAll("\\", "/"),
  scheme: "file",
  toString: () => `file://${filename}`,
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-full-coverage-")),
  );
  const primary = "roles/example/tasks/main.yml";
  const newerPrimary = "roles/example/defaults/main.yml";
  const template = "roles/example/templates/router.conf";
  for (const filename of [primary, newerPrimary, template]) {
    await mkdir(dirname(join(root, filename)), { recursive: true });
    await writeFile(
      join(root, filename),
      filename === template ? "original context\n" : "[]\n",
    );
  }
  const folder = { uri: uri(root) } as unknown as WorkspaceFolder;
  const key = folder.uri.toString();
  const workspace = {
    isTrusted: true,
    workspaceFolders: [folder],
    textDocuments: [],
  };
  const dependencies = new Dependencies();
  const results = new Results<{
    diagnostics: { relatedInformation?: unknown[] }[];
  }>();
  const queued: string[] = [];
  const published: string[] = [];
  const timers = new Map<number, () => void>();
  const background: Promise<unknown>[] = [];
  let timerID = 0;
  let availableRoot: string | undefined = root;
  let report: AnalysisRecord;
  let onReport = () => {};
  let requests = 0;
  const module = {
    exports: {} as { EditorIntegration: { prototype: SavedEditor } },
  };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    Buffer,
    process,
    AbortController,
    setTimeout(callback: () => void) {
      const id = ++timerID;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    api: {
      workspace,
      Uri: {
        file: uri,
        parse: (value: string) => uri(value.slice("file://".length)),
      },
    },
    runProcess() {
      requests++;
      onReport();
      return JSON.stringify({
        schema_version: 2,
        diagnostics: [],
        fixes: [],
        analysis: report,
      });
    },
  });
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as SavedEditor,
    {
      disposed: false,
      rootRevisions: new Map([[key, 1]]),
      scanRevisions: new Map(),
      dependencies,
      results,
      sourceOwners: new Map(),
      documentFolders: new Map(),
      canonicalRoots: new Map(),
      relatedRevision: 0,
      nextRevision: 1,
      pendingRefresh: new Set(),
      roots: {
        ready: async () => {},
        get: () => availableRoot,
        folder: () => folder,
      },
      lint: {
        submit: async (
          _key: string,
          _priority: number,
          operation: (signal: AbortSignal) => Promise<string>,
        ) => operation(new AbortController().signal),
        cancel() {},
      },
      formatting: { cancel() {} },
      executable: "supplied-wire-no-process",
      documentedRules: async () => new Set(),
      synchronizeSources: async () => {},
      queueFile: (value: ReturnType<typeof uri>) =>
        queued.push(value.toString()),
      revokeQueries() {},
      updateStatus() {},
      publish: (value: ReturnType<typeof uri>) =>
        published.push(value.toString()),
      error(error: unknown) {
        throw error;
      },
      background: (promise: Promise<unknown>) => background.push(promise),
      output: { appendLine() {} },
    },
  );
  async function analysis(source: string): Promise<AnalysisRecord> {
    const files = await Promise.all(
      [source, template].map(async (filename) => ({
        path: filename,
        state: "read" as const,
        sha256: hash(await readFile(join(root, filename))),
      })),
    );
    return {
      schema_version: 1,
      root,
      generation: hash("generation"),
      complete: true,
      sources: [
        {
          path: source,
          source_sha256: files[0].sha256,
          files,
          identity: [],
          discovery: [],
          directories: [],
        },
      ],
    };
  }
  return {
    root,
    primary,
    newerPrimary,
    template,
    folder,
    key,
    workspace,
    dependencies,
    results,
    queued,
    published,
    timers,
    editor,
    analysis,
    setReport(value: AnalysisRecord, callback = () => {}) {
      report = value;
      onReport = callback;
    },
    unavailable(value?: string) {
      availableRoot = value;
    },
    requests: () => requests,
    async flush() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
      await Promise.all(background.splice(0));
    },
    async close() {
      timers.clear();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const rejection of [
  "changed fingerprint echo",
  "dependency event",
] as const) {
  test(`rejected full scan retains one coverage retry after ${rejection}`, async () => {
    const f = await fixture();
    try {
      const old = await f.analysis(f.primary);
      f.setReport(old);
      if (rejection === "changed fingerprint echo") {
        await writeFile(join(f.root, f.template), "changed context\n");
        const newer = await f.analysis(f.newerPrimary);
        const observed = await observeAnalysis(newer);
        assert.equal(
          f.dependencies.accept(
            f.key,
            newer,
            f.dependencies.begin(),
            false,
            [],
            observed.fingerprints,
          ),
          true,
        );
        const stale = await observeAnalysis(old);
        assert.deepEqual([...stale.changed], [f.template]);
        assert.equal(
          f.dependencies.event(
            f.key,
            f.root,
            f.template,
            observed.fingerprints.get(f.template),
          ),
          undefined,
        );
      } else {
        // An event without an established observation cannot be proven an echo.
        f.setReport(old, () => {
          f.dependencies.event(f.key, f.root, f.template);
        });
      }
      assert.equal(await f.editor.checkSaved(f.folder, false), undefined);
      assert.equal(f.results.hasCompleteScan(f.key), false);
      assert.equal(f.results.uris().size, 0);
      assert.deepEqual(f.published, []);
      assert.equal(
        f.editor.pendingRefresh.has(f.key),
        true,
        "a rejected full scan retains desired full coverage",
      );
      assert.equal(f.timers.size, 1);
      assert.equal(await f.editor.checkSaved(f.folder, false), undefined);
      assert.equal(
        f.timers.size,
        1,
        "multiple rejections coalesce on the existing coverage timer",
      );
      assert.equal(f.editor.pendingRefresh.size, 1);
      assert.deepEqual(
        f.queued,
        [],
        "full retry does not become a selected-file retry",
      );
      f.setReport(await f.analysis(f.primary));
      await f.flush();
      assert.equal(
        f.requests(),
        3,
        "the queue launches exactly one replacement full scan",
      );
      assert.equal(f.results.hasCompleteScan(f.key), true);
      assert.equal(f.editor.pendingRefresh.size, 0);
      assert.equal(f.timers.size, 0, "accepted coverage does not retry again");
      assert.equal(
        f.results.uris().has(uri(join(f.root, f.primary)).toString()),
        true,
      );
    } finally {
      await f.close();
    }
  });
}

for (const scenario of [
  "disposed",
  "root revision",
  "scan revision",
  "admission revision",
  "removed folder",
  "untrusted",
  "unavailable root",
  "replaced root",
] as const) {
  test(`rejected full scan does not queue coverage for ${scenario}`, async () => {
    const f = await fixture();
    try {
      const old = await f.analysis(f.primary);
      f.setReport(old, () => {
        f.dependencies.event(f.key, f.root, f.template);
        if (scenario === "disposed") f.editor.disposed = true;
        if (scenario === "root revision") f.editor.rootRevisions.set(f.key, 2);
        if (scenario === "scan revision") f.editor.scanRevisions.set(f.key, 2);
        if (scenario === "admission revision")
          f.dependencies.event(f.key, f.root, ".gitignore");
        if (scenario === "removed folder") f.workspace.workspaceFolders = [];
        if (scenario === "untrusted") f.workspace.isTrusted = false;
        if (scenario === "unavailable root") f.unavailable();
        if (scenario === "replaced root") f.unavailable(f.root + "-replaced");
      });
      assert.equal(await f.editor.checkSaved(f.folder, false), undefined);
      assert.equal(f.editor.pendingRefresh.size, 0);
      assert.equal(f.timers.size, 0);
      assert.equal(f.results.hasCompleteScan(f.key), false);
      assert.deepEqual(f.queued, []);
      assert.deepEqual(f.published, []);
    } finally {
      await f.close();
    }
  });
}

test("rejected selected batch retries its selection without full coverage", async () => {
  const f = await fixture();
  try {
    const old = await f.analysis(f.primary);
    await writeFile(join(f.root, f.template), "changed context\n");
    const newer = await f.analysis(f.newerPrimary);
    const observed = await observeAnalysis(newer);
    f.dependencies.accept(
      f.key,
      newer,
      f.dependencies.begin(),
      false,
      [],
      observed.fingerprints,
    );
    f.setReport(old);
    const filename = join(f.root, f.primary);
    const selected = new Map([
      [
        f.primary,
        {
          filename,
          sourceHash: old.sources[0].source_sha256,
          uri: uri(filename),
        },
      ],
    ]);
    assert.equal(
      await f.editor.checkSaved(f.folder, false, selected),
      undefined,
    );
    assert.deepEqual(f.queued, [uri(filename).toString()]);
    assert.equal(f.editor.pendingRefresh.size, 0);
    assert.equal(f.timers.size, 0);
  } finally {
    await f.close();
  }
});
