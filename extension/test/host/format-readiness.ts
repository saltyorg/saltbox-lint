import * as vscode from "vscode";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, symlink, lstat } from "node:fs/promises";
import { withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { componentUI } from "../support/component-ui.ts";
import { workspaceFixtureDirectory } from "../support/workspace-fixture.ts";
import { closeEditorTabs } from "../support/editor-tabs.ts";
import { resolve } from "node:path";
import { EditorIntegration, tabDocumentUris } from "../../src/editor.ts";

// Delay only completion of a successful real marker read; release every read.
async function delayedRoot(
  marker: string,
  operation: (
    entered: Promise<void>,
    release: () => void,
    readMarker: typeof lstat,
  ) => Promise<void>,
) {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let enter!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const reads: Promise<unknown>[] = [];
  const readMarker = (async (...args: Parameters<typeof lstat>) => {
    const stat = await lstat(...args);
    if (resolve(String(args[0])) !== resolve(marker)) return stat;
    enter();
    const read = gate.then(() => stat);
    reads.push(read);
    return read;
  }) as typeof lstat;
  try {
    await operation(entered, release, readMarker);
  } finally {
    release();
    await Promise.allSettled(reads);
  }
}

export async function checkFormatReadiness(
  executable: string,
  original: vscode.TextDocument,
  parentSignal?: AbortSignal,
) {
  return withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: parentSignal },
    async (resources) => {
      const folder = vscode.workspace.getWorkspaceFolder(original.uri)!;
      const marker = vscode.Uri.joinPath(folder.uri, ".saltbox-lint");
      const fixture = vscode.Uri.joinPath(
        folder.uri,
        "roles/example/defaults/format-readiness.yml",
      );
      const bytes = Buffer.from('---\nexample_value: "{{ value\n }}"\n');
      const fingerprint = (source: Uint8Array) =>
        createHash("sha256").update(source).digest("hex");
      resources.defer("restore format readiness original editor", () =>
        vscode.window
          .showTextDocument(original, { preview: false })
          .then(() => {}),
      );
      await vscode.workspace.fs.writeFile(fixture, bytes);
      resources.defer("remove format readiness YAML fixture", () =>
        vscode.workspace.fs.delete(fixture),
      );
      for (const state of [
        "startup",
        "edit",
        "cancel",
        "close",
        "marker",
      ] as const) {
        await withTestResources(
          { cleanupTimeoutMs: 5000, operationSignal: resources.signal },
          async (owner) => {
            const document = await vscode.workspace.openTextDocument(fixture);
            const openedUris = [document.uri];
            owner.defer("close format readiness YAML tabs", (signal) =>
              closeEditorTabs(signal, openedUris),
            );
            if (state === "marker")
              owner.defer("restore format readiness marker", () =>
                vscode.workspace.fs.writeFile(marker, new Uint8Array()),
              );
            await vscode.window.showTextDocument(document, { preview: false });
            await delayedRoot(
              marker.fsPath,
              async (entered, release, readMarker) => {
                const editor = ownJoinedResource(
                  owner,
                  "format readiness adapter",
                  new EditorIntegration(executable, {
                    ...componentUI(owner),
                    roots: { lstat: readMarker },
                  }),
                );
                const cancellation = new vscode.CancellationTokenSource();
                owner.defer("format readiness cancellation", () =>
                  cancellation.dispose(),
                );
                let closed!: () => void;
                const documentClosed = new Promise<void>((done) => {
                  closed = done;
                });
                const tabs = vscode.window.tabGroups.onDidChangeTabs(
                  (event) => {
                    for (const tab of event.closed)
                      if (
                        tabDocumentUris(tab).some(
                          (uri) => uri.toString() === document.uri.toString(),
                        )
                      ) {
                        editor.close(document);
                        closed();
                      }
                  },
                );
                owner.defer("format readiness tab listener", () =>
                  tabs.dispose(),
                );
                let settled = false;
                const pending = owner.operation("pending root format", () =>
                  editor
                    .format(document, "canonical", cancellation.token)
                    .then((edits) => {
                      settled = true;
                      return edits;
                    }),
                );
                try {
                  await Promise.race([
                    entered,
                    pending.then(
                      () => {
                        throw new Error("Format settled before root readiness");
                      },
                      (error: unknown) => {
                        throw error;
                      },
                    ),
                  ]);
                  assert.equal(
                    settled,
                    false,
                    state + " waits for real initial root readiness",
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
                      state + " declines the captured request",
                    );
                  assert.equal(
                    fingerprint(await readFile(fixture.fsPath)),
                    fingerprint(bytes),
                  );
                } finally {
                  // The independent case owner joins pending and adapter work,
                  // preserving rejected operations together with restoration faults.
                  release();
                }
              },
            );
            const reopened = await vscode.workspace.openTextDocument(fixture);
            openedUris.push(reopened.uri);
            await vscode.window.showTextDocument(reopened);
            await vscode.commands.executeCommand(
              "workbench.action.revertAndCloseActiveEditor",
            );
          },
        );
      }
      await withTestResources(
        { cleanupTimeoutMs: 5000, operationSignal: resources.signal },
        async (owner) => {
          const config = vscode.workspace.getConfiguration(
            "saltboxLint",
            folder.uri,
          );
          const previousRoot =
            config.inspect<string>("root")?.workspaceFolderValue;
          owner.defer("restore format readiness root setting", () =>
            config.update(
              "root",
              previousRoot,
              vscode.ConfigurationTarget.WorkspaceFolder,
            ),
          );
          const templateParent = vscode.Uri.joinPath(
            folder.uri,
            "roles/example/templates",
          );
          await vscode.workspace.fs.createDirectory(templateParent);
          const templateRoot = vscode.Uri.file(
            await workspaceFixtureDirectory(
              templateParent.fsPath,
              "saltbox-format-readiness-",
            ),
          );
          const template = vscode.Uri.joinPath(templateRoot, "config.yaml");
          const aliasParent = await workspaceFixtureDirectory(
            folder.uri.fsPath,
            "saltbox-format-readiness-alias-",
          );
          const alias = vscode.Uri.file(resolve(aliasParent, "source"));
          const templateBytes = Buffer.from(
            " \t{% raw -%}literal{%- endraw %}\r\n{{ value }}  ",
          );
          await vscode.workspace.fs.createDirectory(templateRoot);
          await vscode.workspace.fs.writeFile(template, templateBytes);
          await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(templateRoot, ".saltbox-lint"),
            new Uint8Array(),
          );
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
              await withTestResources(
                { cleanupTimeoutMs: 5000, operationSignal: owner.signal },
                async (documentOwner) => {
                  const document = await vscode.workspace.openTextDocument(uri);
                  documentOwner.defer(
                    "close format readiness template tabs",
                    (signal) => closeEditorTabs(signal, [document.uri]),
                  );
                  await vscode.window.showTextDocument(document, {
                    preview: false,
                  });
                  const editor = ownJoinedResource(
                    documentOwner,
                    "template readiness adapter",
                    new EditorIntegration(
                      executable,
                      componentUI(documentOwner),
                    ),
                  );
                  for (const mode of ["canonical", "lint-fixes"] as const)
                    assert.deepEqual(await editor.format(document, mode), []);
                  await editor.fixAll(document.uri);
                  assert.equal(
                    fingerprint(await readFile(template.fsPath)),
                    fingerprint(templateBytes),
                    "physical/narrow/aliased templates retain exact bytes",
                  );
                  await closeEditorTabs(documentOwner.signal, [document.uri]);
                },
              );
            }
          }
        },
      );
      console.log(
        "PASS real format initialization waits for roots and rejects edited, canceled, closed, unmarked and canonical template sources",
      );
    },
  );
}
