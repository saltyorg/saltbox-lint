import * as vscode from "vscode";
import { tabDocumentUris } from "../../src/editor.ts";
import { closeTabs } from "./close-tabs.ts";

export async function closeEditorTabs(
  signal: AbortSignal,
  ownedUris?: readonly vscode.Uri[],
): Promise<void> {
  const owned = ownedUris && new Set(ownedUris.map((uri) => uri.toString()));
  const tabs = () =>
    vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter(
        (tab) =>
          owned === undefined ||
          tabDocumentUris(tab).some((uri) => owned.has(uri.toString())),
      ),
    );
  const before = tabs().map((tab) => ({
    viewColumn: tab.group.viewColumn,
    uris: tabDocumentUris(tab).map((uri) => uri.toString()),
  }));
  await closeTabs<vscode.Tab, vscode.TextDocument>(
    {
      tabs,
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
      dirtyDocuments: (tab) => {
        const dirty = tabDocumentUris(tab).flatMap((uri) => {
          const document = vscode.workspace.textDocuments.find(
            (source) => source.uri.toString() === uri.toString(),
          );
          return document?.isDirty ? [document] : [];
        });
        if (
          owned !== undefined &&
          dirty.some((document) => !owned.has(document.uri.toString()))
        )
          throw new Error("Owned fixture tab contains another dirty resource");
        return dirty;
      },
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
  if (owned !== undefined) {
    const after = tabs();
    if (after.length)
      throw new Error("Owned fixture tabs remain after closure");
    console.log(
      "SALTBOX_EDITOR_TABS " +
        JSON.stringify({
          scope: "owned-fixture",
          uris: [...owned].slice(0, 32).map((uri) => uri.slice(0, 2048)),
          before: before.slice(0, 32),
          after: [],
          joined: true,
        }),
    );
  }
}
