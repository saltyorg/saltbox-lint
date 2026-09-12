import * as vscode from "vscode";
import assert from "node:assert/strict";
import { EditorIntegration } from "../../src/editor.ts";
import { renderDiagnostics } from "../../src/diagnostics.ts";
import { SnapshotIndex } from "../../src/protocol.ts";
import { join } from "node:path";

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
export async function run(): Promise<void> {
  if (process.env.SALTBOX_TEST_UNTRUSTED === "1") {
    assert.equal(vscode.workspace.isTrusted, false);
    const uri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      "roles/example/defaults/main.yml",
    );
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    assert.equal(
      vscode.extensions.getExtension("saltyorg.saltbox-lint")?.isActive ??
        false,
      false,
    );
    assert.deepEqual(diagnostics(uri), []);
    console.log(
      "PASS native restricted workspace disables extension execution",
    );
    return;
  }
  const extension = vscode.extensions.getExtension("saltyorg.saltbox-lint");
  assert.ok(extension);
  await extension.activate();
  const roots = vscode.workspace.workspaceFolders!;
  assert.equal(roots.length, 2);
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[0].uri, "roles/example/defaults/main.yml"),
  );
  await vscode.window.showTextDocument(document);
  await waitFor(
    () => diagnostics(document.uri).some((d) => d.code === "jinja-layout"),
    "open should publish real CLI Jinja diagnostics",
  );
  console.log("PASS open diagnostics from bundled CLI");
  const original = document.getText();
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    document.uri,
    new vscode.Range(0, 0, document.lineCount - 1, 100),
  );
  const fix = actions.find((a) => a.title.includes("this file"));
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
  assert.ok(diagnostics(document.uri).some((d) => d.code === "jinja-layout"));
  const dirtyDiagnostics = JSON.stringify(diagnostics(document.uri));
  await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  assert.equal(JSON.stringify(diagnostics(document.uri)), dirtyDiagnostics);
  const second = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[1].uri, "roles/example/defaults/main.yml"),
  );
  await vscode.window.showTextDocument(second);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  assert.ok(diagnostics(second.uri).some((d) => d.code === "jinja-layout"));
  console.log("PASS current snapshots, saved scan isolation and multi-root");
  await vscode.commands.executeCommand("saltboxLint.fixAll");
  assert.ok(second.getText().includes("{{ value }}"));
  console.log("PASS document Fix All via verified lint-fixes endpoint");
  // A malformed child response is tested through the actual editor adapter.
  const failing = new EditorIntegration(
    join(
      extension.extensionPath,
      "bin",
      "process-fixture" + (process.platform === "win32" ? ".exe" : ""),
    ),
  );
  try {
    const beforeFailure = second.getText();
    assert.deepEqual(await failing.format(second, "canonical"), []);
    assert.equal(second.getText(), beforeFailure);
    await replace(second, "# hang\nexample_value: 1\n");
    const cancellation = new vscode.CancellationTokenSource();
    const started = Date.now();
    const pending = failing.format(second, "canonical", cancellation.token);
    setTimeout(() => cancellation.cancel(), 50);
    assert.deepEqual(await pending, []);
    assert.ok(Date.now() - started < 2000);
    cancellation.dispose();
  } finally {
    failing.dispose();
  }
  console.log(
    "PASS malformed response rejection and formatter cancellation in extension host",
  );
  // A coexisting formatter remains registered and no user setting is rewritten.
  const other = vscode.languages.registerDocumentFormattingEditProvider(
    { scheme: "file", language: "yaml" },
    { provideDocumentFormattingEdits: () => [] },
  );
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
  other.dispose();
  await replace(document, '---\nexample_value: \"{{ value\n }}\"\n');
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  const stale = (
    await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(0, 0, 3, 0),
    )
  ).find((a) => a.title.includes("this file"))!;
  assert.ok(stale?.command);
  await replace(document, "---\nexample_value: untouched\n");
  await vscode.commands.executeCommand(
    stale.command!.command,
    ...(stale.command!.arguments ?? []),
  );
  assert.equal(document.getText(), "---\nexample_value: untouched\n");
  assert.equal(diagnostics(document.uri).length, 0);
  console.log("PASS stale quick fix refusal and change invalidation");
  const ignored = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[0].uri, "ignored.yml"),
  );
  await vscode.window.showTextDocument(ignored);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    () => diagnostics(ignored.uri).some((d) => d.code === "jinja-layout"),
    "open ignored source diagnosed after context refresh",
  );
  await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  assert.ok(diagnostics(ignored.uri).some((d) => d.code === "jinja-layout"));
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
