import * as vscode from "vscode";
import { tabDocumentUris } from "../../src/editor.ts";
import { closeTabs } from "./close-tabs.ts";

export async function closeEditorTabs(signal: AbortSignal): Promise<void> {
  await closeTabs<vscode.Tab, vscode.TextDocument>(
    {
      tabs: () => vscode.window.tabGroups.all.flatMap((group) => group.tabs),
      key: (tab) => {
        const input = tab.input;
        const value =
          input instanceof vscode.TabInputText
            ? ["text", input.uri.toString()]
            : input instanceof vscode.TabInputTextDiff
              ? [
                  "text-diff",
                  input.original.toString(),
                  input.modified.toString(),
                ]
              : input instanceof vscode.TabInputNotebook
                ? ["notebook", input.notebookType, input.uri.toString()]
                : input instanceof vscode.TabInputNotebookDiff
                  ? [
                      "notebook-diff",
                      input.notebookType,
                      input.original.toString(),
                      input.modified.toString(),
                    ]
                  : input instanceof vscode.TabInputCustom
                    ? ["custom", input.viewType, input.uri.toString()]
                    : input instanceof vscode.TabInputWebview
                      ? ["webview", input.viewType, tab.label]
                      : input instanceof vscode.TabInputTerminal
                        ? ["terminal", tab.label]
                        : ["other", tab.label];
        return JSON.stringify([tab.group.viewColumn, ...value]);
      },
      dirtyDocuments: (tab) =>
        tabDocumentUris(tab).flatMap((uri) => {
          const document = vscode.workspace.textDocuments.find(
            (source) => source.uri.toString() === uri.toString(),
          );
          return document?.isDirty ? [document] : [];
        }),
      activeDocumentTab: (document) => {
        const tab = vscode.window.tabGroups.all.find(
          (group) => group.isActive,
        )?.activeTab;
        return tab &&
          vscode.window.activeTextEditor?.document === document &&
          tabDocumentUris(tab).some(
            (uri) => uri.toString() === document.uri.toString(),
          )
          ? tab
          : undefined;
      },
      onChange: (listener) =>
        vscode.Disposable.from(
          vscode.window.tabGroups.onDidChangeTabs((event) =>
            listener({ closed: event.closed }),
          ),
          vscode.window.tabGroups.onDidChangeTabGroups((event) =>
            listener({ closed: event.closed.flatMap((group) => group.tabs) }),
          ),
          vscode.window.onDidChangeActiveTextEditor(() =>
            listener({ closed: [] }),
          ),
        ),
      showDocument: (document, tab) =>
        vscode.window.showTextDocument(document, {
          viewColumn: tab.group.viewColumn,
          preview: false,
        }),
      discardActive: () =>
        vscode.commands.executeCommand(
          "workbench.action.revertAndCloseActiveEditor",
        ),
      closeClean: (tab) => vscode.window.tabGroups.close(tab, true),
    },
    signal,
  );
}
