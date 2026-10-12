import * as vscode from "vscode";
import assert from "node:assert/strict";
import { EditorIntegration } from "../../src/editor.ts";
import { runProcess } from "../../src/process.ts";
import { readFile, writeFile, rm } from "node:fs/promises";
import { renderDiagnostics } from "../../src/diagnostics.ts";
import { SnapshotIndex } from "../../src/protocol.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import { join } from "node:path";
import type { TestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const end = Date.now() + 15000;
  while (!predicate() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(predicate(), message);
}
async function replace(document: vscode.TextDocument, text: string) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    ),
    text,
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}
function diagnostics(uri: vscode.Uri) {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === "saltbox-lint");
}

function ownBuffer(
  resources: TestResources,
  document: vscode.TextDocument,
): void {
  const uri = document.uri;
  const original = document.getText();
  const eol = document.eol;
  resources.defer("source buffer " + uri.toString(), async () => {
    const current = document.isClosed
      ? await vscode.workspace.openTextDocument(uri)
      : document;
    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, [
      vscode.TextEdit.replace(
        new vscode.Range(
          current.positionAt(0),
          current.positionAt(current.getText().length),
        ),
        original,
      ),
      vscode.TextEdit.setEndOfLine(eol),
    ]);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(
      current.getText(),
      original,
      "owned buffer returns to its original bytes",
    );
  });
}

