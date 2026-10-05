import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { MarkedRoots } from "../../src/roots.ts";
import type { Uri } from "vscode";

const bundled = await build({
  entryPoints: ["src/roots.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "watcher-api",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "watcher-api",
        }));
        builder.onLoad({ filter: /.*/, namespace: "watcher-api" }, () => ({
          contents: "module.exports = globalThis.api",
          loader: "js",
        }));
      },
    },
  ],
});

class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

test("template watches include standalone primaries and exact narrowed-root source aliases, and release on close/root disposal", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-template-watchers-")),
  );
  const narrow = join(root, "roles/demo/templates");
  const uri = (filename: string) => ({
    scheme: "file",
    fsPath: filename,
    toString: () => `file://${filename}`,
  });
  const folder = { uri: uri(root) };
  let configured = "";
  const watchers: {
    base: string;
    pattern: string;
    deleted: Emitter<Uri>;
    disposed: boolean;
  }[] = [];
  const module = { exports: {} as { MarkedRoots: typeof MarkedRoots } };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    api: {
      Uri: { file: uri },
      EventEmitter: Emitter,
      Disposable: {
        from: (...items: { dispose(): void }[]) => ({
          dispose() {
            for (const item of items) item.dispose();
          },
        }),
      },
      RelativePattern: class {
        base: { fsPath: string };
        pattern: string;
        constructor(base: { fsPath: string }, pattern: string) {
          this.base = base;
          this.pattern = pattern;
        }
      },
      workspace: {
        workspaceFolders: [folder],
        getConfiguration: () => ({ get: () => configured }),
        createFileSystemWatcher(pattern: {
          base: { fsPath: string };
          pattern: string;
        }) {
          const watcher = {
            base: pattern.base.fsPath,
            pattern: pattern.pattern,
            deleted: new Emitter<Uri>(),
            disposed: false,
          };
          watchers.push(watcher);
          return {
            dispose() {
              watcher.disposed = true;
            },
            onDidCreate: () => ({ dispose() {} }),
            onDidChange: () => ({ dispose() {} }),
            onDidDelete: watcher.deleted.event,
          };
        },
      },
    },
  });
  const roots = new module.exports.MarkedRoots();
  try {
    await mkdir(narrow, { recursive: true });
    await writeFile(join(root, ".saltbox-lint"), "");
    await writeFile(join(narrow, ".saltbox-lint"), "");
    roots.configure();
    await roots.ready();
    assert.ok(
      watchers.some(
        (watcher) =>
          !watcher.disposed &&
          watcher.base === root &&
          watcher.pattern === "**/*.j2",
      ),
    );
    configured = "roles/demo/templates";
    roots.configure();
    await roots.ready();
    const origin = uri(join(root, "readonly-alias/config")) as Uri;
    const filename = join(narrow, "config");
    roots.watchSource(origin, { root: narrow, filename, path: "config" });
    const exact = watchers.filter(
      (watcher) => !watcher.disposed && watcher.pattern === "config",
    );
    assert.equal(exact.length, 2);
    assert.deepEqual(
      new Set(exact.map((watcher) => watcher.base)),
      new Set([narrow, join(root, "readonly-alias")]),
    );
    const observed: Uri[] = [];
    roots.onDidChangeFile((value) => observed.push(value));
    exact[0].deleted.fire(origin);
    exact[1].deleted.fire(uri(filename) as Uri);
    assert.equal(
      observed.length,
      2,
      "actual registered callbacks deliver source and canonical deletion events",
    );
    roots.forgetSource(origin.toString());
    assert.ok(exact.every((watcher) => watcher.disposed));
    const before = watchers.length;
    roots.watchSource(origin, {
      root: narrow,
      filename: join(root, "outside"),
      path: "../outside",
    });
    assert.equal(
      watchers.length,
      before,
      "escaping identities never install a watcher",
    );
    roots.watchSource(origin, { root: narrow, filename, path: "config" });
    await rm(join(narrow, ".saltbox-lint"));
    await roots.refresh();
    assert.ok(
      watchers
        .filter((watcher) => watcher.pattern === "config")
        .every((watcher) => watcher.disposed),
      "marker removal releases admitted source watchers",
    );
    roots.dispose();
    assert.ok(watchers.every((watcher) => watcher.disposed));
  } finally {
    roots.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
