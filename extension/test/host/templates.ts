import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runProcess } from "../../src/process.ts";
import { EditorIntegration, type CheckStatus } from "../../src/editor.ts";
import type { QueryReport } from "../../src/navigation-protocol.ts";
import { diagnosticCode } from "./diagnostic-code.ts";

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
function findings(document: vscode.TextDocument) {
  return vscode.languages
    .getDiagnostics(document.uri)
    .filter((item) => item.source === "saltbox-lint");
}
async function waitFor(predicate: () => Promise<boolean>, reason: string) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(reason);
}

export async function runTemplates(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri;
  const executable = process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!;
  for (const basename of ["config", "config.yaml", "config.j2"]) {
    const uri = vscode.Uri.joinPath(root, "roles/readonly/templates", basename);
    const original = await readFile(uri.fsPath, "utf8");
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("saltboxLint.checkDocument");
    assert.deepEqual(findings(document), []);
    const position = document.positionAt(original.indexOf("_port") + 2);
    await waitFor(async () => {
      const locations = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >("vscode.executeDefinitionProvider", uri, position);
      return locations.length === 3;
    }, "actual template definition provider resolves original spans");
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      position,
    );
    const contents = hovers
      .flatMap((hover) => hover.contents)
      .filter(
        (content): content is vscode.MarkdownString =>
          typeof content === "object" && "value" in content,
      );
    assert.ok(
      contents.some(
        (content) =>
          content.value.includes("Source&nbsp;declarations") &&
          content.value.includes(
            "Runtime&nbsp;values&nbsp;and&nbsp;precedence&nbsp;are&nbsp;not&nbsp;evaluated",
          ) &&
          content.value.includes("Literal&nbsp;source&nbsp;representation") &&
          content.value.includes("1234") &&
          content.value.includes("\\[untrusted\\]") &&
          content.value.includes("\\*\\*comment\\*\\*"),
      ),
      "actual template hover preserves declarations, literal values and escaped comments",
    );
    assert.ok(
      contents.every(
        (content) => content.isTrusted !== true && !content.supportHtml,
      ),
    );
    assert.ok(
      hovers.some(
        (hover) =>
          hover.range &&
          document
            .getText(hover.range)
            .startsWith("lookup('role_var', '_port'"),
      ),
    );
    const references = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      uri,
      position,
    );
    assert.ok(
      references.some((location) => location.uri.toString() === uri.toString()),
    );
    editor.selection = new vscode.Selection(position, position);
    const impact = await vscode.commands.executeCommand<QueryReport>(
      "saltboxLint.showImpact",
    );
    assert.equal(impact.coverage.complete, false);
    assert.ok(impact.coverage.reasons.length > 0);
    assert.match(
      vscode.window.activeTextEditor!.document.getText(),
      /Coverage: incomplete/,
    );
    assert.ok(
      vscode.window.activeTextEditor!.document.uri.scheme.startsWith(
        "saltbox-lint-impact-",
      ),
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await vscode.window.showTextDocument(document);
    const completions =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        uri,
        position,
      );
    assert.ok(
      !completions.items.some((item) =>
        item.detail?.includes("source declaration candidates"),
      ),
      "template completion never proposes Saltbox edits",
    );
    const bad = " \t😀{% if enabled -%}\r\n{{ value }}  ";
    await replace(document, bad);
    await vscode.commands.executeCommand("saltboxLint.checkDocument");
    assert.ok(
      findings(document).some(
        (item) => diagnosticCode(item) === "template-syntax",
      ),
    );
    assert.ok(
      !findings(document).some(
        (item) => diagnosticCode(item) === "jinja-layout",
      ),
    );
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      uri,
      new vscode.Range(0, 0, document.lineCount, 0),
    );
    assert.ok(
      actions.some(
        (action) => action.command?.command === "saltboxLint.explainRule",
      ),
    );
    assert.ok(
      !actions.some(
        (action) =>
          action.command?.command === "saltboxLint.fixAll" ||
          action.command?.command === "saltboxLint.applySharedFix",
      ),
    );
    await vscode.commands.executeCommand("saltboxLint.fixAll", uri);
    assert.equal(document.getText(), bad);
    const formats = await vscode.commands.executeCommand<
      vscode.TextEdit[] | undefined
    >("vscode.executeFormatDocumentProvider", uri, {
      tabSize: 2,
      insertSpaces: true,
    });
    assert.deepEqual(formats === undefined ? [] : formats, []);
    for (const mode of ["canonical", "lint-fixes"]) {
      const wire: unknown = JSON.parse(
        await runProcess(
          {
            executable,
            cwd: root.fsPath,
            args: [
              "format",
              "--root",
              root.fsPath,
              "--stdin-filename",
              uri.fsPath,
              "--mode",
              mode,
              "-",
            ],
            input: bad,
          },
          new AbortController().signal,
        ),
      );
      assert.ok(
        typeof wire === "object" &&
          wire !== null &&
          "status" in wire &&
          wire.status === "skipped" &&
          "edits" in wire &&
          Array.isArray(wire.edits) &&
          wire.edits.length === 0,
      );
    }
    await replace(document, "#jinja2:line_statement_prefix:'#'\r\n{{ value");
    await vscode.commands.executeCommand("saltboxLint.checkDocument");
    assert.ok(
      findings(document).some(
        (item) => diagnosticCode(item) === "template-partial-coverage",
      ),
    );
    assert.ok(
      !findings(document).some(
        (item) => diagnosticCode(item) === "template-syntax",
      ),
    );
    const status = await vscode.commands.executeCommand<CheckStatus>(
      "saltboxLint.showStatus",
    );
    assert.equal(status.state, "current");
    assert.match(status.reason, /Template coverage is bounded and read-only/);
    assert.match(status.reason, /partial coverage/);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.equal(document.getText(), original);
    assert.equal(await readFile(uri.fsPath, "utf8"), original);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
  const configuration = vscode.workspace.getConfiguration("saltboxLint", root);
  const previous = configuration.inspect<string>("root")?.workspaceFolderValue;
  let adapter: EditorIntegration | undefined;
  try {
    await configuration.update(
      "root",
      "roles/readonly/templates",
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
    adapter = new EditorIntegration(executable);
    for (const uri of [
      vscode.Uri.joinPath(root, "roles/readonly/templates/config.yaml"),
      vscode.Uri.joinPath(root, "readonly-alias/config.yaml"),
    ]) {
      const original = await readFile(uri.fsPath, "utf8");
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      await adapter.check(document, true);
      assert.equal(adapter.providerDocuments().includes(document), true);
      assert.equal(
        adapter.writable(document),
        false,
        "narrow roots and canonical aliases never grant template writes",
      );
      for (const mode of ["canonical", "lint-fixes"] as const)
        assert.deepEqual(await adapter.format(document, mode), []);
      await adapter.fixAll(uri);
      assert.equal(document.getText(), original);
      const formats = await vscode.commands.executeCommand<
        vscode.TextEdit[] | undefined
      >("vscode.executeFormatDocumentProvider", uri, {
        tabSize: 2,
        insertSpaces: true,
      });
      assert.deepEqual(formats === undefined ? [] : formats, []);
      assert.equal(await readFile(uri.fsPath, "utf8"), original);
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
    }
  } finally {
    adapter?.dispose();
    await configuration.update(
      "root",
      previous,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  }
  const yaml = vscode.Uri.joinPath(root, "roles/example/defaults/main.yml");
  const before = await readFile(yaml.fsPath, "utf8");
  await assert.rejects(
    runProcess(
      {
        executable,
        cwd: root.fsPath,
        args: [
          "check",
          "--root",
          root.fsPath,
          "--fix",
          yaml.fsPath,
          vscode.Uri.joinPath(root, "roles/readonly/templates/config").fsPath,
        ],
      },
      new AbortController().signal,
    ),
    /read-only/,
  );
  assert.equal(await readFile(yaml.fsPath, "utf8"), before);
  console.log(
    "PASS installed templates check syntax/partial coverage and static navigation without formatter/FixAll/completion edits; direct CLI modes and mixed fix preflight preserve bytes",
  );
}
