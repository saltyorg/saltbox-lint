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
  let stage = "start";
  let expected: vscode.TextDocument | undefined;
  let reported = false;
  const observationFailures: unknown[] = [];
  const evidence = () => {
    if (reported) return;
    reported = true;
    try {
      const active = vscode.window.activeTextEditor?.document;
      console.error(
        "SALTBOX_EDITOR_TAB_CLEANUP " +
          JSON.stringify({
            stage,
            expected: expected && {
              uri: expected.uri.toString(),
              dirty: expected.isDirty,
              closed: expected.isClosed,
            },
            active: active && {
              uri: active.uri.toString(),
              dirty: active.isDirty,
              closed: active.isClosed,
              expectedObject: active === expected,
            },
            tabs: tabs()
              .slice(0, 32)
              .map((tab) => ({
                column: tab.group.viewColumn,
                activeGroup: tab.group.isActive,
                activeTab: tab.isActive,
                dirty: tab.isDirty,
                uris: tabDocumentUris(tab).map((uri) => uri.toString()),
              })),
          }),
      );
    } catch (error) {
      observationFailures.push(error);
    }
  };
  signal.addEventListener("abort", evidence, { once: true });
  try {
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
            throw new Error(
              "Owned fixture tab contains another dirty resource",
            );
          return dirty;
        },
        activeDocumentTab: (document) => {
          stage = "await-activation";
          expected = document;
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
        showDocument: async (document, tab) => {
          stage = "show-document";
          expected = document;
          const editor = await vscode.window.showTextDocument(document, {
            viewColumn: tab.group.viewColumn,
            preview: false,
          });
          if (owned !== undefined && !owned.has(editor.document.uri.toString()))
            throw new Error("Tab activation returned an unowned resource");
          stage = "show-returned";
          expected = editor.document;
          return editor.document;
        },
        discardActive: async () => {
          stage = "discard-active";
          await vscode.commands.executeCommand(
            "workbench.action.revertAndCloseActiveEditor",
          );
          stage = "discard-returned";
        },
        closeClean: async (tab) => {
          stage = "close-clean";
          const closed = await vscode.window.tabGroups.close(tab, true);
          stage = "close-returned";
          return closed;
        },
      },
      signal,
    );
  } catch (error) {
    evidence();
    if (observationFailures.length)
      throw new AggregateError(
        [error, ...observationFailures],
        "Tab cleanup and failure observation failed",
        { cause: error },
      );
    throw error;
  } finally {
    signal.removeEventListener("abort", evidence);
  }
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
