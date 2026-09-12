import * as vscode from "vscode";
import * as path from "node:path";
import { EditorIntegration, tabDocumentUris } from "./editor.ts";

const selector: vscode.DocumentSelector = [
  { scheme: "file", language: "yaml", pattern: "**/*.{yml,yaml}" },
  { scheme: "file", language: "ansible", pattern: "**/*.{yml,yaml}" },
];
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
  context.subscriptions.push(editor);
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
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (/\.ya?ml$/i.test(document.uri.path)) editor.refresh([document.uri]);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length) editor.change(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) =>
      editor.close(document),
    ),
    vscode.workspace.onDidRenameFiles((event) =>
      editor.refresh(event.files.flatMap((file) => [file.oldUri, file.newUri])),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders((event) =>
      editor.refresh(
        [...event.added, ...event.removed].map((folder) => folder.uri),
      ),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const affected = (vscode.workspace.workspaceFolders ?? []).filter(
        (folder) => event.affectsConfiguration("saltboxLint.root", folder.uri),
      );
      if (affected.length) editor.refresh(affected.map((folder) => folder.uri));
    }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{yml,yaml}");
  context.subscriptions.push(
    watcher,
    watcher.onDidChange((uri) => editor.refresh([uri])),
    watcher.onDidCreate((uri) => editor.refresh([uri])),
    watcher.onDidDelete((uri) => editor.refresh([uri])),
  );
  for (const document of vscode.workspace.textDocuments)
    void editor.check(document);
}
