import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as fs from "node:fs/promises";
import { readFileSync, lstatSync } from "node:fs";
import * as syncFs from "node:fs";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import ts from "typescript";
import type * as vscode from "vscode";
import type { EditorIntegration } from "../../src/editor.ts";
import type { Navigation } from "../../src/navigation.ts";
import type {
  QueryReport,
  QueryLocation,
} from "../../src/navigation-protocol.ts";
import { parseQuery } from "../../src/navigation-protocol.ts";
import { hash, SnapshotIndex } from "../../src/protocol.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { Results } from "../../src/results.ts";

const primary = "v: \"{{ lookup('role_var', '_port', role='demo')\n }}\"";
const declarations = [
  "roles/demo/defaults/main.yml",
  "roles/demo/defaults/extra.yml",
  "roles/demo/vars/main.yml",
];
const declarationText = "# 😀é\r\ndemo_role_port: 42\r\n";
const activation = ts.createSourceFile(
  "extension.ts",
  readFileSync("src/extension.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const activate = activation.statements.find(
  (item): item is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(item) && item.name?.text === "activate",
);
const update = activate?.body?.statements.find(
  (item) =>
    ts.isVariableStatement(item) &&
    item.declarationList.declarations.some(
      (entry) => entry.name.getText(activation) === "updateProviders",
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
      'export { EditorIntegration } from "./src/editor.ts"; export { Navigation } from "./src/navigation.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "logical-yaml-endpoints",
      setup(builder) {
        builder.onResolve(
          { filter: /^vscode$|^\.\/process\.ts$/ },
          ({ path }) => ({ path, namespace: "logical-api" }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "logical-api" },
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
const uri = (filename: string) =>
  ({
    scheme: "file",
    path: filename.replaceAll("\\", "/"),
    fsPath: filename,
    toString: () => `file://${filename}`,
  }) as vscode.Uri;
class Disposable {
  private readonly cleanup: () => void;
  constructor(cleanup = () => {}) {
    this.cleanup = cleanup;
  }
  dispose() {
    this.cleanup();
  }
  static from(...items: Disposable[]) {
    return new Disposable(() => items.forEach((item) => item.dispose()));
  }
}
class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(
    a: number | { line: number; character: number },
    b: number | { line: number; character: number },
    c?: number,
    d?: number,
  ) {
    this.start =
      typeof a === "number" ? { line: a, character: b as number } : a;
    this.end = typeof b === "number" ? { line: c!, character: d! } : b;
  }
}
class Location {
  readonly uri: vscode.Uri;
  readonly range: Range;
  constructor(uri: vscode.Uri, range: Range) {
    this.uri = uri;
    this.range = range;
  }
}
class WorkspaceEdit {
  readonly entries = new Map<vscode.Uri, vscode.TextEdit[]>();
  set(uri: vscode.Uri, edits: vscode.TextEdit[]) {
    this.entries.set(uri, edits);
  }
}
function location(
  source: string,
  relative: string,
  literal: string,
): QueryLocation {
  const start = Buffer.byteLength(source.slice(0, source.indexOf(literal)));
  const span = { start, end: start + Buffer.byteLength(literal) };
  const point = new SnapshotIndex(source).span(span).start;
  // Wire columns count Unicode scalars, while editor columns count UTF-16.
  const prefix = source.split(/\r?\n/)[point.line].slice(0, point.character);
  return {
    path: relative,
    span,
    line: point.line + 1,
    column: [...prefix].length + 1,
    text: literal,
  };
}

async function fixture(saved = false, spelling = "plain") {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "saltbox-logical-endpoints-")),
  );
  const directory = path.join(root, "source");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(root, ".saltbox-lint"), "");
  for (const relative of declarations) {
    await fs.mkdir(path.dirname(path.join(root, relative)), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, relative), declarationText);
  }
  const alias = path.join(root, "alias");
  if (spelling === "parent alias")
    await fs.symlink(directory, alias, "junction");
  const filename = path.join(directory, "new.yml");
  if (saved) await fs.writeFile(filename, "saved: true\n");
  const doc = {
    uri: uri(
      path.join(spelling === "parent alias" ? alias : directory, "new.yml"),
    ),
    languageId: "yaml",
    version: 1,
    isDirty: true,
    isClosed: false,
    getText: () => primary,
  } as vscode.TextDocument;
  const documents = [doc];
  const folder = { uri: uri(root) };
  let activeRoot: string | undefined = root;
  let dependencyRevision = 0;
  let admissionRevision = 0;
  let afterWire: (() => Promise<void>) | undefined;
  let afterRead: ((filename: string) => Promise<void>) | undefined;
  let afterProbe: ((filename: string) => Promise<void>) | undefined;
  const frozenEntries = new Map<string, BigIntStats>();
  let formatter: vscode.DocumentFormattingEditProvider | undefined;
  let reference: vscode.ReferenceProvider | undefined;
  let completions = 0;
  const requests: string[][] = [];
  const applied: WorkspaceEdit[] = [];
  const errors: unknown[] = [];
  const report: QueryReport = {
    schema_version: 1,
    root,
    path: "source/new.yml",
    source_sha256: hash(primary),
    operation: "references",
    offset: Buffer.byteLength(primary.slice(0, primary.indexOf("lookup"))),
    state: "ambiguous",
    reasons: [],
    coverage: { complete: false, reasons: ["static-reads-only"] },
    origin: location(
      primary,
      "source/new.yml",
      "lookup('role_var', '_port', role='demo')",
    ),
    target_hashes: {
      "source/new.yml": hash(primary),
      ...Object.fromEntries(
        declarations.map((relative) => [relative, hash(declarationText)]),
      ),
    },
    locations: [
      {
        ...location(
          primary,
          "source/new.yml",
          "lookup('role_var', '_port', role='demo')",
        ),
        kind: "read",
      },
      ...declarations.map((relative) => ({
        ...location(declarationText, relative, "demo_role_port"),
        kind: "declaration" as const,
      })),
    ],
    declarations: declarations.map((relative) => ({
      name: "demo_role_port",
      role: "demo",
      role_path: "roles/demo",
      provenance: relative,
      key: location(declarationText, relative, "demo_role_port"),
      value: location(declarationText, relative, "42"),
      comments: [location(declarationText, relative, "# 😀é")],
    })),
    completions: [],
    dependencies: {
      schema_version: 1,
      root,
      generation: hash(primary),
      complete: true,
      sources: [
        {
          path: "source/new.yml",
          source_sha256: hash(primary),
          files: [
            { path: "source/new.yml", state: "read", sha256: hash(primary) },
            ...declarations.map((relative) => ({
              path: relative,
              state: "read" as const,
              sha256: hash(declarationText),
            })),
          ],
          identity: [],
          discovery: [],
          directories: [],
        },
      ],
    },
  };
  assert.doesNotThrow(() =>
    parseQuery(
      JSON.stringify(report),
      root,
      report.path,
      primary,
      "references",
      report.offset,
    ),
  );
  const api = {
    Disposable,
    Range,
    Location,
    WorkspaceEdit,
    RelativePattern: class {
      readonly baseUri: vscode.Uri;
      readonly pattern: string;
      constructor(baseUri: vscode.Uri, pattern: string) {
        this.baseUri = baseUri;
        this.pattern = pattern;
      }
    },
    Uri: { file: uri },
    CodeActionKind: { QuickFix: {}, SourceFixAll: { append: () => ({}) } },
    TextEdit: {
      replace: (range: Range, newText: string) => ({ range, newText }),
    },
    window: { setStatusBarMessage: () => new Disposable() },
    workspace: {
      isTrusted: true,
      textDocuments: documents,
      getWorkspaceFolder: () => folder,
      registerTextDocumentContentProvider: () => new Disposable(),
      applyEdit: async (edit: WorkspaceEdit) => {
        applied.push(edit);
        return true;
      },
    },
    languages: {
      registerCodeActionsProvider: () => new Disposable(),
      registerDefinitionProvider: () => new Disposable(),
      registerHoverProvider: () => new Disposable(),
      registerReferenceProvider: (
        _selector: unknown,
        provider: vscode.ReferenceProvider,
      ) => {
        reference = provider;
        return new Disposable(() => {
          reference = undefined;
        });
      },
      registerCompletionItemProvider: () => {
        completions++;
        return new Disposable(() => {
          completions--;
        });
      },
      registerDocumentFormattingEditProvider: (
        _selector: unknown,
        provider: vscode.DocumentFormattingEditProvider,
      ) => {
        formatter = provider;
        return new Disposable(() => {
          formatter = undefined;
        });
      },
    },
    runProcess: async (request: { args: string[]; input: string }) => {
      requests.push(request.args);
      assert.equal(request.input, primary);
      const wire =
        request.args[0] === "query"
          ? JSON.stringify(report)
          : JSON.stringify({
              schema_version: 1,
              path: "source/new.yml",
              source_sha256: hash(primary),
              status: "ready",
              edits: [
                {
                  range: {
                    start: { line: 1, column: primary.indexOf("\n") + 1 },
                    end: { line: 2, column: 1 },
                  },
                  span: {
                    start: primary.indexOf("\n"),
                    end: primary.indexOf("\n") + 1,
                  },
                  text: "",
                },
              ],
            });
      await afterWire?.();
      return wire;
    },
  };
  const originalRequire = createRequire(import.meta.url);
  const module = {
    exports: {} as {
      EditorIntegration: typeof EditorIntegration;
      Navigation: typeof Navigation;
    },
  };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) =>
      name === "node:fs/promises"
        ? {
            ...fs,
            realpath: async (filename: string) => {
              const canonical = await fs.realpath(filename);
              await afterProbe?.(filename);
              return canonical;
            },
            readFile: async (filename: string) => {
              const bytes = await fs.readFile(filename);
              await afterRead?.(filename);
              return bytes;
            },
          }
        : name === "node:fs"
          ? {
              ...syncFs,
              lstatSync: (filename: string, options: { bigint: true }) =>
                frozenEntries.get(filename) ?? lstatSync(filename, options),
            }
          : originalRequire(name),
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    api,
  });
  const formatting = new Scheduler();
  const lane = new Scheduler();
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as Pick<
      EditorIntegration,
      "fixAll" | "format" | "providerDocuments" | "writable" | "navigation"
    > & {
      admit(document: vscode.TextDocument): Promise<boolean>;
    },
    {
      disposed: false,
      executable: "controlled-cli",
      closedTabs: new Set(),
      sourceOwners: new Map(),
      canonicalRoots: new Map(),
      documentFolders: new Map(),
      checking: new Map(),
      rootRevisions: new Map(),
      documentRevisions: new WeakMap(),
      nextRevision: 0,
      queryRevision: 0,
      relatedRevision: 0,
      formatting,
      lint: new Scheduler(),
      queryLanes: new Map([["references", lane]]),
      failures: new Map(),
      results: new Results(),
      collection: { delete() {} },
      fileFingerprints: new Map(),
      pendingDiskReload: new Set(),
      missingFiles: new Map(),
      pendingFiles: new Map(),
      roots: {
        ready: async () => {},
        refresh: async () => {},
        get: () => activeRoot,
        watchSource() {},
        forgetSource() {},
      },
      dependencies: {
        begin: () => admissionRevision,
        revision: () => dependencyRevision,
        admissionRevision: () => admissionRevision,
        remove() {},
      },
      eligibilityChanged: { fire() {} },
      publish() {},
      updateStatus() {},
      output: { appendLine() {} },
      error(error: unknown) {
        errors.push(error);
      },
    },
  );
  Reflect.set(
    editor,
    "navigation",
    new module.exports.Navigation((...args) =>
      Reflect.apply(Reflect.get(editor, "query"), editor, args),
    ),
  );
  const providers = new Map<string, { disposable: Disposable }>();
  const context = {
    vscode: api,
    path,
    editor,
    providers,
    refresh: undefined as (() => void) | undefined,
  };
  runInNewContext(registrationCode, context);
  const refresh = context.refresh!;
  Reflect.set(editor, "eligibilityChanged", { fire: refresh });
  assert.equal(await editor.admit(doc), true);
  const cancellation = new AbortController();
  const token = {
    get isCancellationRequested() {
      return cancellation.signal.aborted;
    },
    onCancellationRequested(listener: (event: unknown) => unknown) {
      const callback = () => {
        listener(undefined);
      };
      cancellation.signal.addEventListener("abort", callback);
      return new Disposable(() =>
        cancellation.signal.removeEventListener("abort", callback),
      );
    },
  } as vscode.CancellationToken;
  return {
    root,
    directory,
    alias,
    filename,
    doc,
    editor,
    report,
    documents,
    api,
    errors,
    requests,
    applied,
    token,
    format: () =>
      Promise.resolve(
        formatter?.provideDocumentFormattingEdits(
          doc,
          { tabSize: 2, insertSpaces: true },
          token,
        ) ?? [],
      ),
    references: () =>
      Promise.resolve(
        reference?.provideReferences(
          doc,
          { line: 0, character: primary.indexOf("lookup") } as vscode.Position,
          { includeDeclaration: true },
          token,
        ) ?? [],
      ),
    afterWire(callback: typeof afterWire) {
      afterWire = callback;
    },
    afterRead(callback: typeof afterRead) {
      afterRead = callback;
    },
    afterProbe(callback: typeof afterProbe) {
      afterProbe = callback;
    },
    freezeEntry(filename: string) {
      frozenEntries.set(filename, lstatSync(filename, { bigint: true }));
    },
    rootValue(value: string | undefined) {
      activeRoot = value;
    },
    reviseDependency() {
      dependencyRevision++;
    },
    reviseAdmission() {
      admissionRevision++;
    },
    cancel() {
      cancellation.abort();
      formatting.cancel(doc.uri.toString());
    },
    providerCounts: () => ({ formatter: !!formatter, completions }),
    refresh,
    async dispose() {
      editor.navigation.dispose();
      formatting.dispose();
      lane.dispose();
      (Reflect.get(editor, "lint") as Scheduler).dispose();
      for (const entry of providers.values()) entry.disposable.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

for (const kind of [
  "never-saved template",
  "canonical template alias",
] as const) {
  test(`${kind} retains read-only formatter, Fix All and completion policy`, async () => {
    const f = await fixture();
    try {
      const template = path.join(f.root, "roles/demo/templates/new.yml");
      await fs.mkdir(path.dirname(template), { recursive: true });
      const alias = path.join(f.root, "hidden.yml");
      if (kind === "canonical template alias") {
        await fs.writeFile(template, primary);
        await fs.symlink(template, alias, "file");
      }
      const doc = {
        ...f.doc,
        uri: uri(kind === "canonical template alias" ? alias : template),
      } as vscode.TextDocument;
      f.documents.splice(0, f.documents.length, doc);
      assert.equal(
        await f.editor.admit(doc),
        kind === "canonical template alias",
      );
      f.refresh();
      assert.deepEqual(f.providerCounts(), {
        formatter: false,
        completions: 0,
      });
      for (const mode of ["canonical", "lint-fixes"] as const)
        assert.equal((await f.editor.format(doc, mode)).length, 0);
      await f.editor.fixAll(doc.uri);
      assert.equal(f.requests.length, 0);
      assert.equal(f.applied.length, 0);
      assert.equal(f.errors.length, 0);
      if (kind === "canonical template alias")
        assert.equal(await fs.readFile(template, "utf8"), primary);
      else await assert.rejects(fs.lstat(template), { code: "ENOENT" });
    } finally {
      await f.dispose();
    }
  });
}

for (const mutation of [
  "primary hash",
  "primary span",
  "declaration hash",
  "declaration span",
] as const) {
  test(`never-saved YAML References refuses an incorrect captured ${mutation}`, async () => {
    const f = await fixture();
    try {
      if (mutation === "primary hash")
        f.report.target_hashes[f.report.path] = hash(primary + "\n");
      if (mutation === "primary span") f.report.locations[0].span.start++;
      if (mutation === "declaration hash") {
        const digest = hash(declarationText.replace("42", "43"));
        f.report.target_hashes[declarations[0]] = digest;
        f.report.dependencies.sources[0].files[1].sha256 = digest;
      }
      if (mutation === "declaration span")
        f.report.declarations[0].key.span.start++;
      assert.equal((await f.references())?.length, 0);
      assert.equal(f.requests.length, 1);
      assert.equal(f.errors.length, 0);
    } finally {
      await f.dispose();
    }
  });
}

const mutations = [
  "version",
  "text",
  "closed",
  "canceled",
  "trust",
  "marker",
  "configuration",
  "configured root",
  "root revision",
  "dependency revision",
  "document revision",
  "physical owner",
  "dangling leaf alias",
  "escaping leaf alias",
  "admin leaf alias",
  "replaced parent",
  "replaced root",
  "retargeted parent alias",
  "replaced parent alias",
] as const;
for (const endpoint of ["format", "fix all", "references"] as const) {
  for (const mutation of [
    ...mutations,
    ...(endpoint === "references"
      ? (["query revision", "admission revision"] as const)
      : []),
  ]) {
    test(`never-saved YAML ${endpoint} refuses ${mutation} after the captured request`, async () => {
      const f = await fixture(
        false,
        mutation.includes("parent alias") ? "parent alias" : "plain",
      );
      try {
        let reached = false;
        f.afterWire(async () => {
          reached = true;
          switch (mutation) {
            case "version":
              Reflect.set(f.doc, "version", 2);
              break;
            case "text":
              Reflect.set(f.doc, "getText", () => primary + "\n");
              break;
            case "closed":
              Reflect.set(f.doc, "isClosed", true);
              break;
            case "canceled":
              f.cancel();
              break;
            case "trust":
              f.api.workspace.isTrusted = false;
              break;
            case "marker":
              await fs.rm(path.join(f.root, ".saltbox-lint"));
              break;
            case "configuration":
              f.rootValue(undefined);
              break;
            case "configured root":
              f.rootValue(f.directory);
              break;
            case "root revision":
              Reflect.get(f.editor, "rootRevisions").set(
                `file://${f.root}`,
                1000,
              );
              break;
            case "dependency revision":
              f.reviseDependency();
              break;
            case "document revision":
              Reflect.get(f.editor, "documentRevisions").set(f.doc, 1000);
              break;
            case "query revision":
              Reflect.set(f.editor, "queryRevision", 1000);
              break;
            case "admission revision":
              f.reviseAdmission();
              break;
            case "physical owner":
              await fs.writeFile(f.filename, primary);
              break;
            case "dangling leaf alias":
              await fs.symlink(
                path.join(f.root, "absent.yml"),
                f.filename,
                "file",
              );
              break;
            case "escaping leaf alias":
              await fs.symlink(
                path.join(f.root, "..", "absent.yml"),
                f.filename,
                "file",
              );
              break;
            case "admin leaf alias":
              await fs.mkdir(path.join(f.root, ".git"));
              await fs.writeFile(
                path.join(f.root, ".git", "config.yml"),
                primary,
              );
              await fs.symlink(
                path.join(f.root, ".git", "config.yml"),
                f.filename,
                "file",
              );
              break;
            case "replaced parent":
              await fs.rename(f.directory, f.directory + "-old");
              await fs.mkdir(f.directory);
              break;
            case "replaced root":
              await fs.rm(f.root, { recursive: true });
              await fs.mkdir(f.directory, { recursive: true });
              break;
            case "retargeted parent alias":
              await fs.mkdir(path.join(f.root, "other"));
              await fs.rm(f.alias);
              await fs.symlink(path.join(f.root, "other"), f.alias, "junction");
              break;
            case "replaced parent alias":
              await fs.rm(f.alias);
              await fs.symlink(f.directory, f.alias, "junction");
              break;
          }
        });
        if (endpoint === "format") assert.equal((await f.format())?.length, 0);
        if (endpoint === "fix all") {
          await f.editor.fixAll(f.doc.uri);
          assert.equal(f.applied.length, 0);
        }
        if (endpoint === "references")
          assert.equal((await f.references())?.length, 0);
        assert.equal(
          reached,
          true,
          "the control must reach the endpoint response seam",
        );
        assert.equal(f.requests.length, 1);
        assert.equal(f.errors.length, 0);
      } finally {
        await f.dispose();
      }
    });
  }
}

for (const endpoint of ["format", "fix all", "references"] as const) {
  test(`a disappeared physical YAML owner cannot become logical in repeated ${endpoint} requests`, async () => {
    const f = await fixture(true);
    try {
      await fs.rm(f.filename);
      for (let i = 0; i < 2; i++) {
        if (endpoint === "format")
          assert.equal((await f.editor.format(f.doc, "canonical")).length, 0);
        if (endpoint === "fix all") {
          await f.editor.fixAll(f.doc.uri);
          assert.equal(f.applied.length, 0);
        }
        if (endpoint === "references")
          assert.equal(
            await Reflect.apply(Reflect.get(f.editor, "query"), f.editor, [
              f.doc,
              { line: 0, character: primary.indexOf("lookup") },
              "references",
            ]),
            undefined,
          );
      }
      assert.equal(f.requests.length, 0);
      assert.equal(f.errors.length, 0);
    } finally {
      await f.dispose();
    }
  });
  test(`saved YAML ${endpoint} retains buffer edits and captured declaration hashes`, async () => {
    const f = await fixture(true);
    try {
      if (endpoint === "format") assert.equal((await f.format())?.length, 1);
      if (endpoint === "fix all") {
        await f.editor.fixAll(f.doc.uri);
        assert.equal(f.applied.length, 1);
      }
      if (endpoint === "references")
        assert.equal((await f.references())?.length, 4);
      assert.equal(f.requests.length, 1);
      assert.equal(f.errors.length, 0);
      assert.equal(await fs.readFile(f.filename, "utf8"), "saved: true\n");
    } finally {
      await f.dispose();
    }
  });
}

for (const mutation of [
  "logical owner",
  "earlier saved hash",
  "earlier buffer",
  "parent alias",
] as const) {
  test(`References rechecks ${mutation} after a later saved target read yields`, async () => {
    const f = await fixture(
      false,
      mutation === "parent alias" ? "parent alias" : "plain",
    );
    try {
      let reads = 0;
      f.afterRead(async (filename) => {
        if (filename !== path.join(f.root, declarations[2]) || ++reads !== 3)
          return;
        if (mutation === "logical owner")
          await fs.writeFile(f.filename, primary);
        if (mutation === "earlier saved hash")
          await fs.writeFile(
            path.join(f.root, declarations[0]),
            declarationText.replace("42", "43"),
          );
        if (mutation === "earlier buffer")
          f.documents.push({
            ...f.doc,
            uri: uri(path.join(f.root, declarations[0])),
            getText: () => declarationText.replace("42", "43"),
          } as vscode.TextDocument);
        if (mutation === "parent alias") {
          await fs.rm(f.alias);
          await fs.symlink(f.directory, f.alias, "junction");
        }
      });
      assert.equal((await f.references())?.length, 0);
      assert.equal(
        reads,
        3,
        "observe, map and final target validation must read the later saved declaration",
      );
      assert.equal(f.requests.length, 1);
      assert.equal(f.errors.length, 0);
    } finally {
      await f.dispose();
    }
  });
}

for (const mutation of [
  "unchanged",
  "saved hash",
  "saved hash with unchanged metadata",
  "saved owner",
  "saved buffer",
  "canceled",
  "version",
] as const) {
  test(`References fences ${mutation} during the post-target logical-source probe`, async () => {
    const f = await fixture();
    try {
      let reads = 0;
      let finalProbe = false;
      let finalTargetProbes = 0;
      f.afterRead(async (filename) => {
        if (filename === path.join(f.root, declarations[2])) reads++;
      });
      f.afterProbe(async (filename) => {
        // After the fourth saved-target read, sourceCurrent checks the last
        // saved target twice, before and after its root/fingerprint probes.
        // The next root probe is the separate final logical-source check.
        if (reads === 4 && filename === path.join(f.root, declarations[2]))
          finalTargetProbes++;
        if (
          reads !== 4 ||
          finalTargetProbes !== 2 ||
          filename !== f.root ||
          finalProbe
        )
          return;
        finalProbe = true;
        const target = path.join(f.root, declarations[0]);
        if (mutation === "canceled") f.cancel();
        if (mutation === "version") Reflect.set(f.doc, "version", 2);
        if (mutation === "saved hash with unchanged metadata")
          f.freezeEntry(target);
        if (
          mutation === "saved hash" ||
          mutation === "saved hash with unchanged metadata"
        )
          await fs.writeFile(target, declarationText.replace("42", "43"));
        if (mutation === "saved owner") {
          await fs.rename(target, target + ".old");
          await fs.writeFile(target, declarationText);
        }
        if (mutation === "saved buffer")
          f.documents.push({
            ...f.doc,
            uri: uri(target),
            getText: () => declarationText.replace("42", "43"),
          } as vscode.TextDocument);
      });
      assert.equal(
        (await f.references())?.length,
        mutation === "unchanged" ? 4 : 0,
      );
      assert.equal(
        finalProbe,
        true,
        "the last logical probe must be reached after target validation",
      );
      assert.equal(reads, 4);
      assert.equal(f.requests.length, 1);
      assert.equal(f.errors.length, 0);
    } finally {
      await f.dispose();
    }
  });
}

for (const spelling of ["plain", "parent alias"]) {
  for (const endpoint of ["format", "fix all", "references"] as const) {
    test(`never-saved YAML ${spelling} ${endpoint} accepts the captured buffer through the actual endpoint`, async () => {
      const f = await fixture(false, spelling);
      try {
        await assert.rejects(fs.lstat(f.filename), { code: "ENOENT" });
        assert.equal(
          Reflect.get(f.editor, "sourceOwners").get(f.doc.uri.toString())
            .physical,
          false,
        );
        assert.deepEqual(f.providerCounts(), {
          formatter: true,
          completions: 1,
        });
        if (endpoint === "format") assert.equal((await f.format())?.length, 1);
        if (endpoint === "fix all") {
          await f.editor.fixAll(f.doc.uri);
          assert.equal(f.applied.length, 1);
          assert.equal(f.applied[0].entries.get(f.doc.uri)?.length, 1);
        }
        if (endpoint === "references") {
          const result = await f.references();
          assert.equal(result?.length, 4);
          assert.equal(result?.[0].uri.toString(), f.doc.uri.toString());
          assert.deepEqual(result?.[0].range.start, {
            line: 0,
            character: primary.indexOf("lookup"),
          });
          for (const item of result?.slice(1) ?? [])
            assert.deepEqual(item.range.start, { line: 1, character: 0 });
        }
        assert.equal(f.requests.length, 1);
        assert.equal(f.errors.length, 0);
        await assert.rejects(fs.lstat(f.filename), { code: "ENOENT" });
        for (const relative of declarations)
          assert.equal(
            await fs.readFile(path.join(f.root, relative), "utf8"),
            declarationText,
          );
      } finally {
        await f.dispose();
      }
    });
  }
}
