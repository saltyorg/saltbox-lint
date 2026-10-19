import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { withTestResources } from "../support/test-resources.ts";
import { workspaceFixtureDirectory } from "../support/workspace-fixture.ts";
import { closeEditorTabs } from "../support/editor-tabs.ts";

export function changeWorkspace(
  index: number,
  remove: number,
  uri: vscode.Uri | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const expected = uri ?? vscode.workspace.workspaceFolders?.[index]?.uri;
  assert.ok(expected, "workspace mutation identifies its target");
  return new Promise((resolve, reject) => {
    const listener = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      const changed = uri ? event.added : event.removed;
      if (
        !changed.some((folder) => folder.uri.toString() === expected.toString())
      )
        return;
      listener.dispose();
      // Accepted workspace mutations have no cancellation API. Join their
      // actual event before reporting cancellation to the resource owner.
      if (signal.aborted) reject(signal.reason);
      else resolve();
    });
    try {
      if (
        vscode.workspace.updateWorkspaceFolders(
          index,
          remove,
          ...(uri ? [{ uri }] : []),
        )
      )
        return;
      listener.dispose();
      reject(new Error("workspace change refused"));
    } catch (error) {
      listener.dispose();
      reject(error);
    }
  });
}

export async function checkNestedWorkspaceAlias(
  original: vscode.TextDocument,
  parentSignal: AbortSignal,
): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: parentSignal },
    async (owner) => {
      const folder = vscode.workspace.getWorkspaceFolder(original.uri)!;
      const fixture = await workspaceFixtureDirectory(
        folder.uri.fsPath,
        "saltbox-nested-owner-",
      );
      const native = join(fixture, "native");
      const publicPath = join(fixture, "public");
      const nativeSource = join(native, "roles/example/defaults/main.yml");
      await mkdir(join(nativeSource, ".."), { recursive: true });
      await writeFile(nativeSource, '---\nexample_value: "{{ value\n }}"\n');
      await writeFile(join(native, ".saltbox-lint"), "");
      await symlink(
        native,
        publicPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      owner.defer("restore nested alias editor", () =>
        vscode.window
          .showTextDocument(original, { preview: false })
          .then(() => {}),
      );
      const config = vscode.workspace.getConfiguration(
        "saltboxLint",
        folder.uri,
      );
      const previous = config.inspect<string>("root")?.workspaceFolderValue;
      owner.defer("restore nested alias root", () =>
        config.update(
          "root",
          previous,
          vscode.ConfigurationTarget.WorkspaceFolder,
        ),
      );
      const opened = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(publicPath, "roles/example/defaults/main.yml")),
      );
      const document = (
        await vscode.window.showTextDocument(opened, { preview: false })
      ).document;
      owner.defer("close nested alias document", (signal) =>
        closeEditorTabs(signal, [document.uri]),
      );
      assert.notEqual(
        document.uri.fsPath,
        await realpath(document.uri.fsPath),
        "SDK resource retains a distinct public alias",
      );
      assert.equal(
        await realpath(document.uri.fsPath),
        await realpath(nativeSource),
      );
      await config.update(
        "root",
        publicPath,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      const diagnostics = () =>
        vscode.languages
          .getDiagnostics(document.uri)
          .filter((d) => d.source === "saltbox-lint");
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.ok(
        diagnostics().length > 0,
        "parent owns an actual cached buffer result",
      );
      const nested = vscode.Uri.file(join(publicPath, "roles/example"));
      owner.defer("remove nested alias workspace", async (signal) => {
        const index =
          vscode.workspace.workspaceFolders?.findIndex(
            (f) => f.uri.toString() === nested.toString(),
          ) ?? -1;
        if (index >= 0) await changeWorkspace(index, 1, undefined, signal);
      });
      await changeWorkspace(
        vscode.workspace.workspaceFolders!.length,
        0,
        nested,
        owner.signal,
      );
      assert.equal(
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString(),
        nested.toString(),
      );
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.deepEqual(
        diagnostics(),
        [],
        "unmarked nested owner withdraws the parent result",
      );
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(nested, ".saltbox-lint"),
        new Uint8Array(),
      );
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.ok(
        diagnostics().length > 0,
        "nested owner has a fresh buffer result",
      );
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        "vscode.executeFormatDocumentProvider",
        document.uri,
        { tabSize: 2, insertSpaces: true },
      );
      assert.ok(
        edits.length > 0,
        "aliased nested ownership preserves installed formatting",
      );
      const index = vscode.workspace.workspaceFolders!.findIndex(
        (f) => f.uri.toString() === nested.toString(),
      );
      await changeWorkspace(index, 1, undefined, owner.signal);
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.ok(
        diagnostics().length > 0,
        "parent checks resume after nested workspace removal",
      );
      console.log(
        "SALTBOX_NESTED_OWNER_IDENTITY " +
          JSON.stringify({
            resource: document.uri.toString(),
            nativeSource: await realpath(document.uri.fsPath),
            publicRoot: publicPath,
            nativeRoot: await realpath(native),
            nested: nested.toString(),
            workspaceRemoved: !vscode.workspace.workspaceFolders!.some(
              (folder) => folder.uri.toString() === nested.toString(),
            ),
          }),
      );
      console.log(
        "PASS aliased nested workspace ownership retires parent results and preserves installed formatting",
      );
    },
  );
}