async function ownFile(
  resources: TestResources,
  uri: vscode.Uri,
): Promise<void> {
  let original: Buffer | undefined;
  try {
    original = await readFile(uri.fsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  resources.defer("source file " + uri.toString(), async () => {
    const document = vscode.workspace.textDocuments.find(
      (current) => current.uri.toString() === uri.toString(),
    );
    if (document?.isDirty) {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand(
        "workbench.action.revertAndCloseActiveEditor",
      );
    }
    if (original === undefined) await rm(uri.fsPath, { force: true });
    else await writeFile(uri.fsPath, original);
  });
}
export async function activatedDocument() {
  const extension = vscode.extensions.getExtension("saltyorg.saltbox-lint");
  assert.ok(extension, "product extension is present");
  const roots = vscode.workspace.workspaceFolders!;
  assert.equal(roots.length, 2);
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[0].uri, "roles/example/defaults/main.yml"),
  );
  await vscode.window.showTextDocument(document);
  await waitFor(
    () => extension.isActive,
    "marked workspace activates without a manual command",
  );
  await waitFor(
    () =>
      diagnostics(document.uri).some(
        (d) => diagnosticCode(d) === "jinja-layout",
      ),
    "open publishes real CLI diagnostics",
  );
  return { extension, roots, document };
}
export async function runEditing(resources: TestResources): Promise<void> {
  const { extension, roots, document } = await activatedDocument();
  ownBuffer(resources, document);
  const original = document.getText();
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    document.uri,
    new vscode.Range(0, 0, document.lineCount - 1, 100),
  );
  const fix = actions.find(
    (a) =>
      a.command?.command.startsWith("saltboxLint.") &&
      a.title.includes("this file"),
  );
  assert.ok(fix?.command);
  await vscode.commands.executeCommand(
    fix.command.command,
    ...(fix.command.arguments ?? []),
  );
  assert.notEqual(document.getText(), original);
  assert.ok(document.getText().includes("{{ value }}"));
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), original);
  await vscode.commands.executeCommand("redo");
  assert.ok(document.getText().includes("{{ value }}"));
  console.log("PASS shared quick fix and undo/redo");
  const { runSafeRuleFixes } = await import("./safe-rule-fixes.ts");
  await runSafeRuleFixes(document);
  await replace(document, '---\nexample_value: ["😀",1]\n');
  const before = document.getText();
  const formats = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  assert.ok(formats.length > 0);
  const edit = new vscode.WorkspaceEdit();
  edit.set(document.uri, formats);
  await vscode.workspace.applyEdit(edit);
  assert.ok(document.getText().includes('  - "😀"'));
  assert.ok(document.getText().includes("  - 1"));
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), before);
  console.log("PASS unsaved Unicode formatting and undo");
  const crlfEditor = await vscode.window.showTextDocument(document);
  await crlfEditor.edit((edit) => edit.setEndOfLine(vscode.EndOfLine.CRLF));
  await replace(document, '---\r\nexample_value: ["😀",1]\r\n');
  const crlfBefore = document.getText();
  const crlfEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  const crlfApply = new vscode.WorkspaceEdit();
  crlfApply.set(document.uri, crlfEdits);
  await vscode.workspace.applyEdit(crlfApply);
  assert.equal(
    document.getText(),
    '---\r\nexample_value:\r\n  - "😀"\r\n  - 1\r\n',
  );
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), crlfBefore);
  await crlfEditor.edit((edit) => edit.setEndOfLine(vscode.EndOfLine.LF));
  console.log("PASS actual CRLF endpoint edits preserve terminators and undo");
  await replace(document, '---\nexample_value: "{{ dirty\n }}"\n');
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  assert.ok(
    diagnostics(document.uri).some((d) => diagnosticCode(d) === "jinja-layout"),
  );
  const dirtyDiagnostics = JSON.stringify(diagnostics(document.uri));
  await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  assert.equal(JSON.stringify(diagnostics(document.uri)), dirtyDiagnostics);
  const second = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[1].uri, "roles/example/defaults/main.yml"),
  );
  ownBuffer(resources, second);
  await vscode.window.showTextDocument(second);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  assert.ok(
    diagnostics(second.uri).some((d) => diagnosticCode(d) === "jinja-layout"),
  );
  console.log("PASS current snapshots, saved scan isolation and multi-root");
  await vscode.commands.executeCommand("saltboxLint.fixAll");
  assert.ok(second.getText().includes("{{ value }}"));
  console.log("PASS document Fix All via verified lint-fixes endpoint");
  // A malformed child response is tested through the actual editor adapter.
  const failing = new EditorIntegration(
    process.env.SALTBOX_TEST_FIXTURE_PATH ??
      join(
        extension.extensionPath,
        "bin",
        "process-fixture" + (process.platform === "win32" ? ".exe" : ""),
      ),
    {
      runProcess: (request, signal, observeFailure) => {
        return runProcess(request, signal, observeFailure, {
          spawned: () => processStarted?.(),
        });
      },
    },
  );
  let processStarted: (() => void) | undefined;
  ownJoinedResource(resources, "formatter adapter", failing);
  await failing.ready();
  await failing.join();
  try {
    const beforeFailure = second.getText();
    assert.deepEqual(await failing.format(second, "canonical"), []);
    assert.equal(second.getText(), beforeFailure);
    await replace(second, "# hang\nexample_value: 1\n");
    const cancellation = new vscode.CancellationTokenSource();
    const cancel = () => cancellation.cancel();
    resources.signal.addEventListener("abort", cancel, { once: true });
    resources.defer("formatter cancellation token", () => {
      resources.signal.removeEventListener("abort", cancel);
      cancellation.cancel();
      cancellation.dispose();
    });
    const started = Date.now();
    let admitted = false;
    processStarted = () => {
      admitted = true;
    };
    const pending = resources.operation("formatter cancellation", () =>
      failing.format(second, "canonical", cancellation.token),
    );
    await waitFor(() => admitted, "formatter process request was admitted");
    cancellation.cancel();
    assert.deepEqual(await pending, []);
    assert.ok(Date.now() - started < 2000);
    cancellation.dispose();
  } finally {
    failing.dispose();
    await failing.join();
  }
  console.log(
    "PASS malformed response rejection and formatter cancellation in extension host",
  );
  // A coexisting formatter remains registered and no user setting is rewritten.
  let alternateInvocations = 0;
  const other = vscode.languages.registerDocumentFormattingEditProvider(
    { scheme: "file", language: "yaml" },
    {
      provideDocumentFormattingEdits: () => {
        alternateInvocations++;
        return [];
      },
    },
  );
  resources.defer("coexisting formatter", () => other.dispose());
  assert.equal(
    vscode.workspace.getConfiguration("editor", second.uri).get("formatOnSave"),
    false,
  );
  assert.equal(
    vscode.workspace
      .getConfiguration("editor", second.uri)
      .get("defaultFormatter"),
    null,
  );
  await vscode.commands.executeCommand(
    "vscode.executeFormatDocumentProvider",
    second.uri,
    { tabSize: 2, insertSpaces: true },
  );
  assert.ok(
    alternateInvocations > 0,
    "alternate formatter executes while Saltbox Lint remains registered",
  );
  other.dispose();
}
export async function runDiagnostics(resources: TestResources): Promise<void> {
  const { roots, document } = await activatedDocument();
  ownBuffer(resources, document);
  const second = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[1].uri, "roles/example/defaults/main.yml"),
  );
  ownBuffer(resources, second);
  await replace(document, '---\nexample_value: \"{{ value\n }}\"\n');
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  const stale = (
    await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(0, 0, 3, 0),
    )
  ).find(
    (a) =>
      a.command?.command.startsWith("saltboxLint.") &&
      a.title.includes("this file"),
  )!;
  assert.ok(stale?.command);
  const retainedDiagnostics = diagnostics(document.uri);
  await replace(document, "---\nexample_value: untouched\n");
  await vscode.commands.executeCommand(
    stale.command!.command,
    ...(stale.command!.arguments ?? []),
  );
  assert.equal(document.getText(), "---\nexample_value: untouched\n");
  assert.deepEqual(diagnostics(document.uri), retainedDiagnostics);
  console.log(
    "PASS stale quick fix refusal and displayed diagnostic retention",
  );
  const ignored = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[0].uri, "ignored.yml"),
  );
  await vscode.window.showTextDocument(ignored);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    () =>
      diagnostics(ignored.uri).some(
        (d) => diagnosticCode(d) === "jinja-layout",
      ),
    "open ignored source diagnosed after context refresh",
  );
  await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  assert.ok(
    diagnostics(ignored.uri).some((d) => diagnosticCode(d) === "jinja-layout"),
  );
  console.log(
    "PASS open ignored-file diagnostics survive saved discovery exclusions",
  );
  await vscode.commands.executeCommand(
    "workbench.action.revertAndCloseActiveEditor",
  );
  assert.ok(
    !vscode.window.visibleTextEditors.some(
      (editor) => editor.document.uri.toString() === ignored.uri.toString(),
    ),
  );
  await waitFor(
    () => diagnostics(ignored.uri).length === 0,
    "closed tab clears diagnostics",
  );
  console.log("PASS close clears diagnostics");
  const renameFrom = vscode.Uri.joinPath(roots[0].uri, "rename.yml");
  const renameTo = vscode.Uri.joinPath(roots[0].uri, "renamed.yml");
  await ownFile(resources, renameFrom);
  await ownFile(resources, renameTo);
  await vscode.workspace.fs.writeFile(
    renameFrom,
    Buffer.from('value: \"{{ value\n }}\"\n'),
  );
  const renameDocument = await vscode.workspace.openTextDocument(renameFrom);
  await vscode.window.showTextDocument(renameDocument);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    () => diagnostics(renameFrom).length > 0,
    "rename fixture diagnosed",
  );
  const rename = new vscode.WorkspaceEdit();
  rename.renameFile(renameFrom, renameTo, { overwrite: true });
  await vscode.workspace.applyEdit(rename);
  await waitFor(
    () => diagnostics(renameFrom).length === 0,
    "rename clears old URI",
  );
  const renamedDocument = await vscode.workspace.openTextDocument(renameTo);
  await vscode.window.showTextDocument(renamedDocument);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    () => diagnostics(renameTo).length > 0,
    "renamed source checked",
  );
  console.log("PASS rename clears old identity and diagnoses new identity");
  const rootConfiguration = vscode.workspace.getConfiguration(
    "saltboxLint",
    roots[0].uri,
  );
  const previousRoot =
    rootConfiguration.inspect<string>("root")?.workspaceFolderValue;
  resources.defer("folder root configuration", () =>
    rootConfiguration.update(
      "root",
      previousRoot,
      vscode.ConfigurationTarget.WorkspaceFolder,
    ),
  );
  await vscode.workspace
    .getConfiguration("saltboxLint", roots[0].uri)
    .update(
      "root",
      "roles/example",
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  await waitFor(
    () => diagnostics(renameTo).length === 0,
    "root override invalidates diagnostics",
  );
  await vscode.workspace
    .getConfiguration("saltboxLint", roots[0].uri)
    .update("root", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await replace(second, '---\nexample_value: \"{{ value\n }}\"\n');
  await vscode.window.showTextDocument(second);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    () => diagnostics(second.uri).length > 0,
    "second root diagnosed before removal",
  );
  resources.defer("second workspace folder", async () => {
    if (vscode.workspace.workspaceFolders?.length === 2) return;
    assert.equal(
      vscode.workspace.updateWorkspaceFolders(1, 0, {
        uri: roots[1].uri,
        name: roots[1].name,
      }),
      true,
    );
    await waitFor(
      () => vscode.workspace.workspaceFolders?.length === 2,
      "second workspace folder restoration settles",
    );
  });
  assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true);
  await waitFor(
    () =>
      vscode.workspace.workspaceFolders?.length === 1 &&
      diagnostics(second.uri).length === 0,
    "removed root diagnostics cleared",
  );
  console.log(
    "PASS folder root override and workspace root removal invalidate results",
  );
  const relatedUri = vscode.Uri.joinPath(roots[0].uri, "related.yml");
  await ownFile(resources, relatedUri);
  await vscode.workspace.fs.writeFile(relatedUri, Buffer.from("😀x\n"));
  const finding = {
    path: "main.yml",
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    span: { start: 0, end: 1 },
    rule_id: "related",
    severity: "error" as const,
    message: "related source",
    related: [
      {
        path: "related.yml",
        range: { start: { line: 1, column: 2 }, end: { line: 1, column: 3 } },
        span: { start: 4, end: 5 },
        message: "saved location",
      },
    ],
  };
  const rendered = await renderDiagnostics(
    [finding],
    new SnapshotIndex("x"),
    roots[0].uri.fsPath,
  );
  assert.equal(
    rendered[0].relatedInformation?.[0].location.range.start.character,
    2,
  );
  const relatedDocument = await vscode.workspace.openTextDocument(relatedUri);
  await replace(relatedDocument, "dirty\n");
  assert.equal(
    (
      await renderDiagnostics(
        [finding],
        new SnapshotIndex("x"),
        roots[0].uri.fsPath,
      )
    )[0].relatedInformation,
    undefined,
  );
  console.log(
    "PASS related locations use saved UTF16 coordinates and omit dirty buffers",
  );
}
