import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EditorIntegration } from "../../src/editor.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const diagnostics = (uri: vscode.Uri) =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === "saltbox-lint");
async function waitFor(test: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (!test() && Date.now() < deadline) await pause(25);
  assert.ok(test(), message);
}
async function actions(document: vscode.TextDocument) {
  return (
    await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
    )
  ).filter((a) => a.title.startsWith("Saltbox Lint:"));
}
async function formatting(document: vscode.TextDocument) {
  return (
    (await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      document.uri,
      { tabSize: 2, insertSpaces: true },
    )) ?? []
  );
}
async function marker(root: vscode.Uri, present: boolean) {
  const uri = vscode.Uri.joinPath(root, ".saltbox-lint");
  if (present) await vscode.workspace.fs.writeFile(uri, new Uint8Array());
  else await vscode.workspace.fs.delete(uri, { recursive: true });
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
export async function runMarkers(): Promise<void> {
  const extension = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  const roots = vscode.workspace.workspaceFolders!;
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[0].uri, "roles/example/defaults/main.yml"),
  );
  await vscode.window.showTextDocument(document, { preview: false });
  await pause(700);
  assert.equal(
    extension.isActive,
    false,
    "opening unmarked YAML must not activate the extension",
  );
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  assert.equal(
    extension.isActive,
    true,
    "manual command bootstraps the marker watcher",
  );
  assert.deepEqual(
    diagnostics(document.uri),
    [],
    "unmarked root must not publish diagnostics through manual command activation",
  );
  assert.deepEqual(await formatting(document), []);
  assert.deepEqual(await actions(document), []);
  console.log(
    "PASS unmarked YAML startup stays inactive; implicit command activation remains inert",
  );

  const temporary = await mkdtemp(join(tmpdir(), "saltbox-marker-"));
  const log = join(temporary, "process.log");
  process.env.SALTBOX_TEST_PROCESS_LOG = log;
  const isolated = new EditorIntegration(
    process.env.SALTBOX_TEST_FIXTURE_PATH!,
  );
  try {
    await isolated.check(document, true);
    await isolated.checkWorkspace();
    assert.deepEqual(await isolated.format(document, "canonical"), []);
    await isolated.fixAll(document.uri);
    assert.equal(
      existsSync(log),
      false,
      "unmarked roots must not spawn any CLI process",
    );
    assert.deepEqual(isolated.providerDocuments(), []);
  } finally {
    // Output-channel creation crosses the main-thread boundary asynchronously.
    await pause(100);
    isolated.dispose();
  }

  await marker(roots[0].uri, true);
  await waitFor(
    () => diagnostics(document.uri).some((d) => d.code === "jinja-layout"),
    "marker creation starts fresh checks",
  );
  const original = document.getText();
  assert.ok(
    (await formatting(document)).length > 0,
    "marked root formatter available",
  );
  const savedActions = await actions(document);
  assert.ok(savedActions.length > 0);
  const second = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[1].uri, "roles/example/defaults/main.yml"),
  );
  await vscode.window.showTextDocument(second, { preview: false });
  await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  assert.deepEqual(diagnostics(second.uri), []);
  assert.deepEqual(await actions(second), []);
  assert.deepEqual(await formatting(second), []);
  assert.ok(diagnostics(document.uri).length > 0);
  console.log(
    "PASS mixed roots isolate diagnostics, workspace scans, actions and formatting",
  );

  await marker(roots[1].uri, true);
  await waitFor(
    () => diagnostics(second.uri).length > 0,
    "second root opts in",
  );
  await replace(document, original + "# hang\n");
  const pending = new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!);
  try {
    const check = pending.check(document);
    const format = pending.format(document, "canonical");
    await waitFor(
      () =>
        existsSync(log) &&
        ["check", "format"].every((command) =>
          readFileSync(log, "utf8")
            .split("\n")
            .some((line) => line.split(" ")[1] === command),
        ),
      "both real CLI processes started",
    );
    const pids = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => Number(line.split(" ")[0]));
    await marker(roots[0].uri, false);
    assert.deepEqual(
      await Promise.race([
        format,
        pause(5000).then(() => {
          throw new Error("marker removal did not cancel pending format");
        }),
      ]),
      [],
    );
    await check;
    await waitFor(
      () =>
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        }),
      "marker removal kills pending CLI processes",
    );
    assert.equal(pending.providerDocuments().includes(document), false);
  } finally {
    pending.dispose();
    delete process.env.SALTBOX_TEST_PROCESS_LOG;
    await rm(temporary, { recursive: true, force: true });
  }
  await replace(document, original);
  await waitFor(
    () => diagnostics(document.uri).length === 0,
    "removed marker clears diagnostics",
  );
  assert.ok(
    diagnostics(second.uri).length > 0,
    "unaffected marked root remains diagnosed",
  );
  for (const action of savedActions.filter(
    (a) => a.command?.command === "saltboxLint.applySharedFix",
  ))
    await vscode.commands.executeCommand(
      action.command!.command,
      ...action.command!.arguments!,
    );
  await vscode.commands.executeCommand("saltboxLint.fixAll", document.uri);
  assert.equal(
    document.getText(),
    original,
    "cached/manual fixes cannot bypass marker removal",
  );
  assert.deepEqual(await formatting(document), []);
  assert.deepEqual(await actions(document), []);
  console.log(
    "PASS marker deletion cancels real pending processes, clears stale state and preserves other roots",
  );

  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint"),
  );
  await pause(300);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  assert.deepEqual(
    diagnostics(document.uri),
    [],
    "marker directory does not opt in",
  );
  await marker(roots[0].uri, false);
  await marker(roots[0].uri, true);
  await waitFor(
    () => diagnostics(document.uri).length > 0,
    "regular marker re-add restores fresh checks",
  );
  assert.ok((await formatting(document)).length > 0);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint"),
    Buffer.from("contents are ignored\n"),
  );
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    () => diagnostics(document.uri).length > 0,
    "nonempty marker contents are ignored",
  );
  const renamedMarker = vscode.Uri.joinPath(
    roots[0].uri,
    ".saltbox-lint-disabled",
  );
  const rename = new vscode.WorkspaceEdit();
  rename.renameFile(
    vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint"),
    renamedMarker,
  );
  assert.equal(await vscode.workspace.applyEdit(rename), true);
  await waitFor(
    () => diagnostics(document.uri).length === 0,
    "marker rename withdraws opt-in",
  );
  assert.deepEqual(await formatting(document), []);
  await vscode.workspace.fs.rename(
    renamedMarker,
    vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint"),
  );
  await waitFor(
    () => diagnostics(document.uri).length > 0,
    "renaming marker back restores fresh checks",
  );
  console.log(
    "PASS nonregular marker rejected and regular marker re-add restores providers",
  );
  const nested = vscode.Uri.joinPath(roots[0].uri, "roles/example");
  const nestedIndex = vscode.workspace.workspaceFolders!.length;
  const updateFolders = async (count: number, add = false) => {
    await new Promise<void>((resolve, reject) => {
      const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        listener.dispose();
        resolve();
      });
      if (
        !vscode.workspace.updateWorkspaceFolders(
          nestedIndex,
          count,
          ...(add ? [{ uri: nested }] : []),
        )
      ) {
        listener.dispose();
        reject(new Error("workspace change refused"));
      }
    });
  };
  await updateFolders(0, true);
  try {
    await waitFor(
      () => diagnostics(document.uri).length === 0,
      "new unmarked nested owner clears parent diagnostics",
    );
    const closedUri = vscode.Uri.joinPath(nested, "defaults/closed.yml");
    await vscode.workspace.fs.writeFile(closedUri, Buffer.from(original));
    await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
    assert.deepEqual(
      diagnostics(closedUri),
      [],
      "parent saved scan cannot publish into unmarked closed child file",
    );
    assert.deepEqual(diagnostics(document.uri), []);
    assert.deepEqual(await formatting(document), []);
    assert.deepEqual(await actions(document), []);
    await marker(nested, true);
    await waitFor(
      () => diagnostics(document.uri).length > 0,
      "nested root opts in independently",
    );
    assert.ok((await formatting(document)).length > 0);
    await marker(nested, false);
  } finally {
    await updateFolders(1);
  }
  console.log(
    "PASS nested unmarked workspace ownership excludes parent providers and saved scans",
  );

  const config = vscode.workspace.getConfiguration("saltboxLint", roots[0].uri);
  await config.update(
    "root",
    "roles/example",
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
  try {
    await waitFor(
      () => diagnostics(document.uri).length === 0,
      "override requires its own marker",
    );
    await marker(nested, true);
    await waitFor(
      () => diagnostics(document.uri).length > 0,
      "nested override marker restores checks",
    );
    assert.ok((await formatting(document)).length > 0);
  } finally {
    await marker(nested, false);
    await config.update(
      "root",
      undefined,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  }

  const externalRoot = join(roots[0].uri.fsPath, "..", "external-root");
  await mkdir(externalRoot, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", externalRoot]).status, 0);
  const alias = join(roots[0].uri.fsPath, "external");
  await symlink(
    externalRoot,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const specialUri = vscode.Uri.file(join(alias, "[value]{one}.yml"));
  await vscode.workspace.fs.writeFile(specialUri, Buffer.from(original));
  const special = await vscode.workspace.openTextDocument(specialUri);
  await vscode.window.showTextDocument(special, { preview: false });
  await config.update(
    "root",
    externalRoot,
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
  try {
    await marker(vscode.Uri.file(externalRoot), true);
    await vscode.commands.executeCommand("saltboxLint.checkDocument");
    await waitFor(
      () => diagnostics(special.uri).length > 0,
      "external override marker watches source host",
    );
    assert.ok(
      (await formatting(special)).length > 0,
      "literal glob characters retain formatter registration",
    );
    await vscode.languages.setTextDocumentLanguage(special, "ansible");
    await waitFor(
      () => diagnostics(special.uri).length > 0,
      "Ansible language reopens marked document",
    );
    assert.ok((await formatting(special)).length > 0);
    await marker(vscode.Uri.file(externalRoot), false);
    await waitFor(
      () => diagnostics(special.uri).length === 0,
      "outside workspace marker removal observed",
    );
    assert.deepEqual(await formatting(special), []);
  } finally {
    await config.update(
      "root",
      undefined,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  }
  console.log(
    "PASS nested/external root overrides and literal-path YAML/Ansible provider lifecycle",
  );
}
