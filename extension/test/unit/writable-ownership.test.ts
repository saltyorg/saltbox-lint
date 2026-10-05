import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { TextDocument } from "vscode";
import type { EditorIntegration } from "../../src/editor.ts";
import { hash } from "../../src/protocol.ts";
import { Scheduler } from "../../src/scheduler.ts";

const bundled = await build({
  entryPoints: ["src/editor.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "writable-api",
      setup(builder) {
        builder.onResolve(
          { filter: /^vscode$|^\.\/process\.ts$/ },
          ({ path }) => ({ path, namespace: "writable-api" }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "writable-api" },
          ({ path }) => ({
            contents:
              path === "vscode"
                ? "module.exports = globalThis.api"
                : "exports.runProcess = globalThis.api.runProcess",
            loader: "js",
          }),
        );
      },
    },
  ],
});

test("pending writable requests and final application retain the original source owner without watcher delivery", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-writable-owner-")),
  );
  const external = root + "-external";
  const original = join(root, "roles/demo/defaults");
  const template = join(root, "roles/demo/templates");
  const other = join(root, "roles/other/defaults");
  const alias = join(root, "alias");
  const text = "a:  1\n";
  const uri = (filename: string) => ({
    scheme: "file",
    path: filename.replaceAll("\\", "/"),
    fsPath: filename,
    toString: () => `file://${filename}`,
  });
  const folder = { uri: uri(root) };
  let applied = 0;
  let beforeApplyPlan: (() => void) | undefined;
  let enter!: () => void;
  let release!: (wire: string) => void;
  const documents: TextDocument[] = [];
  const workspace = {
    isTrusted: true,
    textDocuments: documents,
    getWorkspaceFolder: () => folder,
    applyEdit: async () => {
      applied++;
      return true;
    },
  };
  class Position {
    line: number;
    character: number;
    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  }
  class Range {
    start: Position;
    end: Position;
    constructor(start: Position, end: Position) {
      this.start = start;
      this.end = end;
    }
  }
  class WorkspaceEdit {
    set() {
      beforeApplyPlan?.();
    }
  }
  const module = {
    exports: {} as { EditorIntegration: typeof EditorIntegration },
  };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    api: {
      workspace,
      Uri: { file: uri },
      Position,
      Range,
      WorkspaceEdit,
      TextEdit: {
        replace: (range: Range, newText: string) => ({ range, newText }),
      },
      runProcess: async () => {
        enter();
        return new Promise<string>((done) => {
          release = done;
        });
      },
    },
  });
  const retarget = (destination: string) => {
    rmSync(alias, { recursive: true, force: true });
    symlinkSync(destination, alias, "junction");
  };
  try {
    for (const directory of [original, template, other, external]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "main.yaml"), text);
    }
    for (const operation of [
      "canonical",
      "lint-fixes",
      "fixAll",
      "shared",
    ] as const) {
      for (const change of [
        "stable",
        "template",
        "other YAML",
        "missing",
        "escape",
        "root",
        "marker",
        "version",
        "hash",
        "closed",
        "untrusted",
        "dependency",
        "document revision",
        "canceled",
      ] as const) {
        if (
          (operation === "shared" || operation === "fixAll") &&
          change === "canceled"
        )
          continue;
        retarget(original);
        workspace.isTrusted = true;
        documents.length = 0;
        applied = 0;
        let entered!: () => void;
        const reached = new Promise<void>((done) => {
          entered = done;
        });
        enter = entered;
        let buffer = text;
        const document = {
          uri: uri(join(alias, "main.yaml")),
          languageId: "yaml",
          isClosed: false,
          isDirty: false,
          version: 1,
          getText: () => buffer,
        } as unknown as TextDocument;
        documents.push(document);
        let activeRoot: string | undefined = root;
        let dependency = 0;
        const revisions = new WeakMap<TextDocument, number>();
        const rootRevisions = new Map<string, number>();
        const formatting = new Scheduler();
        const editor = Object.assign(
          Object.create(module.exports.EditorIntegration.prototype) as Pick<
            EditorIntegration,
            "format" | "fixAll" | "applyShared"
          > & {
            snapshot(document: TextDocument): Promise<unknown>;
          },
          {
            disposed: false,
            executable: "controlled-formatter",
            closedTabs: new Set(),
            sourceOwners: new Map(),
            canonicalRoots: new Map(),
            documentFolders: new Map(),
            checking: new Map(),
            rootRevisions,
            documentRevisions: revisions,
            nextRevision: 0,
            roots: {
              ready: async () => {},
              refresh: async () => {},
              get: () => activeRoot,
              watchSource() {},
            },
            dependencies: {
              revision: () => dependency,
              admissionRevision: () => 0,
            },
            eligibilityChanged: { fire() {} },
            publish() {},
            output: { appendLine() {} },
            error(error: unknown) {
              throw error;
            },
            formatting,
          },
        );
        const cancellation = new AbortController();
        const token = {
          get isCancellationRequested() {
            return cancellation.signal.aborted;
          },
          onCancellationRequested(callback: (event: unknown) => unknown) {
            const canceled = () => {
              callback(undefined);
            };
            cancellation.signal.addEventListener("abort", canceled);
            return {
              dispose() {
                cancellation.signal.removeEventListener("abort", canceled);
              },
            };
          },
        };
        const wire = JSON.stringify({
          schema_version: 1,
          path: "roles/demo/defaults/main.yaml",
          source_sha256: hash(text),
          status: "ready",
          edits: [
            {
              range: {
                start: { line: 1, column: 4 },
                end: { line: 1, column: 5 },
              },
              span: { start: 3, end: 4 },
              text: "",
            },
          ],
        });
        let pending: Promise<unknown>;
        if (operation === "shared") {
          const snapshot = await editor.snapshot(document);
          Object.assign(editor, {
            results: {
              document: () => ({
                id: "report",
                snapshot,
                report: {
                  fixes: new Map([
                    [
                      "fix",
                      {
                        id: "fix",
                        path: "roles/demo/defaults/main.yaml",
                        edits: JSON.parse(wire).edits,
                      },
                    ],
                  ]),
                },
              }),
            },
          });
          pending = Promise.resolve();
        } else {
          pending =
            operation === "fixAll"
              ? editor.fixAll(document.uri)
              : editor.format(document, operation, token);
          await reached;
        }
        if (change === "template") retarget(template);
        if (change === "other YAML") retarget(other);
        if (change === "missing") await rm(join(original, "main.yaml"));
        if (change === "escape") retarget(external);
        if (change === "root") activeRoot = other;
        if (change === "marker") activeRoot = undefined;
        if (change === "version") Reflect.set(document, "version", 2);
        if (change === "hash") buffer += "# edit\n";
        if (change === "closed") Reflect.set(document, "isClosed", true);
        if (change === "untrusted") workspace.isTrusted = false;
        if (change === "dependency") dependency++;
        if (change === "document revision") revisions.set(document, 999);
        if (change === "canceled") cancellation.abort();
        if (operation === "shared")
          pending = editor.applyShared(
            document.uri,
            hash(text),
            "fix",
            "report",
          );
        else release(wire);
        const result = await pending;
        if (operation === "canonical" || operation === "lint-fixes")
          assert.equal(
            (result as unknown[]).length,
            change === "stable" ? 1 : 0,
            `${operation}: ${change}`,
          );
        else
          assert.equal(
            applied,
            change === "stable" ? 1 : 0,
            `${operation}: ${change}`,
          );
        formatting.dispose();
        await writeFile(join(original, "main.yaml"), text);
      }
    }
    // A command can also lose ownership after its formatting result was accepted.
    for (const operation of ["fixAll", "shared"] as const) {
      retarget(original);
      workspace.isTrusted = true;
      applied = 0;
      const document = {
        uri: uri(join(alias, "main.yaml")),
        languageId: "yaml",
        isClosed: false,
        isDirty: false,
        version: 1,
        getText: () => text,
      } as unknown as TextDocument;
      documents.splice(0, documents.length, document);
      const formatting = new Scheduler();
      const editor = Object.assign(
        Object.create(module.exports.EditorIntegration.prototype) as Pick<
          EditorIntegration,
          "format" | "fixAll" | "applyShared"
        > & {
          snapshot(document: TextDocument): Promise<unknown>;
        },
        {
          disposed: false,
          executable: "controlled-formatter",
          closedTabs: new Set(),
          sourceOwners: new Map(),
          canonicalRoots: new Map(),
          documentFolders: new Map(),
          checking: new Map(),
          rootRevisions: new Map(),
          documentRevisions: new WeakMap(),
          nextRevision: 0,
          roots: {
            ready: async () => {},
            refresh: async () => {},
            get: () => root,
            watchSource() {},
          },
          dependencies: { revision: () => 0, admissionRevision: () => 0 },
          eligibilityChanged: { fire() {} },
          publish() {},
          output: { appendLine() {} },
          error(error: unknown) {
            throw error;
          },
          formatting,
        },
      );
      const edits = [
        {
          range: { start: { line: 1, column: 4 }, end: { line: 1, column: 5 } },
          span: { start: 3, end: 4 },
          text: "",
        },
      ];
      let pending: Promise<unknown>;
      if (operation === "shared") {
        const snapshot = await editor.snapshot(document);
        Object.assign(editor, {
          results: {
            document: () => ({
              id: "report",
              snapshot,
              report: {
                fixes: new Map([
                  [
                    "fix",
                    { id: "fix", path: "roles/demo/defaults/main.yaml", edits },
                  ],
                ]),
              },
            }),
          },
        });
        beforeApplyPlan = () => retarget(template);
        pending = editor.applyShared(document.uri, hash(text), "fix", "report");
      } else {
        let entered!: () => void;
        const reached = new Promise<void>((done) => {
          entered = done;
        });
        enter = entered;
        pending = editor.fixAll(document.uri);
        await reached;
        beforeApplyPlan = () => retarget(template);
        release(
          JSON.stringify({
            schema_version: 1,
            path: "roles/demo/defaults/main.yaml",
            source_sha256: hash(text),
            status: "ready",
            edits,
          }),
        );
      }
      try {
        await pending;
        assert.equal(applied, 0, `${operation}: final application boundary`);
      } finally {
        beforeApplyPlan = undefined;
        formatting.dispose();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
