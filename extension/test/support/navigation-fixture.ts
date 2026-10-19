import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type * as vscode from "vscode";
import type { EditorIntegration, EditorAdapters } from "../../src/editor.ts";
import type { ProcessRequest } from "../../src/process.ts";
import type {
  QueryReport,
  QueryOperation,
} from "../../src/navigation-protocol.ts";
import { hash } from "../../src/protocol.ts";
import { TestResources, withTestResources } from "./test-resources.ts";
import { ownJoinedResource } from "./host-resources.ts";
import type {
  ProviderRegistration,
  updateProviders,
} from "../../src/providers.ts";

export const sourceText =
  "value: \"{{ lookup('role_var', '_port', role='target') }}\"\n";
export const targetText = "target_role_port: 42\n";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const bundle = build({
  stdin: {
    contents:
      'export { EditorIntegration } from "./src/editor.ts"; export { updateProviders } from "./src/providers.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "vscode-runtime-adapter",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "vscode-runtime-adapter",
        }));
        builder.onLoad(
          { filter: /.*/, namespace: "vscode-runtime-adapter" },
          () => ({
            contents: "module.exports = globalThis.vscodeAdapter",
            loader: "js",
          }),
        );
      },
    },
  ],
}).then((result) => result.outputFiles[0].text);

class Disposable {
  private readonly release: () => void;
  constructor(release = () => {}) {
    this.release = release;
  }
  dispose() {
    this.release();
  }
  static from(...items: { dispose(): unknown }[]) {
    return new Disposable(() => items.forEach((item) => item.dispose()));
  }
}
class Emitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();
  readonly event = (listener: (value: T) => unknown) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value: T) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}
