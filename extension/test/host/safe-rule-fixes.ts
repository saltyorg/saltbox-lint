import * as vscode from "vscode";
import assert from "node:assert/strict";

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
async function quickFix(document: vscode.TextDocument) {
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    document.uri,
    new vscode.Range(0, 0, document.lineCount, 0),
  );
  const fix = actions.find(
    (action) =>
      action.command?.command.startsWith("saltboxLint.") &&
      action.title.includes("this file"),
  );
  assert.ok(fix?.command, "Saltbox public quick fix is available");
  return fix.command;
}
async function execute(command: vscode.Command) {
  await vscode.commands.executeCommand(
    command.command,
    ...(command.arguments ?? []),
  );
}

export async function runSafeRuleFixes(
  document: vscode.TextDocument,
): Promise<void> {
  await vscode.window.showTextDocument(document);
  const header =
    "####################\n# Title: Example 🌨\n# Author(s): salty\n# URL: https://example.com\n# GNU General Public License v3.0\n---\n";
  const input =
    header +
    '# retained owner comment\nexample_role_secret_lookup: "{{ (a if flag else b) }}"\nexample_role_docker_healthcheck:\n  test: [CMD, curl, "{{ (path if flag else fallback) }}"] # retain\nvalid: \'literal 😀\'\n';
  const want =
    header +
    '# retained owner comment\n# Skip docs\nexample_role_secret_lookup: "{{ a if flag else b }}"\nexample_role_docker_healthcheck:\n  test: # retain\n    - CMD\n    - curl\n    - "{{ path if flag else fallback }}"\nvalid: \'literal 😀\'\n';
  await replace(document, input);
  const action = await quickFix(document);
  await execute(action);
  assert.equal(
    document.getText(),
    want,
    "mixed fixes preserve data and valid literal contents",
  );
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), input);
  await vscode.commands.executeCommand("redo");
  assert.equal(document.getText(), want);
  await replace(document, input);
  await vscode.commands.executeCommand("saltboxLint.fixAll", document.uri);
  assert.equal(document.getText(), want, "Fix All shares quick-fix authority");
  await vscode.commands.executeCommand("saltboxLint.fixAll", document.uri);
  assert.equal(document.getText(), want, "Fix All is idempotent");
  await replace(document, input);
  const stale = await quickFix(document);
  await replace(document, want + "# user edit\n");
  await execute(stale);
  assert.equal(
    document.getText(),
    want + "# user edit\n",
    "stale structural action is refused",
  );
  console.log(
    "PASS mixed healthcheck/documentation/expression quick fix, Fix All, undo/redo and stale refusal",
  );

  const taskURI = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders![0].uri,
    "roles/example/tasks/safe-rule-fixes.yml",
  );
  const grouped =
    "(cloudflare_record is defined and cloudflare_record | length > 0)";
  const tasks =
    header +
    "- name: Preserve Cloudflare condition\n  ansible.builtin.debug: {msg: ok}\n  when: " +
    grouped +
    "\n- name: Group condition\n  ansible.builtin.debug: {msg: ok}\n  when: value is defined\n";
  await vscode.workspace.fs.writeFile(taskURI, Buffer.from(tasks));
  const task = await vscode.workspace.openTextDocument(taskURI);
  try {
    await vscode.window.showTextDocument(task);
    const action = await quickFix(task);
    await execute(action);
    const expected = tasks.replace(
      "  when: value is defined",
      "  when: (value is defined)",
    );
    assert.equal(
      task.getText(),
      expected,
      "non-whitespace expression action preserves grouped Cloudflare condition",
    );
    await vscode.commands.executeCommand("undo");
    assert.equal(task.getText(), tasks);
    await vscode.commands.executeCommand("redo");
    assert.equal(task.getText(), expected);
    await vscode.commands.executeCommand("saltboxLint.fixAll", task.uri);
    assert.equal(task.getText(), expected);
  } finally {
    await vscode.commands.executeCommand(
      "workbench.action.revertAndCloseActiveEditor",
    );
    await vscode.workspace.fs.delete(taskURI);
    await vscode.window.showTextDocument(document);
  }
  console.log("PASS expression quick fix and grouped Cloudflare preservation");
}
