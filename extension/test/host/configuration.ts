import * as vscode from "vscode";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { diagnosticCode } from "./diagnostic-code.ts";
import { diagnosticTransition } from "../support/diagnostic-transition.ts";
import type { TestResources } from "../support/test-resources.ts";

function findings(uri: vscode.Uri): readonly vscode.Diagnostic[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((finding) => finding.source === "saltbox-lint");
}

async function expectPrefix(
  resources: TestResources,
  uri: vscode.Uri,
  expected: number,
  trigger: () => PromiseLike<unknown>,
): Promise<void> {
  await resources.operation("configuration diagnostic transition", (signal) =>
    diagnosticTransition({
      signal,
      subscribe: (observe) =>
        vscode.languages.onDidChangeDiagnostics((event) => {
          if (
            event.uris.some((changed) => changed.toString() === uri.toString())
          )
            observe();
        }),
      ready: () => {
        const current = findings(uri);
        // Root invalidation clears diagnostics before the replacement check.
        // An unrelated real finding proves that a fresh backend result arrived.
        return (
          current.some(
            (finding) => diagnosticCode(finding) === "jinja-layout",
          ) &&
          current.filter(
            (finding) => diagnosticCode(finding) === "role-variable-prefix",
          ).length === expected
        );
      },
      trigger,
    }),
  );
}

export async function runConfiguration(
  resources: TestResources,
): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri;
  const marker = vscode.Uri.joinPath(root, ".saltbox-lint");
  const original = await readFile(marker.fsPath);
  resources.defer("project configuration", async () => {
    if (!(await readFile(marker.fsPath)).equals(original))
      await writeFile(marker.fsPath, original);
  });
  const consumer = vscode.Uri.joinPath(
    root,
    "roles/namespace_consumer/defaults/main.yml",
  );
  const owner = vscode.Uri.joinPath(
    root,
    "roles/namespace_owner/defaults/main.yml",
  );
  const consumerText =
    'namespace_owner_shared: true\nnamespace_consumer_role_layout: "{{ value\n }}"\n';
  const ownerText =
    'namespace_owner_name: namespace_owner\nnamespace_consumer_external: true\nnamespace_owner_role_layout: "{{ value\n }}"\n';
  // These new fixture trees belong to the external installed-profile owner,
  // which removes them after the host and native process owners have closed.
  for (const [uri, text] of [
    [consumer, consumerText],
    [owner, ownerText],
  ] as const) {
    await mkdir(dirname(uri.fsPath), { recursive: true });
    await writeFile(uri.fsPath, text);
  }
  const document = await vscode.workspace.openTextDocument(consumer);
  await vscode.window.showTextDocument(document, { preview: false });
  await expectPrefix(resources, consumer, 1, () =>
    vscode.commands.executeCommand("saltboxLint.checkDocument"),
  );
  await expectPrefix(resources, consumer, 0, () =>
    writeFile(
      marker.fsPath,
      "namespace_sharing:\n  namespace_consumer: [namespace_owner]\n",
    ),
  );
  const ownerDocument = await vscode.workspace.openTextDocument(owner);
  await vscode.window.showTextDocument(ownerDocument, { preview: false });
  await expectPrefix(resources, owner, 1, () =>
    vscode.commands.executeCommand("saltboxLint.checkDocument"),
  );
  await expectPrefix(resources, consumer, 1, () =>
    writeFile(marker.fsPath, original),
  );
  await vscode.window.showTextDocument(document, { preview: false });
  const edit = new vscode.WorkspaceEdit();
  edit.insert(
    document.uri,
    document.positionAt(consumerText.indexOf("\n")),
    " # saltbox-lint ignore role-variable-prefix",
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await expectPrefix(resources, consumer, 0, () =>
    vscode.commands.executeCommand("saltboxLint.checkDocument"),
  );
  assert.ok(
    !findings(consumer).some(
      (finding) => diagnosticCode(finding) === "lint-directive",
    ),
  );
  assert.equal(await readFile(consumer.fsPath, "utf8"), consumerText);
  assert.equal(await readFile(owner.fsPath, "utf8"), ownerText);
  console.log(
    "PASS saved directional namespace configuration and dirty inline rule ignore",
  );
  await resources.operation("saved folder exclusion", (signal) =>
    diagnosticTransition({
      signal,
      subscribe: (observe) =>
        vscode.languages.onDidChangeDiagnostics(() => observe()),
      ready: () =>
        findings(consumer).length === 0 &&
        findings(owner).some(
          (finding) => diagnosticCode(finding) === "jinja-layout",
        ),
      trigger: async () => {
        await writeFile(
          marker.fsPath,
          "exclude_paths: [roles/namespace_consumer]\n",
        );
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
      },
    }),
  );
  await vscode.window.showTextDocument(document, { preview: false });
  const excludedText = document.getText();
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  assert.equal(findings(consumer).length, 0);
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  assert.equal(edits?.length ?? 0, 0);
  await vscode.commands.executeCommand("saltboxLint.fixAll");
  assert.equal(document.getText(), excludedText);
  await writeFile(marker.fsPath, "exclude_paths: [roles, resources]\n");
  await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  assert.equal(findings(consumer).length, 0);
  assert.equal(findings(owner).length, 0);
  await expectPrefix(resources, owner, 1, async () => {
    await writeFile(marker.fsPath, original);
    await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  });
  await expectPrefix(resources, consumer, 0, () =>
    vscode.commands.executeCommand("saltboxLint.checkDocument"),
  );
  assert.equal(document.getText(), excludedText);
  console.log(
    "PASS saved folder exclusions skip dirty documents, formatting and fixes and recover after an empty workspace scan",
  );
}
