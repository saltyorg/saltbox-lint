import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { LiveChecks } from "../../src/live-checks.ts";

const bundle = await build({
  entryPoints: ["src/editor.ts"],
  write: false,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let enabled = false;
  let marked = true;
  const folder = { uri: { toString: () => "folder" } };
  const document = {
    uri: {
      scheme: "file",
      path: "/root/primary.yml",
      fsPath: "/root/primary.yml",
      toString: () => "primary",
    },
    languageId: "yaml",
    version: 1,
    isDirty: true,
    isClosed: false,
    getText: () => "value: 1\r\n",
  };
  const calls: {
    document: unknown;
    version: unknown;
    typing: unknown;
    signal: AbortSignal;
  }[] = [];
  const events: string[] = [];
  const module = {
    exports: {} as {
      EditorIntegration: { prototype: Record<string, unknown> };
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
    require: (name: string): unknown =>
      name === "vscode"
        ? {
            window: { tabGroups: { all: [] } },
            workspace: {
              isTrusted: true,
              getWorkspaceFolder: () => folder,
              getConfiguration: () => ({
                get: (_key: string, fallback: unknown) => enabled || fallback,
              }),
              textDocuments: [document],
            },
            Uri: {
              file: (filename: string) => ({ toString: () => filename }),
              parse: (filename: string) => ({ toString: () => filename }),
            },
          }
        : realRequire(name),
  });
  interface Subject {
    change(document: unknown): void;
    saved(document: unknown): void;
    close(document: unknown): void;
    configureRoots(): void;
    disposed: boolean;
    sourceOwners: Map<string, { path: string; filename: string }>;
    liveChecks?: LiveChecks<object>;
  }
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as Subject,
    {
      documentFolders: new Map([["primary", "folder"]]),
      sourceOwners: new Map(),
      documentRevisions: new WeakMap(),
      pendingDiskReload: new Set(),
      nextRevision: 0,
      relatedRevision: 0,
      closedTabs: new Set(),
      disposed: false,
      roots: {
        get: () => (marked ? "/root" : undefined),
        configure() {},
        forgetSource() {},
      },
      lint: { cancel: () => events.push("cancel") },
      formatting: { cancel() {} },
      results: { invalidateRelated: () => [], close() {} },
      collection: { delete() {} },
      failures: new Map(),
      eligibilityChanged: { fire() {} },
      repaint() {},
      revokeQueries() {},
      publish: () => events.push("publish"),
      contextEvent() {},
      queueFile: () => events.push("save"),
      check: async (
        value: unknown,
        _manual: unknown,
        version: unknown,
        typing: unknown,
        signal: AbortSignal,
      ) => {
        calls.push({ document: value, version, typing, signal });
      },
      error: (error: unknown) => {
        throw error;
      },
    },
  );
  return {
    editor,
    document,
    calls,
    events,
    enabled: (value: boolean) => {
      enabled = value;
    },
    marked: (value: boolean) => {
      marked = value;
    },
  };
}

test("real change path invalidates immediately, default-off launches none, enabled uses latest buffer check without writable actions", async (t) => {
  const f = fixture(t);
  f.editor.change(f.document);
  assert.deepEqual(f.events, ["cancel", "publish"]);
  t.mock.timers.tick(300);
  assert.equal(f.calls.length, 0);
  f.enabled(true);
  f.editor.change(f.document);
  f.document.version++;
  f.editor.change(f.document);
  t.mock.timers.tick(300);
  await f.editor.liveChecks?.join();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].document, f.document);
  assert.equal(f.calls[0].version, 2);
  assert.equal(f.calls[0].typing, true);
  f.editor.liveChecks?.dispose();
});

for (const unavailable of [
  "marker",
  "template alias",
  "closed",
  "setting",
  "root reconfigure",
  "save",
] as const) {
  test(`typing eligibility/lifecycle cancels for ${unavailable}`, async (t) => {
    const f = fixture(t);
    f.enabled(true);
    f.editor.change(f.document);
    if (unavailable === "marker") f.marked(false);
    if (unavailable === "template alias")
      f.editor.sourceOwners.set("primary", {
        filename: "/root/roles/a/templates/config.yaml",
        path: "roles/a/templates/config.yaml",
      });
    if (unavailable === "closed") {
      f.document.isClosed = true;
      f.editor.close(f.document);
    }
    if (unavailable === "setting") f.enabled(false);
    if (unavailable === "root reconfigure") f.editor.configureRoots();
    if (unavailable === "save") f.editor.saved(f.document);
    if (["marker", "template alias", "setting"].includes(unavailable))
      f.editor.change(f.document);
    t.mock.timers.tick(300);
    await f.editor.liveChecks?.join();
    assert.equal(f.calls.length, 0);
    f.editor.liveChecks?.dispose();
  });
}
