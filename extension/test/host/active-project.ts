import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EditorIntegration, tabDocumentUris } from "../../src/editor.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const findings = (uri: vscode.Uri) =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === "saltbox-lint");
async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await pause(25);
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
const show = async (document: vscode.TextDocument) =>
  vscode.window.showTextDocument(
    document.isClosed
      ? await vscode.workspace.openTextDocument(document.uri)
      : document,
    { preview: false },
  );
export async function runActiveProject(): Promise<void> {
  const roots = vscode.workspace.workspaceFolders!;
  const config = vscode.workspace.getConfiguration("saltboxLint");
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-active-project-"));
  const log = join(temporary, "process.log");
  const component = process.env.SALTBOX_TEST_SAVE_SCOPE === "1";
  if (component) process.env.SALTBOX_TEST_PROCESS_LOG = log;
  const invocations = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
  const editor = component
    ? new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!)
    : undefined;
  const subscriptions: vscode.Disposable[] = [];
  if (editor)
    subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) =>
        editor.open(document),
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length) editor.change(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument((document) =>
        editor.saved(document),
      ),
      vscode.workspace.onDidCloseTextDocument((document) =>
        editor.close(document),
      ),
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        for (const [tabs, operation] of [
          [event.closed, "close"],
          [event.opened, "open"],
        ] as const)
          for (const tab of tabs)
            for (const uri of tabDocumentUris(tab)) {
              const document = vscode.workspace.textDocuments.find(
                (doc) => doc.uri.toString() === uri.toString(),
              );
              if (document) editor[operation](document);
            }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("saltboxLint.root"))
          editor.configureRoots();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        editor.configureRoots(),
      ),
    );
  else {
    const product = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
    assert.ok(product);
    if (process.env.SALTBOX_TEST_VSIX) {
      assert.ok(
        product.extensionPath.startsWith(
          process.env.SALTBOX_TEST_EXTENSIONS_DIR!,
        ),
        "active-project test must load the installed product",
      );
      console.log(
        `PASS installed active-project product ${product.id} ${product.packageJSON.version} ${product.extensionPath}`,
      );
    }
    await product.activate();
  }
  const check = async (document: vscode.TextDocument) => {
    if (editor) await editor.check(document, true);
    else {
      await show(document);
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
    }
  };
  const workspaceCheck = () =>
    editor
      ? editor.checkWorkspace()
      : vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  const actions = async (document: vscode.TextDocument) => {
    const range = new vscode.Range(0, 0, document.lineCount, 0);
    const result = editor
      ? editor.actions(document, range)
      : await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider",
          document.uri,
          range,
        );
    return result.filter((action) =>
      action.command?.command.startsWith("saltboxLint."),
    );
  };
  const failures: string[] = [];
  const run = async (name: string, test: () => Promise<void>) => {
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}`, error);
    }
  };
  const uris = roots.map((root) =>
    vscode.Uri.joinPath(root.uri, "roles/example/defaults/main.yml"),
  );
  const closed = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/example/defaults/closed.yml",
  );
  const related = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/example/defaults/related.yml",
  );
  const other = vscode.languages.createDiagnosticCollection(
    "active-project-control",
  );
  try {
    await waitFor(
      () => uris.every((uri) => findings(uri).length > 0),
      "startup without file context shows both cached projects",
    );
    assert.equal(
      config.inspect<boolean>("activeProjectOnly")?.defaultValue,
      true,
    );
    assert.equal(
      config.inspect<boolean>("activeProjectOnly")?.workspaceValue,
      undefined,
    );
    console.log(
      "PASS actual default-on startup overview before a file is selected",
    );
    const first = await vscode.workspace.openTextDocument(uris[0]);
    const second = await vscode.workspace.openTextDocument(uris[1]);
    const readme = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(roots[0].uri, "README.md"),
    );
    const relatedDocument = await vscode.workspace.openTextDocument(related);
    await show(readme);
    await show(second);
    await show(relatedDocument);
    await show(first);
    await check(first);
    await check(second);
    await check(relatedDocument);
    await show(first);
    await pause(400);
    const control = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      "other extension",
    );
    control.source = "active-project-control";
    other.set(second.uri, [control]);
    await run(
      "active project and same-project Markdown switch reuse cached diagnostics",
      async () => {
        await waitFor(
          () =>
            findings(first.uri).length > 0 && findings(second.uri).length === 0,
          "default filter hides second project",
        );
        const before = findings(first.uri);
        const beforeActions = await actions(first);
        const count = invocations().length;
        await show(readme);
        await waitFor(
          () => findings(first.uri).length > 0,
          "Markdown selects its project",
        );
        await show(second);
        await waitFor(
          () =>
            findings(first.uri).length === 0 && findings(second.uri).length > 0,
          "second project selected",
        );
        await show(first);
        await waitFor(
          () =>
            findings(first.uri).length > 0 && findings(second.uri).length === 0,
          "first cached project restored",
        );
        assert.deepEqual(findings(first.uri), before);
        assert.deepEqual(
          await actions(first),
          beforeActions,
          "display switching preserves current report authority",
        );
        await config.update(
          "activeProjectOnly",
          false,
          vscode.ConfigurationTarget.Workspace,
        );
        await waitFor(
          () => uris.every((uri) => findings(uri).length > 0),
          "disabled filter restores all projects",
        );
        await config.update(
          "activeProjectOnly",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
        await waitFor(
          () => findings(second.uri).length === 0,
          "default filter reapplied",
        );
        await pause(250);
        if (component)
          assert.equal(
            invocations().length,
            count,
            "editor and display-setting switches must not invoke CLI",
          );
        assert.ok(
          vscode.languages
            .getDiagnostics(second.uri)
            .some((d) => d.source === "active-project-control"),
        );
      },
    );
    await run(
      "non-file editor and undefined editor retain last project",
      async () => {
        await show(second);
        await waitFor(
          () => findings(second.uri).length > 0,
          "second selected before panel focus",
        );
        await vscode.commands.executeCommand(
          "workbench.action.closeOtherEditors",
        );
        const scratch = await vscode.workspace.openTextDocument({
          content: "scratch",
        });
        await show(scratch);
        assert.ok(findings(second.uri).length > 0);
        assert.equal(findings(first.uri).length, 0);
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor",
        );
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor",
        );
        await waitFor(
          () => !vscode.window.activeTextEditor,
          "all editors closed",
        );
        // Closed-buffer findings are revoked; untouched saved findings still establish scope.
        await workspaceCheck();
        await waitFor(
          () =>
            findings(
              vscode.Uri.joinPath(
                roots[1].uri,
                "roles/example/defaults/saved.yml",
              ),
            ).length > 0 && findings(closed).length === 0,
          "undefined editor retains second project after a saved scan",
        );
      },
    );
    // Reopening through a new document after close also exercises cached lifetime boundaries.
    const a = await vscode.workspace.openTextDocument(uris[0]);
    const b = await vscode.workspace.openTextDocument(uris[1]);
    await show(a);
    await check(a);
    await show(b);
    await check(b);
    await run(
      "hidden edits revoke old fixes while retaining diagnostic text",
      async () => {
        await show(a);
        const before = findings(a.uri);
        const stale = (await actions(a)).find(
          (action) => action.command?.command === "saltboxLint.applySharedFix",
        )!.command!;
        await show(b);
        await replace(a, "value: 1\n");
        await show(a);
        await waitFor(
          () => findings(a.uri).length > 0,
          "retained dirty findings restored",
        );
        assert.deepEqual(findings(a.uri), before);
        assert.deepEqual(await actions(a), []);
        if (editor) {
          const [uri, hash, id, report] = stale.arguments!;
          await editor.applyShared(uri, hash, id, report);
        } else
          await vscode.commands.executeCommand(
            stale.command,
            ...(stale.arguments ?? []),
          );
        assert.equal(a.getText(), "value: 1\n");
      },
    );
    await run(
      "related locations invalidated while hidden stay invalidated",
      async () => {
        const doc = await vscode.workspace.openTextDocument(related);
        await show(doc);
        await check(doc);
        assert.ok(findings(related).some((d) => d.relatedInformation?.length));
        await show(b);
        await replace(doc, doc.getText() + "# unsaved\n");
        await show(doc);
        await waitFor(
          () => findings(related).length > 0,
          "hidden related diagnostic restored",
        );
        assert.ok(
          findings(related).every((d) => !d.relatedInformation?.length),
          "hidden document cache must strip stale related locations",
        );
      },
    );
    await run(
      "hidden saved related locations and closed tabs cannot resurrect stale cache",
      async () => {
        await show(b);
        const relatedClosed = vscode.Uri.joinPath(
          roots[0].uri,
          "roles/example/defaults/related-closed.yml",
        );
        await replace(b, b.getText() + "# unsaved\n");
        await show(readme);
        await waitFor(
          () => findings(relatedClosed).length > 0,
          "saved related findings restored",
        );
        assert.ok(
          findings(relatedClosed).every((d) => !d.relatedInformation?.length),
          "hidden saved cache must strip stale related locations",
        );
        const doc = await vscode.workspace.openTextDocument(closed);
        await show(doc);
        await check(doc);
        assert.ok(findings(closed).length > 0);
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor",
        );
        await waitFor(
          () => findings(closed).length === 0,
          "closed tab is cleared",
        );
        await show(b);
        await show(readme);
        await pause(100);
        assert.equal(
          findings(closed).length,
          0,
          "display repaint must not restore a closed tab's saved cache",
        );
      },
    );
    if (editor)
      await run(
        "late hidden save and closed-file results update cache without publishing",
        async () => {
          const gate = join(temporary, "pending");
          await show(a);
          await replace(a, 'value: "{{ changed\n }}"\n');
          await writeFile(gate, "");
          process.env.SALTBOX_TEST_PROCESS_GATE = gate;
          try {
            assert.equal(await a.save(), true);
            await waitFor(
              () => existsSync(gate + ".ready"),
              "real saved CLI result is pending",
            );
            await show(b);
            delete process.env.SALTBOX_TEST_PROCESS_GATE;
            await rm(gate);
            await waitFor(
              () =>
                editor.actions(a, new vscode.Range(0, 0, a.lineCount, 0))
                  .length > 0,
              "late hidden result accepted",
            );
            assert.equal(findings(a.uri).length, 0);
            const count = invocations().length;
            await show(a);
            await waitFor(
              () => findings(a.uri).some((d) => d.code === "jinja-layout"),
              "late cached result restored",
            );
            await pause(150);
            assert.equal(invocations().length, count);
          } finally {
            delete process.env.SALTBOX_TEST_PROCESS_GATE;
            await rm(gate, { force: true });
          }
          const closed = vscode.Uri.joinPath(roots[0].uri, "hidden-new.yml");
          await show(b);
          await vscode.workspace.fs.writeFile(
            closed,
            Buffer.from('value: "{{ new\n }}"\n'),
          );
          await pause(600);
          assert.equal(findings(closed).length, 0);
          await show(readme);
          await waitFor(
            () => findings(closed).length > 0,
            "new hidden closed-file result cached",
          );
          await show(b);
          await vscode.workspace.fs.delete(closed);
          await pause(600);
          await show(readme);
          assert.equal(
            findings(closed).length,
            0,
            "hidden deletion revokes saved cache",
          );
        },
      );
    if (editor)
      await run(
        "saved rendering cannot commit related locations invalidated while hidden",
        async () => {
          const filesystem: typeof import("node:fs/promises") = require("node:fs/promises");
          const originalRead = filesystem.readFile;
          const rendered = vscode.Uri.joinPath(
            roots[0].uri,
            "roles/example/defaults/a-related.yml",
          );
          const sentinel = vscode.Uri.joinPath(
            roots[0].uri,
            "roles/example/defaults/z-gate.yml",
          );
          let renderedReads = 0;
          let held = false;
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          // Delay one actual disk read after the earlier entry and its related source
          // were rendered. All bytes still come from the real filesystem and CLI.
          filesystem.readFile = (async (
            ...args: Parameters<typeof originalRead>
          ) => {
            const result = await originalRead(...args);
            if (String(args[0]) === rendered.fsPath) renderedReads++;
            if (String(args[0]) === sentinel.fsPath && !held) {
              held = true;
              await gate;
            }
            return result;
          }) as typeof originalRead;
          await show(b);
          const scan = editor.checkWorkspace();
          try {
            await waitFor(
              () => held,
              "saved scan held after earlier related rendering",
            );
            assert.ok(
              renderedReads >= 2,
              "primary and related bytes were already read",
            );
            await replace(
              b,
              b.getText() + "# changed during saved rendering\n",
            );
            release();
            await scan;
            assert.equal(
              findings(rendered).length,
              0,
              "late hidden scan stays hidden",
            );
            await show(readme);
            await waitFor(
              () => findings(rendered).length > 0,
              "rendered cached findings restored",
            );
            assert.ok(
              findings(rendered).every((d) => !d.relatedInformation?.length),
              "in-flight saved cache must strip invalidated related locations",
            );
          } finally {
            filesystem.readFile = originalRead;
            release();
            await scan;
          }
        },
      );
    await run(
      "external roots, aliases and known unmarked owners use existing project ownership",
      async () => {
        const parent = vscode.Uri.joinPath(roots[0].uri, "..");
        assert.equal(spawnSync("git", ["init", "-q", parent.fsPath]).status, 0);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(parent, ".saltbox-lint"),
          new Uint8Array(),
        );
        const externalDirectory = vscode.Uri.joinPath(parent, "external");
        await vscode.workspace.fs.createDirectory(externalDirectory);
        const external = vscode.Uri.joinPath(externalDirectory, "README.md");
        await vscode.workspace.fs.writeFile(
          external,
          Buffer.from("external project context\n"),
        );
        const rootConfig = vscode.workspace.getConfiguration(
          "saltboxLint",
          roots[0].uri,
        );
        await rootConfig.update(
          "root",
          "..",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        const externalDoc = await vscode.workspace.openTextDocument(external);
        await show(externalDoc);
        await waitFor(
          () => findings(related).length > 0 && findings(b.uri).length === 0,
          "ownerless external Markdown selects containing source root",
        );
        const alias = vscode.Uri.joinPath(roots[0].uri, "external-alias");
        await symlink(
          externalDirectory.fsPath,
          alias.fsPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        await show(
          await vscode.workspace.openTextDocument(
            vscode.Uri.joinPath(alias, "README.md"),
          ),
        );
        assert.ok(findings(related).length > 0);
        await vscode.workspace.fs.delete(
          vscode.Uri.joinPath(roots[1].uri, ".saltbox-lint"),
        );
        const unmarked = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(roots[1].uri, "README.md"),
        );
        await show(unmarked);
        await waitFor(
          () =>
            vscode.languages
              .getDiagnostics()
              .every(([, ds]) => ds.every((d) => d.source !== "saltbox-lint")),
          "known unmarked workspace owner overrides encompassing marked source root",
        );
        await show(externalDoc);
        await waitFor(
          () => findings(related).length > 0,
          "external owner restored",
        );
        await vscode.workspace.fs.delete(
          vscode.Uri.joinPath(parent, ".saltbox-lint"),
        );
        await waitFor(
          () => findings(related).length === 0,
          "external root opt-out clears cached findings",
        );
        await show(unmarked);
        await show(externalDoc);
        await config.update(
          "activeProjectOnly",
          false,
          vscode.ConfigurationTarget.Workspace,
        );
        assert.equal(
          findings(related).length,
          0,
          "display toggle cannot restore opted-out cache",
        );
        await config.update(
          "activeProjectOnly",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(roots[1].uri, ".saltbox-lint"),
          new Uint8Array(),
        );
        await show(b);
        await waitFor(
          () => findings(b.uri).length > 0,
          "re-enabled project has fresh findings",
        );
        assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true);
        await waitFor(
          () =>
            vscode.workspace.workspaceFolders?.length === 1 &&
            findings(b.uri).length === 0,
          "removed active project cannot retain findings",
        );
        await show(externalDoc);
        await show(b);
        assert.equal(findings(b.uri).length, 0);
      },
    );
  } finally {
    subscriptions.forEach((subscription) => subscription.dispose());
    editor?.dispose();
    other.dispose();
    delete process.env.SALTBOX_TEST_PROCESS_LOG;
    await rm(temporary, { recursive: true, force: true });
  }
  assert.deepEqual(failures, []);
}
