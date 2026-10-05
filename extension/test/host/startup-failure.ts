import type * as vscode from "vscode";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diagnosticCode } from "./diagnostic-code.ts";

function observe<T>(read: () => T) {
  try {
    return { available: true as const, value: read() };
  } catch (error) {
    return {
      available: false as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function fileIdentity(path: string) {
  try {
    const bytes = readFileSync(path);
    return {
      path,
      available: true,
      present: true,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return {
      path,
      available: false,
      present:
        (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function documentIdentity(document: vscode.TextDocument) {
  return {
    uri: document.uri.toString(),
    scheme: document.uri.scheme,
    version: document.version,
    languageId: document.languageId,
    isDirty: document.isDirty,
    isClosed: document.isClosed,
  };
}

function configuration(api: typeof vscode, uri?: vscode.Uri) {
  const config = api.workspace.getConfiguration("saltboxLint", uri);
  const inspected = config.inspect<boolean>("activeProjectOnly");
  if (!inspected) throw new Error("activeProjectOnly inspection unavailable");
  // Null records an absent scope in JSON, distinct from an unavailable query.
  return {
    effective: config.get<boolean>("activeProjectOnly") ?? null,
    key: inspected.key,
    defaultValue: inspected.defaultValue ?? null,
    globalValue: inspected.globalValue ?? null,
    workspaceValue: inspected.workspaceValue ?? null,
    workspaceFolderValue: inspected.workspaceFolderValue ?? null,
    defaultLanguageValue: inspected.defaultLanguageValue ?? null,
    globalLanguageValue: inspected.globalLanguageValue ?? null,
    workspaceLanguageValue: inspected.workspaceLanguageValue ?? null,
    workspaceFolderLanguageValue:
      inspected.workspaceFolderLanguageValue ?? null,
    languageIds: inspected.languageIds ?? null,
  };
}

// Called only after startup rejects. These are public snapshots, not cache facts.
export function startupFailureReport(
  api: typeof vscode,
  roots: readonly vscode.WorkspaceFolder[],
  uris: readonly vscode.Uri[],
  tabUris: (tab: vscode.Tab) => readonly vscode.Uri[],
  controllerPath: string,
  fixturePath?: string,
) {
  const product = observe(() => {
    const extension = api.extensions.getExtension("saltyorg.saltbox-lint");
    if (!extension) throw new Error("installed product unavailable");
    const main: unknown = extension.packageJSON.main;
    return {
      id: extension.id,
      version: extension.packageJSON.version as string,
      extensionPath: extension.extensionPath,
      extensionUri: extension.extensionUri.toString(),
      isActive: extension.isActive,
      runtime:
        typeof main === "string"
          ? fileIdentity(join(extension.extensionPath, main))
          : { available: false, reason: "product main unavailable" },
      cli: fileIdentity(
        join(
          extension.extensionPath,
          "bin",
          "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
        ),
      ),
    };
  });
  return {
    schema_version: 1,
    observation: "public snapshot after startup assertion rejection",
    activeEditor: observe(() => {
      const editor = api.window.activeTextEditor;
      return editor ? documentIdentity(editor.document) : null;
    }),
    visibleEditors: observe(() =>
      api.window.visibleTextEditors.map((editor) =>
        documentIdentity(editor.document),
      ),
    ),
    loadedDocuments: observe(() =>
      api.workspace.textDocuments.map(documentIdentity),
    ),
    tabGroups: observe(() =>
      api.window.tabGroups.all.map((group) => ({
        isActive: group.isActive,
        viewColumn: group.viewColumn,
        tabs: group.tabs.map((tab) => ({
          isActive: tab.isActive,
          isDirty: tab.isDirty,
          isPinned: tab.isPinned,
          isPreview: tab.isPreview,
          uris: tabUris(tab).map((uri) => uri.toString()),
        })),
      })),
    ),
    configuration: observe(() => configuration(api)),
    roots: roots.map((root, index) => ({
      uri: root.uri.toString(),
      testedUri: uris[index].toString(),
      configuration: observe(() => configuration(api, root.uri)),
      displayedDiagnostics: observe(() => {
        const diagnostics = api.languages
          .getDiagnostics(uris[index])
          .filter((diagnostic) => diagnostic.source === "saltbox-lint");
        return {
          count: diagnostics.length,
          diagnostics: diagnostics.map((diagnostic) => ({
            code: diagnosticCode(diagnostic) ?? null,
            severity: diagnostic.severity,
            range: {
              start: {
                line: diagnostic.range.start.line,
                character: diagnostic.range.start.character,
              },
              end: {
                line: diagnostic.range.end.line,
                character: diagnostic.range.end.character,
              },
            },
          })),
        };
      }),
      // Explicit synthetic runner fixtures only. Never enumerate user files.
      fixtures: [
        ".saltbox-lint",
        ".gitignore",
        "README.md",
        "roles/example/defaults/main.yml",
        "roles/example/defaults/saved.yml",
        ...(index === 0
          ? [
              "roles/example/defaults/closed.yml",
              "roles/example/defaults/related.yml",
              "roles/example/defaults/related-closed.yml",
              "roles/example/defaults/a-related.yml",
              "roles/example/defaults/z-gate.yml",
              "roles/late/defaults/main.yml",
            ]
          : []),
      ].map((relative) => fileIdentity(join(root.uri.fsPath, relative))),
    })),
    sdk: observe(() => {
      const path = join(api.env.appRoot, "product.json");
      return {
        version: api.version,
        appRoot: api.env.appRoot,
        appName: api.env.appName,
        productFile: fileIdentity(path),
        product: observe(() => {
          const product: Record<string, unknown> = JSON.parse(
            readFileSync(path, "utf8"),
          );
          return {
            commit: product.commit ?? null,
            version: product.version ?? null,
            date: product.date ?? null,
            quality: product.quality ?? null,
            nameShort: product.nameShort ?? null,
          };
        }),
      };
    }),
    process: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
    },
    product,
    controller: fileIdentity(controllerPath),
    fixtureExecutable: fixturePath
      ? fileIdentity(fixturePath)
      : { available: false, reason: "no component fixture executable" },
  };
}

export function reportStartupFailure(
  original: unknown,
  capture: () => unknown,
  emit: (report: string) => void = console.error,
): never {
  try {
    emit(`ACTIVE_PROJECT_STARTUP_FAILURE ${JSON.stringify(capture())}`);
  } catch {
    // Reporting must never replace the original assertion or predicate error.
  }
  throw original;
}
