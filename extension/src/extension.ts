import * as vscode from "vscode";
import * as path from "node:path";
import { EditorIntegration } from "./editor.ts";

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
      (uri: vscode.Uri, hash: string, id: string) =>
        editor.applyShared(uri, hash, id),
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
      for (const tab of event.closed) {
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        const uri = tab.input.uri;
        const document = vscode.workspace.textDocuments.find(
          (doc) => doc.uri.toString() === uri.toString(),
        );
        if (document) editor.close(document);
      }
      for (const tab of event.opened) {
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        const uri = tab.input.uri;
        const document = vscode.workspace.textDocuments.find(
          (doc) => doc.uri.toString() === uri.toString(),
        );
        if (document) void editor.check(document);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void editor.check(document);
    }),
    vscode.workspace.onDidSaveTextDocument(() => editor.refresh()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length) editor.change(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) =>
      editor.close(document),
    ),
    vscode.workspace.onDidRenameFiles(() => editor.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => editor.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("saltboxLint.root")) editor.refresh();
    }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{yml,yaml}");
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => editor.refresh()),
    watcher.onDidCreate(() => editor.refresh()),
    watcher.onDidDelete(() => editor.refresh()),
  );
  for (const document of vscode.workspace.textDocuments)
    void editor.check(document);
}