class URI {
  readonly fsPath: string;
  readonly scheme: string;
  readonly path: string;
  constructor(fsPath: string, scheme = "file") {
    this.fsPath = fsPath;
    this.scheme = scheme;
    this.path = fsPath.replaceAll("\\", "/");
  }
  toString() {
    return `file://${this.fsPath}`;
  }
  static file(filename: string) {
    return new URI(filename);
  }
  static parse(value: string) {
    return new URI(value.replace(/^file:\/\//, ""));
  }
  static from(value: { scheme: string; path: string }) {
    return new URI(value.path, value.scheme);
  }
}
export function fixtureUri(filename: string): vscode.Uri {
  return URI.file(filename) as vscode.Uri;
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
  constructor(a: number, b: number, c: number, d: number) {
    this.start = new Position(a, b);
    this.end = new Position(c, d);
  }
}
class Location {
  readonly uri: URI;
  readonly range: Range;
  constructor(uri: URI, range: Range) {
    this.uri = uri;
    this.range = range;
  }
}
export class FixtureDocument {
  readonly uri: vscode.Uri;
  private text: string;
  readonly languageId = "yaml";
  readonly eol = 1;
  isClosed = false;
  isDirty = false;
  version = 1;
  reads = 0;
  constructor(uri: vscode.Uri, text: string) {
    this.uri = uri;
    this.text = text;
  }
  getText() {
    this.reads++;
    return this.text;
  }
  positionAt(offset: number) {
    return new Position(0, offset) as vscode.Position;
  }
  edit(text: string) {
    this.text = text;
    this.version++;
    this.isDirty = true;
  }
  asDocument() {
    return this as unknown as vscode.TextDocument;
  }
}

export interface NavigationFixture {
  root: string;
  source: string;
  target: string;
  document: FixtureDocument;
  targetDocument: FixtureDocument;
  editor: EditorIntegration;
  resources: TestResources;
  lines: string[];
  notices: string[];
  position: vscode.Position;
  wire(request: ProcessRequest): string;
  refreshProviders(): void;
  formatter(): vscode.DocumentFormattingEditProvider | undefined;
  focus(document: FixtureDocument): void;
  removeWorkspace(): void;
  setWorkspaceFolders(paths: readonly string[]): void;
}

/** The only replaced import is the editor-provided vscode module. */
export async function withNavigationFixture<T>(
  adapters: Partial<EditorAdapters>,
  body: (fixture: NavigationFixture) => Promise<T>,
  options: {
    acceptedOperations?: readonly string[];
    waitForReady?: boolean;
    workspaceAlias?: boolean;
  } = {},
): Promise<T> {
  return withTestResources({ cleanupTimeoutMs: 5000 }, async (resources) => {
    const directory = await mkdtemp(
      join(tmpdir(), "saltbox-navigation-pilot-"),
    );
    resources.defer("navigation files", () =>
      rm(directory, { recursive: true, force: true }),
    );
    let root = await realpath(directory);
    if (options.workspaceAlias) {
      const native = join(root, "native");
      const publicPath = join(root, "public");
      await mkdir(native);
      await symlink(
        native,
        publicPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      root = publicPath;
    }
    const source = join(root, "roles/source/tasks/main.yml");
    const target = join(root, "roles/target/defaults/main.yml");
    await mkdir(join(source, ".."), { recursive: true });
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(source, sourceText);
    await writeFile(target, targetText);
    await writeFile(join(root, ".saltbox-lint"), "");
    const document = new FixtureDocument(
      URI.file(source) as vscode.Uri,
      sourceText,
    );
    const targetDocument = new FixtureDocument(
      URI.file(target) as vscode.Uri,
      targetText,
    );
    const documents = [document.asDocument(), targetDocument.asDocument()];
    const folder = { uri: URI.file(root) };
    let folders = [folder];
    let explicitFolders = false;
    let workspaceVisible = true;
    const lines: string[] = [],
      notices: string[] = [];
    const listener = () => new Disposable();
    const activeChanged = new Emitter<{ document: vscode.TextDocument }>();
    resources.defer("fixture active editor events", () =>
      activeChanged.dispose(),
    );
    const watcher = () => ({
      dispose() {},
      onDidCreate: listener,
      onDidChange: listener,
      onDidDelete: listener,
    });
    const formatters: {
      selector: vscode.DocumentSelector;
      provider: vscode.DocumentFormattingEditProvider;
      active: boolean;
    }[] = [];
    const registrations = new Map<string, ProviderRegistration>();
    resources.defer("fixture providers", () => {
      for (const registration of registrations.values())
        registration.disposable.dispose();
      registrations.clear();
    });
    const api = {
      Uri: URI,
      Position,
      Range,
      Location,
      Disposable,
      EventEmitter: Emitter,
      CodeActionKind: { QuickFix: {}, SourceFixAll: { append: () => ({}) } },
      TextEdit: {
        replace: (range: vscode.Range, newText: string) => ({ range, newText }),
      },
      RelativePattern: class {
        readonly baseUri: URI;
        readonly pattern: string;
        constructor(baseUri: URI, pattern: string) {
          this.baseUri = baseUri;
          this.pattern = pattern;
        }
      },
      StatusBarAlignment: { Left: 1 },
      workspace: {
        isTrusted: true,
        get workspaceFolders() {
          return workspaceVisible ? folders : [];
        },
        textDocuments: documents,
        getWorkspaceFolder: (uri: URI) => {
          if (!workspaceVisible) return undefined;
          if (!explicitFolders) return folder;
          return folders
            .filter((candidate) => {
              const path = relative(candidate.uri.fsPath, uri.fsPath);
              return (
                path !== ".." &&
                !path.startsWith(`..${sep}`) &&
                !isAbsolute(path)
              );
            })
            .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
        },
        getConfiguration: () => ({
          get: (_key: string, fallback: unknown) => fallback,
        }),
        createFileSystemWatcher: watcher,
        registerTextDocumentContentProvider: listener,
        openTextDocument: async (uri: URI) => ({ uri }),
        onDidChangeConfiguration: listener,
      },
      languages: {
        registerHoverProvider: listener,
        registerCodeActionsProvider: listener,
        registerDefinitionProvider: listener,
        registerReferenceProvider: listener,
        registerCompletionItemProvider: listener,
        registerDocumentFormattingEditProvider(
          selector: vscode.DocumentSelector,
          provider: vscode.DocumentFormattingEditProvider,
        ) {
          const registration = { selector, provider, active: true };
          formatters.push(registration);
          return new Disposable(() => {
            registration.active = false;
          });
        },
        createDiagnosticCollection: () => ({
          set() {},
          delete() {},
          clear() {},
          dispose() {},
          forEach() {},
        }),
      },
      window: {
        tabGroups: { all: [] },
        activeTextEditor: {
          document: document.asDocument(),
          selection: {
            active: document.positionAt(sourceText.indexOf("_port") + 2),
          },
        },
        onDidChangeActiveTextEditor: activeChanged.event,
        createStatusBarItem: () => ({
          text: "",
          command: "",
          show() {},
          hide() {},
          dispose() {},
        }),
        createOutputChannel: () => ({
          appendLine: (line: string) => lines.push(line),
          dispose() {},
        }),
        showErrorMessage: (message: string) => {
          notices.push(message);
          return Promise.resolve(undefined);
        },
        showTextDocument: async () => undefined,
      },
    };
    const module = {
      exports: {} as {
        EditorIntegration: typeof EditorIntegration;
        updateProviders: typeof updateProviders;
      },
    };
    runInNewContext(await bundle, {
      module,
      exports: module.exports,
      require: createRequire(import.meta.url),
      process,
      Buffer,
      AbortController,
      Error,
      AggregateError,
      setTimeout,
      clearTimeout,
      vscodeAdapter: api,
    });
    const editor = ownJoinedResource(
      resources,
      "navigation adapter",
      new module.exports.EditorIntegration("fixture-cli", {
        ...adapters,
        runProcess: async (request, signal, observeFailure) => {
          if (
            !(options.acceptedOperations ?? ["query"]).includes(request.args[0])
          )
            throw new Error("No background backend in the navigation fixture");
          if (!adapters.runProcess)
            throw new Error("Navigation fixture requires its own backend");
          return adapters.runProcess(request, signal, observeFailure);
        },
      }),
    );
    if (options.waitForReady !== false) await editor.ready();
    const wire = (request: ProcessRequest) => {
      const sourcePath = relative(root, source).replaceAll("\\", "/");
      const targetPath = relative(root, target).replaceAll("\\", "/");
      const operation = request.args[
        request.args.indexOf("--operation") + 1
      ] as QueryOperation;
      const offset = Number(request.args[request.args.indexOf("--offset") + 1]);
      const text = String(request.input);
      const targetKey = "target_role_port";
      const report: QueryReport = {
        schema_version: 1,
        root,
        path: sourcePath,
        source_sha256: hash(text),
        operation,
        offset,
        state: "resolved",
        reasons: [],
        coverage: { complete: false, reasons: ["static-reads-only"] },
        target_hashes: {
          [sourcePath]: hash(text),
          [targetPath]: hash(targetText),
        },
        locations: [
          {
            path: targetPath,
            text: targetKey,
            line: 1,
            column: 1,
            span: { start: 0, end: targetKey.length },
            kind: "declaration",
          },
        ],
        declarations: [],
        completions: [],
        dependencies: {
          schema_version: 1,
          root,
          generation: hash(text),
          complete: true,
          sources: [
            {
              path: sourcePath,
              source_sha256: hash(text),
              files: [
                { path: sourcePath, sha256: hash(text), state: "read" },
                { path: targetPath, sha256: hash(targetText), state: "read" },
              ],
              identity: [],
              discovery: [],
              directories: [],
            },
          ],
        },
      };
      return JSON.stringify(report);
    };
    return body({
      root,
      source,
      target,
      document,
      targetDocument,
      editor,
      resources,
      lines,
      notices,
      position: document.positionAt(sourceText.indexOf("_port") + 2),
      wire,
      refreshProviders: () =>
        module.exports.updateProviders(editor, registrations),
      formatter: () => {
        if (!registrations.has(document.uri.toString())) return;
        return formatters.find((registration) => {
          if (!registration.active) return false;
          const selectors = Array.isArray(registration.selector)
            ? registration.selector
            : [registration.selector];
          return selectors.some(
            (selector) =>
              typeof selector !== "string" &&
              selector.language === document.languageId &&
              typeof selector.pattern === "object" &&
              selector.pattern.baseUri.fsPath === dirname(source) &&
              selector.pattern.pattern === basename(source),
          );
        })?.provider;
      },
      focus(source) {
        api.window.activeTextEditor.document = source.asDocument();
        activeChanged.fire(api.window.activeTextEditor);
      },
      removeWorkspace() {
        workspaceVisible = false;
        editor.configureRoots();
      },
      setWorkspaceFolders(paths) {
        const previous = folders;
        folders = paths.map((path) => ({ uri: URI.file(path) }));
        explicitFolders = true;
        const changed = [...previous, ...folders].filter(
          (candidate) =>
            previous.some(
              (before) => before.uri.toString() === candidate.uri.toString(),
            ) !==
            folders.some(
              (after) => after.uri.toString() === candidate.uri.toString(),
            ),
        );
        editor.configureRoots();
        editor.refresh(changed.map(({ uri }) => uri as vscode.Uri));
      },
    });
  });
}
