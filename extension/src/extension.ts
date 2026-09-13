import * as vscode from "vscode";
import * as path from "node:path";
import { EditorIntegration, tabDocumentUris } from "./editor.ts";
import { rootMarker } from "./roots.ts";

export function activate(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.isTrusted) return;
  const editor = new EditorIntegration(
    context.asAbsolutePath(
      path.join(
        "bin",
        "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
      ),
    ),
  );
  const providers = new Map<
    string,
    { language: string; disposable: vscode.Disposable }
  >();
  const updateProviders = () => {
    const documents = new Map(
      editor
        .providerDocuments()
        .map((document) => [document.uri.toString(), document]),
    );
    for (const [key, registration] of providers) {
      if (documents.get(key)?.languageId === registration.language) continue;
      registration.disposable.dispose();
      providers.delete(key);
    }
    for (const [key, document] of documents) {
      if (providers.has(key)) continue;
      const selector: vscode.DocumentSelector = [
        {
          scheme: "file",
          language: document.languageId,
          pattern: new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(document.uri.fsPath)),
            path.basename(document.uri.fsPath).replace(/[?*{}[\]]/g, "[$&]"),
          ),
        },
      ];
      providers.set(key, {
        language: document.languageId,
        disposable: vscode.Disposable.from(
          vscode.languages.registerCodeActionsProvider(
            selector,
            {
              provideCodeActions: (document, range) =>
                editor.actions(document, range),
            },
            {
              providedCodeActionKinds: [
                vscode.CodeActionKind.QuickFix,
                vscode.CodeActionKind.SourceFixAll.append("saltboxLint"),
              ],
            },
          ),
          vscode.languages.registerDocumentFormattingEditProvider(selector, {
            provideDocumentFormattingEdits: (document, _options, token) =>
              editor.format(document, "canonical", token),
          }),
        ),
      });
    }
  };
  context.subscriptions.push(
    editor,
    editor.onDidChangeEligibility(updateProviders),
    new vscode.Disposable(() => {
      for (const registration of providers.values())
        registration.disposable.dispose();
      providers.clear();
    }),
  );
  context.subscriptions.push(
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
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{yml,yaml}");
  context.subscriptions.push(
    watcher,
    watcher.onDidChange((uri) => editor.refresh([uri])),
    watcher.onDidCreate((uri) => editor.refresh([uri])),
    watcher.onDidDelete((uri) => editor.removeFile(uri)),
  );
  for (const document of vscode.workspace.textDocuments)
    void editor.check(document);
}
