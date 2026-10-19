import * as vscode from "vscode";
import * as path from "node:path";
import {
  EditorIntegration,
  tabDocumentUris,
  type EditorAdapters,
} from "./editor.ts";
import { rootMarker } from "./roots.ts";
import { updateProviders, type ProviderRegistration } from "./providers.ts";

let activeEditor: EditorIntegration | undefined;
let deactivation: Promise<void> | undefined;

export function deactivate(): Promise<void> {
  const editor = activeEditor;
  if (!editor) return deactivation ?? Promise.resolve();
  activeEditor = undefined;
  // Publish the admitted owner before a disposal callback can reenter.
  const cleanup = Promise.resolve().then(async () => {
    let disposalFailed = false;
    let disposalFailure: unknown;
    try {
      editor.dispose();
    } catch (error) {
      disposalFailed = true;
      disposalFailure = error;
    }
    try {
      await editor.join();
    } catch (error) {
      if (disposalFailed)
        throw new AggregateError(
          [disposalFailure, error],
          "Extension disposal and joining failed",
          { cause: disposalFailure },
        );
      throw error;
    } finally {
      if (deactivation === cleanup) deactivation = undefined;
    }
    if (disposalFailed) throw disposalFailure;
  });
  deactivation = cleanup;
  return cleanup;
}

export function activate(
  context: vscode.ExtensionContext,
  adapters: Partial<EditorAdapters> = {},
): void {
  if (!vscode.workspace.isTrusted) return;
  const editor = new EditorIntegration(
    context.asAbsolutePath(
      path.join(
        "bin",
        "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
      ),
    ),
    adapters,
  );
  activeEditor = editor;
  const providers = new Map<string, ProviderRegistration>();
  const refreshProviders = () => updateProviders(editor, providers);
  context.subscriptions.push(
    editor,
    editor.onDidChangeEligibility(refreshProviders),
    new vscode.Disposable(() => {
      for (const registration of providers.values())
        registration.disposable.dispose();
      providers.clear();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("saltboxLint.explainRule", (id?: string) =>
      editor.explainRule(id),
    ),
    vscode.commands.registerCommand("saltboxLint.showImpact", () =>
      editor.navigation.impact(),
    ),
    vscode.commands.registerCommand("saltboxLint.showStatus", () =>
      editor.showStatus(),
    ),
    vscode.commands.registerCommand("saltboxLint.checkDocument", () => {
      const document = vscode.window.activeTextEditor?.document;
      return document && editor.check(document, true);
    }),
    vscode.commands.registerCommand("saltboxLint.checkWorkspace", () =>
      editor.checkWorkspace(),
    ),
    vscode.commands.registerCommand("saltboxLint.fixAll", (uri?: vscode.Uri) =>
      editor.fixAll(uri),
    ),
    vscode.commands.registerCommand(
      "saltboxLint.applySharedFix",
      (uri: vscode.Uri, hash: string, id: string, reportId: string) =>
        editor.applyShared(uri, hash, id, reportId),
    ),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.closed)
        for (const uri of tabDocumentUris(tab)) {
          const document = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === uri.toString(),
          );
          if (document) editor.close(document);
        }
      for (const tab of event.opened)
        for (const uri of tabDocumentUris(tab)) {
          const document = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === uri.toString(),
          );
          if (document) editor.open(document);
        }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => editor.open(document)),
    vscode.workspace.onDidSaveTextDocument((document) =>
      editor.saved(document),
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length) editor.change(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) =>
      editor.close(document),
    ),
    vscode.workspace.onDidRenameFiles((event) =>
      editor.refresh(
        event.files
          .filter((file) =>
            [file.oldUri, file.newUri].every(
              (uri) => path.basename(uri.fsPath) !== rootMarker,
            ),
          )
          .flatMap((file) => [file.oldUri, file.newUri]),
      ),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      editor.configureRoots();
      editor.refresh(
        [...event.added, ...event.removed].map((folder) => folder.uri),
      );
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const affected = (vscode.workspace.workspaceFolders ?? []).filter(
        (folder) => event.affectsConfiguration("saltboxLint.root", folder.uri),
      );
      if (affected.length) editor.configureRoots();
    }),
  );
  for (const document of vscode.workspace.textDocuments)
    editor.checkBackground(document);
}
