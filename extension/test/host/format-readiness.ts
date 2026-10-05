import * as vscode from "vscode";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { EditorIntegration, tabDocumentUris } from "../../src/editor.ts";

// Delay only the completion of a successful real marker read. Canonical roots,
// source identities, editor documents, events and CLI responses remain real.
async function delayedRoot(
  marker: string,
  operation: (entered: Promise<void>, release: () => void) => Promise<void>,
) {
  const filesystem =
    require("node:fs/promises") as typeof import("node:fs/promises");
  const original = filesystem.lstat;
  const descriptor = Object.getOwnPropertyDescriptor(filesystem, "lstat")!;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let enter!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const reads: Promise<unknown>[] = [];
  Object.defineProperty(filesystem, "lstat", {
    ...descriptor,
    value: async (...args: Parameters<typeof original>) => {
      const stat = await original(...args);
      if (resolve(String(args[0])) !== resolve(marker)) return stat;
      enter();
      const read = gate.then(() => stat);
      reads.push(read);
      return read;
    },
  });
  try {
    await operation(entered, release);
  } finally {
    release();
    Object.defineProperty(filesystem, "lstat", descriptor);
    await Promise.allSettled(reads);
  }
}

export async function checkFormatReadiness(
  executable: string,
  original: vscode.TextDocument,
) {
  const folder = vscode.workspace.getWorkspaceFolder(original.uri)!;
  const marker = vscode.Uri.joinPath(folder.uri, ".saltbox-lint");
  const fixture = vscode.Uri.joinPath(
    folder.uri,
    "roles/example/defaults/format-readiness.yml",
  );
  const bytes = Buffer.from('---\nexample_value: "{{ value\n }}"\n');
  const fingerprint = (source: Uint8Array) =>
    createHash("sha256").update(source).digest("hex");
  await vscode.workspace.fs.writeFile(fixture, bytes);
  try {
    for (const state of [
      "startup",
      "edit",
      "cancel",
      "close",
      "marker",
    ] as const) {
      const document = await vscode.workspace.openTextDocument(fixture);
      await vscode.window.showTextDocument(document, { preview: false });
      await delayedRoot(marker.fsPath, async (entered, release) => {
        const editor = new EditorIntegration(executable);
        const cancellation = new vscode.CancellationTokenSource();
        let closed!: () => void;
        const documentClosed = new Promise<void>((done) => {
          closed = done;
        });
        const tabs = vscode.window.tabGroups.onDidChangeTabs((event) => {
          for (const tab of event.closed)
            if (
              tabDocumentUris(tab).some(
                (uri) => uri.toString() === document.uri.toString(),
              )
            ) {
              editor.close(document);
              closed();
            }
        });
        let settled = false;
        const pending = editor
          .format(document, "canonical", cancellation.token)
          .then((edits) => {
            settled = true;
            return edits;
          });
        try {
          await entered;
          assert.equal(
            settled,
            false,
            `${state} waits for real initial root readiness`,
          );
          if (state === "edit") {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(
              document.uri,
              new vscode.Position(0, 0),
              "# changed buffer\n",
            );
            assert.equal(await vscode.workspace.applyEdit(edit), true);
          }
          if (state === "cancel") cancellation.cancel();
          if (state === "close") {
            await vscode.commands.executeCommand(
              "workbench.action.closeActiveEditor",
            );
            await documentClosed;
          }
          if (state === "marker") {
            await vscode.workspace.fs.delete(marker);
            // A real manual probe observes absence without relying on watcher order.
            await editor.check(document, true);
          }
          release();
          const edits = await pending;
          if (state === "startup") {
            assert.ok(
              edits.length > 0,
              "fresh writable YAML formats after root readiness",
            );
            assert.ok(
              (await editor.format(document, "canonical")).length > 0,
              "already-ready writable YAML still formats",
            );
          } else
            assert.deepEqual(
              edits,
              [],
              `${state} declines the captured request`,
            );
          assert.equal(
            fingerprint(await readFile(fixture.fsPath)),
            fingerprint(bytes),
          );
        } finally {
          release();
          await pending;
          cancellation.dispose();
          tabs.dispose();
          editor.dispose();
          if (state === "marker")
            await vscode.workspace.fs.writeFile(marker, new Uint8Array());
        }
      });
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(fixture),
      );
      await vscode.commands.executeCommand(
        "workbench.action.revertAndCloseActiveEditor",
      );
    }

    const config = vscode.workspace.getConfiguration("saltboxLint", folder.uri);
    const previousRoot = config.inspect<string>("root")?.workspaceFolderValue;
    const templateRoot = vscode.Uri.joinPath(
      folder.uri,
      "roles/example/templates/format-readiness",
    );
    const template = vscode.Uri.joinPath(templateRoot, "config.yaml");
    const alias = vscode.Uri.joinPath(folder.uri, "format-readiness-alias");
    const templateBytes = Buffer.from(
      " \t{% raw -%}literal{%- endraw %}\r\n{{ value }}  ",
    );
    await vscode.workspace.fs.createDirectory(templateRoot);
    await vscode.workspace.fs.writeFile(template, templateBytes);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(templateRoot, ".saltbox-lint"),
      new Uint8Array(),
    );
    try {
      await symlink(templateRoot.fsPath, alias.fsPath, "junction");
      for (const narrow of [false, true]) {
        await config.update(
          "root",
          narrow ? templateRoot.fsPath : previousRoot,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        for (const uri of [
          template,
          vscode.Uri.joinPath(alias, "config.yaml"),
        ]) {
          const document = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(document, { preview: false });
          const editor = new EditorIntegration(executable);
          try {
            for (const mode of ["canonical", "lint-fixes"] as const)
              assert.deepEqual(await editor.format(document, mode), []);
            await editor.fixAll(document.uri);
            assert.equal(
              fingerprint(await readFile(template.fsPath)),
              fingerprint(templateBytes),
              "physical/narrow/aliased templates retain exact bytes",
            );
          } finally {
            editor.dispose();
          }
          await vscode.commands.executeCommand(
            "workbench.action.closeActiveEditor",
          );
        }
      }
    } finally {
      await config.update(
        "root",
        previousRoot,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      await rm(alias.fsPath, { recursive: true, force: true });
      await vscode.workspace.fs.delete(templateRoot, { recursive: true });
    }
    console.log(
      "PASS real format initialization waits for roots and rejects edited, canceled, closed, unmarked and canonical template sources",
    );
  } finally {
    await vscode.workspace.fs.delete(fixture);
    await vscode.window.showTextDocument(original, { preview: false });
  }
}
