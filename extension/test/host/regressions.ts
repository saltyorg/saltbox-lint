import * as vscode from "vscode";
import assert from "node:assert/strict";
import { mkdir, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EditorIntegration } from "../../src/editor.ts";
const jinja = '---\nvalue: "{{ value\n }}"\n';
async function waitFor(test: () => boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (!test() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  assert.ok(test(), message);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function diagnostics(uri: vscode.Uri) {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === "saltbox-lint");
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
async function actions(document: vscode.TextDocument) {
  return (
    await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
    )
  ).filter((a) => a.title.includes("this file"));
}
async function open(uri: vscode.Uri, text: string) {
  let existing: string | undefined;
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
      "utf8",
    );
  } catch {
    /* New test fixture. */
  }
  if (existing !== text)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(() => diagnostics(uri).length > 0, "fixture diagnosed");
  return doc;
}
async function updateFolders(
  start: number,
  count: number,
  ...folders: { uri: vscode.Uri }[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      listener.dispose();
      resolve();
    });
    if (!vscode.workspace.updateWorkspaceFolders(start, count, ...folders)) {
      listener.dispose();
      reject(new Error("workspace update was refused"));
    }
  });
}
export async function runRegressions(): Promise<void> {
  const extension = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  await extension.activate();
  const roots = vscode.workspace.workspaceFolders!;
  const failures: string[] = [];
  const run = async (name: string, test: () => Promise<void>) => {
    if (
      process.env.SALTBOX_REVIEW_CASE &&
      !name.startsWith(process.env.SALTBOX_REVIEW_CASE)
    )
      return;
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}`, error);
    }
  };
  await run(
    "I1 unrelated edits preserve current actions and pending format",
    async () => {
      const document = await open(
        vscode.Uri.joinPath(roots[0].uri, "independent.yml"),
        jinja,
      );
      const markdownUri = vscode.Uri.joinPath(roots[1].uri, "readme.md");
      await vscode.workspace.fs.writeFile(markdownUri, Buffer.from("one\n"));
      const markdown = await vscode.workspace.openTextDocument(markdownUri);
      assert.ok((await actions(document)).length > 0);
      await replace(markdown, "two\n");
      assert.ok(
        (await actions(document)).length > 0,
        "unrelated Markdown invalidated YAML actions",
      );
      const otherYaml = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(roots[1].uri, "roles/example/defaults/main.yml"),
      );
      await replace(otherYaml, '---\nexample_value: "{{ other\n }}"\n');
      await otherYaml.save();
      await waitFor(
        () => diagnostics(otherYaml.uri).some((d) => d.code === "jinja-layout"),
        "other root saved diagnostics refreshed",
      );
      assert.ok(
        (await actions(document)).length > 0,
        "another root's YAML save invalidated cached actions",
      );
      const editor = new EditorIntegration(
        join(
          extension.extensionPath,
          "bin",
          "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
        ),
      );
      const changes = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) editor.change(e.document);
      });
      try {
        await replace(document, 'value: ["😀",1]\n');
        const pending = editor.format(document, "canonical");
        await replace(markdown, "three\n");
        assert.ok(
          (await pending).length > 0,
          "unrelated edit discarded pending format",
        );
      } finally {
        changes.dispose();
        editor.dispose();
      }
    },
  );
  await run(
    "I1 unrelated Markdown preserves a pending actual CLI format",
    async () => {
      const document = await open(
        vscode.Uri.joinPath(roots[0].uri, "pending.yml"),
        jinja,
      );
      const markdownUri = vscode.Uri.joinPath(roots[1].uri, "pending.md");
      await vscode.workspace.fs.writeFile(markdownUri, Buffer.from("one"));
      const markdown = await vscode.workspace.openTextDocument(markdownUri);
      const editor = new EditorIntegration(
        join(
          extension.extensionPath,
          "bin",
          "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
        ),
      );
      const changes = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length) editor.change(event.document);
      });
      try {
        await replace(document, "value: [1,2]\n");
        const pending = editor.format(document, "canonical");
        await replace(markdown, "changed");
        assert.ok(
          (await pending).length > 0,
          "unrelated edit discarded pending format",
        );
      } finally {
        changes.dispose();
        editor.dispose();
      }
    },
  );
  await run(
    "I2 closing one of two tabs preserves the remaining owner",
    async () => {
      const document = await open(
        vscode.Uri.joinPath(roots[0].uri, "two-tabs.yml"),
        jinja,
      );
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
      const owners = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === document.uri.toString(),
        );
      assert.equal(owners.length, 2);
      await vscode.window.tabGroups.close(owners[0], true);
      assert.ok(
        diagnostics(document.uri).length > 0,
        "first tab close cleared a still-owned document",
      );
      assert.ok((await actions(document)).length > 0);
    },
  );
  await run(
    "I2 closed retained models stay cleared through context refresh until reopen",
    async () => {
      const document = await open(
        vscode.Uri.joinPath(roots[0].uri, "closed.yml"),
        jinja,
      );
      await actions(document);
      const owners = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === document.uri.toString(),
        );
      await vscode.window.tabGroups.close(owners, true);
      await waitFor(
        () => diagnostics(document.uri).length === 0,
        "close clears diagnostics",
      );
      const other = await open(
        vscode.Uri.joinPath(roots[0].uri, "refresh.yml"),
        jinja,
      );
      await replace(other, jinja + "\n");
      await other.save();
      await waitFor(
        () => diagnostics(other.uri).length > 0,
        "refresh completed for active owner",
      );
      await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
      assert.equal(
        diagnostics(document.uri).length,
        0,
        "context refresh republished a closed tab",
      );
      await vscode.window.showTextDocument(document, { preview: false });
      await waitFor(
        () => diagnostics(document.uri).length > 0,
        "reopen rechecks retained model",
      );
    },
  );
  await run(
    "I4 dirty symlink workspace suppresses canonical saved diagnostics",
    async () => {
      const parent = join(roots[0].uri.fsPath, "..", "alias-case");
      const diskRoot = join(parent, "real");
      const aliasRoot = join(parent, "alias");
      await mkdir(join(diskRoot, "roles/example/defaults"), {
        recursive: true,
      });
      spawnSync("git", ["init", "-q", diskRoot]);
      try {
        await symlink(
          diskRoot,
          aliasRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(join(aliasRoot, "roles/example/defaults/main.yml")),
        Buffer.from(jinja),
      );
      const index = vscode.workspace.workspaceFolders!.length;
      await updateFolders(index, 0, { uri: vscode.Uri.file(aliasRoot) });
      await waitFor(
        () => vscode.workspace.workspaceFolders!.length === index + 1,
        "alias workspace added",
      );
      try {
        const alias = vscode.Uri.file(
          join(aliasRoot, "roles/example/defaults/main.yml"),
        );
        const document = await open(alias, jinja);
        const canonical = vscode.Uri.file(await realpath(alias.fsPath));
        const saved = spawnSync(
          join(
            extension.extensionPath,
            "bin",
            "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
          ),
          ["check", "--root", diskRoot, "--format", "json", "."],
          { cwd: diskRoot, encoding: "utf8" },
        );
        assert.ok(
          JSON.parse(saved.stdout).diagnostics.some(
            (d: { rule_id: string }) => d.rule_id === "jinja-layout",
          ),
          "saved fixture must be discoverable and dirty-different",
        );
        await replace(document, "value: clean\n");
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        assert.ok(!diagnostics(alias).some((d) => d.code === "jinja-layout"));
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
        assert.equal(
          diagnostics(canonical).length,
          0,
          "saved diagnostics leaked through canonical URI",
        );
        assert.ok(!diagnostics(alias).some((d) => d.code === "jinja-layout"));
        await replace(document, 'value: "{{ unsaved\n }}"\n');
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        await waitFor(
          () => diagnostics(alias).length > 0,
          "dirty alias diagnosed",
        );
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
        assert.equal(diagnostics(canonical).length, 0);
        assert.ok(diagnostics(alias).length > 0);
      } finally {
        await updateFolders(index, 1);
        await waitFor(
          () => vscode.workspace.workspaceFolders!.length === index,
          "alias workspace removed",
        );
      }
      await updateFolders(index, 0, { uri: vscode.Uri.file(diskRoot) });
      await waitFor(
        () => vscode.workspace.workspaceFolders!.length === index + 1,
        "canonical replacement root added",
      );
      try {
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
        assert.ok(
          diagnostics(
            vscode.Uri.file(join(diskRoot, "roles/example/defaults/main.yml")),
          ).length > 0,
          "removed alias still owns a canonical scan source",
        );
      } finally {
        await updateFolders(index, 1);
        await waitFor(
          () => vscode.workspace.workspaceFolders!.length === index,
          "replacement root removed",
        );
      }
    },
  );
  await run(
    "I5 a retained quick fix cannot bind to a replacement report",
    async () => {
      const folder = vscode.Uri.joinPath(roots[0].uri, "roles/example/tasks");
      await vscode.workspace.fs.createDirectory(folder);
      const source =
        '################################\n# Settings\n################################\nvalue: "{{ a\n | f }}"\n';
      const document = await open(
        vscode.Uri.joinPath(folder, "main.yml"),
        source,
      );
      let original: vscode.CodeAction | undefined;
      for (let attempt = 0; attempt < 100 && !original; attempt++) {
        original = (await actions(document)).find((action) =>
          action.title.includes("Jinja"),
        );
        if (!original) await pause(25);
      }
      assert.ok(original?.command);
      const config = vscode.workspace.getConfiguration(
        "saltboxLint",
        roots[0].uri,
      );
      try {
        await config.update(
          "root",
          "roles/example/tasks",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        await waitFor(
          () =>
            diagnostics(document.uri).some((d) => d.code === "section-spacing"),
          "root configuration refresh completed",
        );
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        await waitFor(
          () =>
            diagnostics(document.uri).some((d) => d.code === "section-spacing"),
          "new root report has reassigned fix IDs",
        );
        const replacement = await actions(document);
        assert.ok(
          replacement.some((action) => action.title.includes("blank lines")),
        );
        assert.equal(document.getText(), source);
        await vscode.commands.executeCommand(
          original.command.command,
          ...(original.command.arguments ?? []),
        );
        assert.equal(
          document.getText(),
          source,
          "old action applied new report's fix-1",
        );
      } finally {
        await config.update(
          "root",
          undefined,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
      }
    },
  );
  assert.deepEqual(failures, [], "review regressions");
}
