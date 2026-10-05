import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type * as vscode from "vscode";
import type { EditorIntegration } from "../../src/editor.ts";
import type { gateFormatterSource } from "../host/formatter-source-gate.ts";
import { hash } from "../../src/protocol.ts";
import { Scheduler } from "../../src/scheduler.ts";
import ts from "typescript";

// Execute the current activation registration callback, rather than supplying
// a formatter when the production ownership policy would register none.
const activation = ts.createSourceFile(
  "extension.ts",
  readFileSync("src/extension.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const activate = activation.statements.find(
  (statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "activate",
);
const update = activate?.body?.statements.find(
  (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) =>
        declaration.name.getText(activation) === "updateProviders",
    ),
);
assert.ok(update);
const registrationCode = ts.transpileModule(
  update.getText(activation) + "; globalThis.refresh = updateProviders;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

const bundled = await build({
  stdin: {
    contents:
      'export { EditorIntegration } from "./src/editor.ts"; export { gateFormatterSource } from "./test/host/formatter-source-gate.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "formatter-gate-api",
      setup(builder) {
        builder.onResolve(
          { filter: /^vscode$|^\.\/process\.ts$/ },
          ({ path }) => ({ path, namespace: "formatter-gate-api" }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "formatter-gate-api" },
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

test("the public formatter gate owns its source read independently of background admission and preserves production write guards", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "saltbox-formatter-gate-")),
  );
  const physicalRoot = join(root, "external-root");
  const alias = join(root, "external");
  const source = join(alias, "[value]{one}.yml");
  const sourceIdentity = join(physicalRoot, "[value]{one}.yml");
  const template = join(physicalRoot, "roles/example/templates/config.yaml");
  const text = "a:  1\n";
  const uri = (filename: string) =>
    ({
      scheme: "file",
      path: filename.replaceAll("\\", "/"),
      fsPath: filename,
      toString: () => `file://${filename}`,
    }) as vscode.Uri;
  const folder = { uri: uri(root) };
  let provider: vscode.DocumentFormattingEditProvider | undefined;
  let requests = 0;
  class Disposable {
    private readonly cleanup: () => void;
    constructor(cleanup: () => void) {
      this.cleanup = cleanup;
    }
    dispose() {
      this.cleanup();
    }
    static from(...disposables: Disposable[]) {
      return new Disposable(() =>
        disposables.forEach((item) => item.dispose()),
      );
    }
  }
  class RelativePattern {
    readonly baseUri: vscode.Uri;
    readonly pattern: string;
    constructor(baseUri: vscode.Uri, pattern: string) {
      this.baseUri = baseUri;
      this.pattern = pattern;
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
  class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(start: Position, end: Position) {
      this.start = start;
      this.end = end;
    }
  }
  const documents: vscode.TextDocument[] = [];
  const noopRegistration = () => new Disposable(() => {});
  const api = {
    workspace: {
      isTrusted: true,
      textDocuments: documents,
      getWorkspaceFolder: () => folder,
    },
    languages: {
      registerDocumentFormattingEditProvider(
        _selector: vscode.DocumentSelector,
        actual: vscode.DocumentFormattingEditProvider,
      ) {
        provider = actual;
        return new Disposable(() => {
          provider = undefined;
        });
      },
      match(selector: vscode.DocumentSelector, document: vscode.TextDocument) {
        const entries = Array.isArray(selector) ? selector : [selector];
        return entries.some(
          (entry) =>
            typeof entry !== "string" &&
            entry.language === document.languageId &&
            entry.pattern instanceof RelativePattern &&
            entry.pattern.baseUri.fsPath === path.dirname(document.uri.fsPath),
        )
          ? 10
          : 0;
      },
      registerCodeActionsProvider: noopRegistration,
      registerDefinitionProvider: noopRegistration,
      registerHoverProvider: noopRegistration,
      registerReferenceProvider: noopRegistration,
      registerCompletionItemProvider: noopRegistration,
    },
    Disposable,
    RelativePattern,
    CodeActionKind: {
      QuickFix: {},
      SourceFixAll: { append: () => ({}) },
    },
    Uri: { file: uri },
    Position,
    Range,
    TextEdit: {
      replace: (range: Range, newText: string) => ({ range, newText }),
    },
    runProcess: async () => {
      requests++;
      return JSON.stringify({
        schema_version: 1,
        path: "[value]{one}.yml",
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
    },
  };
  const module = {
    exports: {} as {
      EditorIntegration: typeof EditorIntegration;
      gateFormatterSource: typeof gateFormatterSource;
    },
  };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    __filename: import.meta.filename,
    require: createRequire(import.meta.url),
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    api,
  });
  const formatting = new Scheduler();
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as Pick<
      EditorIntegration,
      "format" | "providerDocuments"
    > & { admit(document: vscode.TextDocument): Promise<boolean> },
    {
      disposed: false,
      executable: "controlled-cli-boundary",
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
        get: () => physicalRoot,
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
  const activationContext = {
    vscode: api,
    path,
    editor,
    providers: new Map(),
    refresh: undefined as (() => void) | undefined,
  };
  runInNewContext(registrationCode, activationContext);
  const refresh = activationContext.refresh!;
  Reflect.set(editor, "eligibilityChanged", { fire: refresh });
  const backgroundFilesystem = createRequire(import.meta.url)(
    "node:fs/promises",
  ) as typeof fs;
  const actualFormat = editor.format.bind(editor);
  try {
    await fs.mkdir(physicalRoot);
    await fs.symlink(physicalRoot, alias, "junction");
    await fs.writeFile(source, text);
    await fs.mkdir(join(physicalRoot, "roles/example/templates"), {
      recursive: true,
    });
    await fs.writeFile(template, text);
    for (const mode of ["canonical", "lint-fixes"] as const) {
      for (const state of [
        "stable",
        "closed",
        "changed version",
        "canceled",
      ] as const) {
        const document = {
          uri: uri(source),
          languageId: "ansible",
          version: 1,
          isClosed: false,
          isDirty: false,
          getText: () => text,
        } as vscode.TextDocument;
        documents.splice(0, documents.length, document);
        Reflect.get(editor, "sourceOwners").clear();
        refresh();
        assert.equal(editor.providerDocuments().length, 0);
        const gate = module.exports.gateFormatterSource(
          document.uri,
          sourceIdentity,
          api as unknown as typeof vscode,
        );
        const canceled = new AbortController();
        const token = {
          get isCancellationRequested() {
            return canceled.signal.aborted;
          },
          onCancellationRequested(listener: (event: unknown) => unknown) {
            const callback = () => {
              listener(undefined);
            };
            canceled.signal.addEventListener("abort", callback);
            return new Disposable(() =>
              canceled.signal.removeEventListener("abort", callback),
            );
          },
        };
        let pending: Promise<vscode.TextEdit[] | undefined | null> | undefined;
        try {
          assert.equal(gate.registered(document), false);
          assert.equal(
            provider,
            undefined,
            "unadmitted models have no public formatter",
          );
          const invoke = () =>
            Promise.resolve(
              provider?.provideDocumentFormattingEdits(
                document,
                { tabSize: 2, insertSpaces: true },
                token,
              ) ?? [],
            );
          const realpathDescriptor = Object.getOwnPropertyDescriptor(
            backgroundFilesystem,
            "realpath",
          )!;
          const originalRealpath = backgroundFilesystem.realpath;
          let admitSource!: () => void;
          const admittingSource = new Promise<void>((resolve) => {
            admitSource = resolve;
          });
          let releaseAdmission!: () => void;
          const admissionGate = new Promise<void>((resolve) => {
            releaseAdmission = resolve;
          });
          Object.defineProperty(backgroundFilesystem, "realpath", {
            ...realpathDescriptor,
            value: async (...args: Parameters<typeof originalRealpath>) => {
              const resolved = await originalRealpath(...args);
              if (resolved !== sourceIdentity) return resolved;
              admitSource();
              await admissionGate;
              return resolved;
            },
          });
          const admitting = editor.admit(document);
          // This is the original failed race's registration precondition. A
          // public formatting command can settle without a second identity read
          // when the new language model has not yet been admitted.
          try {
            await admittingSource;
            assert.equal(editor.providerDocuments().length, 0);
            assert.equal(provider, undefined);
            const originalRace = await Promise.race([
              gate.entered.then(() => "identity"),
              invoke().then(() => "settled"),
            ]);
            assert.equal(originalRace, "settled");
            assert.throws(() => assert.equal(originalRace, "identity"));
          } finally {
            releaseAdmission();
            Object.defineProperty(
              backgroundFilesystem,
              "realpath",
              realpathDescriptor,
            );
            await Promise.allSettled([admitting]);
          }
          assert.equal(await admitting, true);
          assert.equal(editor.providerDocuments().includes(document), true);
          assert.ok(gate.counts().automaticEntries > 0);
          assert.equal(gate.registered(document), true);
          // Production registration requests canonical formatting. Exercise the
          // same actual method's second mode without changing registration policy.
          editor.format = (doc, _mode, token) => actualFormat(doc, mode, token);
          let settled = false;
          pending = invoke().then((edits) => {
            settled = true;
            return edits;
          });
          await gate.entered;
          assert.equal(settled, false);
          assert.equal(gate.counts().invocations, 1);
          assert.equal(gate.counts().formatterEntries, 1);
          const before = gate.counts().automaticEntries;
          assert.equal(
            await backgroundFilesystem.realpath(source),
            sourceIdentity,
          );
          assert.equal(gate.counts().automaticEntries, before + 1);
          assert.equal(
            settled,
            false,
            "background reads cannot release a formatter",
          );
          if (state === "closed") Reflect.set(document, "isClosed", true);
          if (state === "changed version") Reflect.set(document, "version", 2);
          if (state === "canceled") canceled.abort();
          const beforeRequests = requests;
          gate.release();
          const edits = await pending;
          assert.equal(edits?.length, state === "stable" ? 1 : 0);
          assert.equal(requests - beforeRequests, state === "stable" ? 1 : 0);
          if (state === "stable") {
            await gate.dispose();
            const counts = gate.counts();
            assert.equal((await invoke())?.length, 1);
            assert.deepEqual(gate.counts(), counts);
          }
          Reflect.set(document, "isClosed", true);
          refresh();
          assert.equal(gate.registered(document), false);
        } finally {
          await gate.dispose();
          if (pending) await Promise.allSettled([pending]);
        }
      }
    }
    const templateDocument = {
      uri: uri(template),
      languageId: "yaml",
      version: 1,
      isClosed: false,
      getText: () => text,
    } as vscode.TextDocument;
    documents.splice(0, documents.length, templateDocument);
    assert.equal(await editor.admit(templateDocument), true);
    assert.equal(provider, undefined, "admitted templates get no formatter");
    const before = requests;
    for (const mode of ["canonical", "lint-fixes"] as const)
      assert.equal((await editor.format(templateDocument, mode)).length, 0);
    assert.equal(requests, before);
    assert.equal(await fs.readFile(template, "utf8"), text);
  } finally {
    formatting.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
