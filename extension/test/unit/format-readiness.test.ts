import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { test, type TestContext } from "node:test";
import { build } from "esbuild";

type Stage = "defaults" | "template" | "early";

function failures(error: unknown): object[] {
  const found = new Set<object>();
  const visit = (value: unknown) => {
    if (typeof value !== "object" || value === null || found.has(value)) return;
    found.add(value);
    visit(Reflect.get(value, "cause"));
    const nested: unknown = Reflect.get(value, "errors");
    if (Array.isArray(nested)) for (const item of nested) visit(item);
  };
  visit(error);
  return [...found];
}

async function formatter(t: TestContext, stage: Stage) {
  const base = await mkdtemp(join(tmpdir(), "saltbox-format-readiness-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const profile = join(base, "profile");
  const workspace = join(profile, "workspace");
  const folder = join(workspace, "one");
  const defaults = join(folder, "roles/example/defaults");
  await mkdir(defaults, { recursive: true });
  const marker = join(folder, ".saltbox-lint");
  const originalPath = join(defaults, "original.yml");
  const leaf = join(defaults, "format-readiness.yml");
  await writeFile(marker, "");
  await writeFile(originalPath, "original: source\n");

  class Uri {
    readonly scheme = "file";
    readonly fsPath: string;
    constructor(path: string) {
      this.fsPath = path;
    }
    toString() {
      return pathToFileURL(this.fsPath).toString();
    }
    static file(path: string) {
      return new Uri(path);
    }
    static joinPath(uri: Uri, ...parts: string[]) {
      return new Uri(join(uri.fsPath, ...parts));
    }
  }
  type Document = {
    uri: Uri;
    languageId: string;
    version: number;
    isClosed: boolean;
    isDirty: boolean;
    text: string;
    getText(): string;
  };
  const documents = new Map<string, Document>();
  const open = async (uri: Uri): Promise<Document> => {
    const key = uri.toString();
    const existing = documents.get(key);
    if (existing && !existing.isClosed) return existing;
    const document = {
      uri,
      languageId: "yaml",
      version: 1,
      isClosed: false,
      isDirty: false,
      text: await readFile(uri.fsPath, "utf8"),
      getText() {
        return this.text;
      },
    };
    documents.set(key, document);
    return document;
  };
  const original = await open(Uri.file(originalPath));
  let active: Document | undefined;
  const calls: string[] = [];
  const faults = {
    early: new Error("formatter rejected before marker admission"),
    dispose: new Error("formatter dispose failed"),
    join: new Error("formatter join failed"),
    configuration: new Error("formatter configuration restore failed"),
    deletion: new Error("formatter leaf deletion failed"),
    show: new Error("formatter original editor restore failed"),
  };
  let templateAttempted = false;
  const tabListeners = new Set<
    (event: { closed: { input: { uri: Uri } }[] }) => void
  >();
  const close = (document: Document) => {
    document.isClosed = true;
    for (const listener of tabListeners)
      listener({ closed: [{ input: { uri: document.uri } }] });
  };
  const selectedClose = async (_signal: AbortSignal, uris: readonly Uri[]) => {
    calls.push("selected tabs");
    for (const uri of uris) {
      const document = documents.get(uri.toString());
      if (document) close(document);
    }
  };
  class WorkspaceEdit {
    insertions: { uri: Uri; text: string }[] = [];
    insert(uri: Uri, _position: Position, text: string) {
      this.insertions.push({ uri, text });
    }
  }
  class Position {
    readonly line: number;
    readonly character: number;
    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  }
  class CancellationTokenSource {
    readonly token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {
      calls.push("token dispose");
    }
  }
  const sdk = {
    Uri,
    WorkspaceEdit,
    Position,
    CancellationTokenSource,
    ConfigurationTarget: { WorkspaceFolder: 3 },
    workspace: {
      getWorkspaceFolder: () => ({
        uri: Uri.file(folder),
        name: "one",
        index: 0,
      }),
      openTextDocument: open,
      applyEdit: async (edit: WorkspaceEdit) => {
        for (const change of edit.insertions) {
          const document = documents.get(change.uri.toString());
          assert.ok(document);
          document.text = change.text + document.text;
          document.isDirty = true;
          document.version++;
        }
        return true;
      },
      fs: {
        createDirectory: (uri: Uri) => mkdir(uri.fsPath, { recursive: true }),
        writeFile: (uri: Uri, bytes: Uint8Array) =>
          writeFile(uri.fsPath, bytes),
        delete: async (uri: Uri) => {
          if (uri.fsPath === leaf) {
            calls.push("delete leaf");
            if (stage !== "early") throw faults.deletion;
          }
          await rm(uri.fsPath, { recursive: true });
        },
      },
      getConfiguration: () => ({
        inspect: () => ({ workspaceFolderValue: "previous root" }),
        update: async (_name: string, value: unknown) => {
          calls.push("configuration " + String(value));
          if (templateAttempted && value === "previous root")
            throw faults.configuration;
        },
      }),
    },
    window: {
      showTextDocument: async (document: Document) => {
        if (document === original) {
          calls.push("show original");
          if (stage !== "early") throw faults.show;
        }
        active = document;
        return { document };
      },
      tabGroups: {
        onDidChangeTabs: (
          listener: (event: { closed: { input: { uri: Uri } }[] }) => void,
        ) => {
          tabListeners.add(listener);
          return {
            dispose: () => {
              tabListeners.delete(listener);
            },
          };
        },
      },
    },
    commands: {
      executeCommand: async () => {
        assert.ok(active);
        close(active);
      },
    },
  };
  let ordinal = 0;
  class Editor {
    private readonly kind: "defaults" | "template";
    private readonly number = ++ordinal;
    private readonly options: {
      roots?: { lstat: typeof import("node:fs/promises").lstat };
    };
    constructor(
      _executable: string,
      options: { roots?: { lstat: typeof import("node:fs/promises").lstat } },
    ) {
      this.options = options;
      this.kind = options.roots ? "defaults" : "template";
    }
    async format(
      document: Document,
      _mode: string,
      token?: { isCancellationRequested: boolean },
    ) {
      if (stage === "early") throw faults.early;
      if (!this.options.roots) {
        templateAttempted = true;
        return [{}];
      }
      const revision = document.version;
      await this.options.roots.lstat(marker);
      if (stage === "defaults" && this.number === 1) return [];
      if (
        revision !== document.version ||
        document.isClosed ||
        token?.isCancellationRequested ||
        !existsSync(marker)
      )
        return [];
      return [{}];
    }
    async check(_document: Document, _manual: boolean) {}
    async fixAll(_uri: Uri) {}
    close(document: Document) {
      document.isClosed = true;
    }
    dispose() {
      calls.push(this.kind + " dispose");
      if (stage === this.kind) throw faults.dispose;
    }
    async join() {
      calls.push(this.kind + " join");
      if (stage === this.kind) throw faults.join;
    }
  }
  const bundle = await build({
    entryPoints: ["test/host/format-readiness.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "error",
    plugins: [
      {
        name: "private-formatter-adapters",
        setup(builder) {
          const replacements = new Map([
            ["vscode", "module.exports = globalThis.sdk"],
            [
              "editor",
              "exports.EditorIntegration = class extends globalThis.Editor { async format(...args) { return [...await super.format(...args)] } }; exports.tabDocumentUris = tab => [tab.input.uri]",
            ],
            ["ui", "exports.componentUI = () => ({})"],
            ["tabs", "exports.closeEditorTabs = globalThis.selectedClose"],
          ]);
          for (const [filter, name] of [
            [/^vscode$/, "vscode"],
            [/src\/editor\.ts$/, "editor"],
            [/component-ui\.ts$/, "ui"],
            [/editor-tabs\.ts$/, "tabs"],
          ] as const)
            builder.onResolve({ filter }, () => ({
              path: name,
              namespace: "private-formatter",
            }));
          builder.onLoad(
            { filter: /.*/, namespace: "private-formatter" },
            ({ path }) => ({ contents: replacements.get(path), loader: "js" }),
          );
        },
      },
    ],
  });
  const module = {
    exports: {} as {
      checkFormatReadiness(
        executable: string,
        original: Document,
      ): Promise<void>;
    },
  };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    sdk,
    Editor,
    selectedClose,
    process: {
      ...process,
      env: {
        ...process.env,
        SALTBOX_TEST_PROFILE_ROOT: profile,
        SALTBOX_TEST_WORKSPACE_PATH: workspace,
      },
    },
    console: { log() {} },
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  return {
    run: () =>
      module.exports.checkFormatReadiness("private-executable", original),
    calls,
    faults,
    listeners: () => tabListeners.size,
    leaf,
  };
}

for (const stage of ["defaults", "template"] as const) {
  test(`formatter ${stage} assertion preserves independent restoration failures`, async (t) => {
    const host = await formatter(t, stage);
    let outcome: unknown;
    try {
      await host.run();
    } catch (error) {
      outcome = error;
    }
    const retained = failures(outcome);
    const message =
      stage === "defaults"
        ? "fresh writable YAML formats after root readiness"
        : "Expected values to be strictly deep-equal";
    const assertionRetained = retained.some(
      (error) =>
        Reflect.get(error, "code") === "ERR_ASSERTION" &&
        String(Reflect.get(error, "message")).includes(message),
    );
    if (!assertionRetained)
      console.error(
        "SALTBOX_FORMATTER_RESTORATION_RED " +
          JSON.stringify({
            stage,
            calls: host.calls,
            retained: retained.map((error) => ({
              name: Reflect.get(error, "name"),
              message: Reflect.get(error, "message"),
              code: Reflect.get(error, "code"),
              stack: Reflect.get(error, "stack"),
            })),
          }),
      );
    assert.ok(assertionRetained, "retain the original formatter assertion");
    for (const fault of [
      host.faults.dispose,
      host.faults.join,
      host.faults.deletion,
      host.faults.show,
      ...(stage === "template" ? [host.faults.configuration] : []),
    ])
      assert.ok(
        retained.includes(fault),
        "retain exact cleanup error: " + fault.message,
      );
    for (const call of [
      stage + " dispose",
      stage + " join",
      "delete leaf",
      "show original",
    ])
      assert.ok(
        host.calls.includes(call),
        "attempt independent cleanup: " + call,
      );
    assert.equal(host.listeners(), 0);
  });
}

test("formatter rejection before marker admission restores and joins the caller", async (t) => {
  const host = await formatter(t, "early");
  let outcome: unknown;
  try {
    await host.run();
  } catch (error) {
    outcome = error;
  }
  assert.ok(failures(outcome).includes(host.faults.early));
  for (const call of [
    "defaults dispose",
    "defaults join",
    "delete leaf",
    "show original",
  ])
    assert.ok(host.calls.includes(call), call);
  assert.equal(host.listeners(), 0);
  assert.equal(existsSync(host.leaf), false);
});
