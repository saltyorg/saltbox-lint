import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { parseCheck } from "../../src/protocol.ts";
import { runProcess } from "../../src/process.ts";
import { MarkedRoots } from "../../src/roots.ts";
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
  // Exercise the first extensionless alias before any conventional template
  // has established an owner for the same physical file.
  for (const uri of [
    vscode.Uri.joinPath(root, "readonly-alias/config"),
    vscode.Uri.joinPath(root, "reverse-alias.j2"),
    vscode.Uri.joinPath(root, "roles/readonly/templates/reverse.yaml"),
    ...["config", "config.yaml", "config.j2"].map((basename) =>
      vscode.Uri.joinPath(root, "roles/readonly/templates", basename),
    ),
  ]) {
    const original = await readFile(uri.fsPath, "utf8");
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    if (uri.path.endsWith("readonly-alias/config"))
      assert.equal(document.languageId, "plaintext");
    await vscode.commands.executeCommand("saltboxLint.checkDocument");
    assert.deepEqual(findings(document), []);
    if (uri.path.includes("reverse")) {
      const canonical = vscode.Uri.joinPath(
        root,
        "roles/readonly/defaults/reverse.yml",
      );
      const report = parseCheck(
        await runProcess(
          {
            executable,
            cwd: root.fsPath,
            args: [
              "check",
              "--root",
              root.fsPath,
              "--stdin-filename",
              canonical.fsPath,
              "--stdin-source-filename",
              uri.fsPath,
              "--format",
              "json",
              "--include-analysis",
              "-",
            ],
            input: original,
            successCodes: [0, 1],
          },
          new AbortController().signal,
        ),
        true,
      );
      assert.equal(
        report.analysis!.sources[0].path,
        "roles/readonly/defaults/reverse.yml",
      );
      assert.ok(
        !report.diagnostics.some(
          (finding) => finding.rule_id === "jinja-layout",
        ),
      );
      assert.equal(
        report.fixes.size,
        0,
        "canonical response keeps the admitted alias read-only",
      );
    }
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
  const fullRootAdapter = new EditorIntegration(executable);
  try {
    await runExternalTemplateDeletion(
      vscode.Uri.joinPath(root, "standalone.j2"),
      fullRootAdapter,
    );
  } finally {
    fullRootAdapter.dispose();
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
    await observeClosedTemplateContext(
      vscode.Uri.joinPath(root, "roles/readonly/templates/closed-config.yaml"),
      adapter,
    );
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
    await runExternalTemplateDeletion(
      vscode.Uri.joinPath(root, "readonly-alias/watch-config"),
      adapter,
    );
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

async function runExternalTemplateDeletion(
  uri: vscode.Uri,
  adapter: EditorIntegration,
): Promise<void> {
  const original = await readFile(uri.fsPath, "utf8");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  try {
    await adapter.check(document, true);
    await waitFor(
      async () =>
        adapter.status(document).state === "current" &&
        findings(document).some(
          (item) => diagnosticCode(item) === "template-syntax",
        ),
      "template deletion control begins with a current saved syntax finding",
    );
    assert.equal(adapter.writable(document), false);
    // This disk deletion must arrive through the registered filesystem watcher.
    // Do not call removeFile/refresh/check or fabricate an editor event.
    await unlink(uri.fsPath);
    await waitFor(
      async () =>
        adapter.status(document).state !== "current" &&
        findings(document).length === 0,
      "external deletion invalidates the open template and clears saved diagnostics",
    );
    assert.equal(
      document.isClosed,
      false,
      "the deletion control keeps its tab open",
    );
  } finally {
    await writeFile(uri.fsPath, original);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
}

async function observeClosedTemplateContext(
  uri: vscode.Uri,
  adapter: EditorIntegration,
): Promise<void> {
  assert.ok(
    !vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === uri.toString(),
    ),
    "closed template fixture has never been opened",
  );
  const roots: unknown = Reflect.get(adapter, "roots");
  assert.ok(roots instanceof MarkedRoots);
  await roots.ready();
  const pending: unknown = Reflect.get(adapter, "pendingFiles");
  assert.ok(pending instanceof Map);
  const original = await readFile(uri.fsPath);
  let listener: vscode.Disposable | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const delivered = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("closed template context event was not delivered")),
        10000,
      );
      // The component's synchronous context handler precedes this observer.
      // Inspect its actual selection immediately after the real watcher event.
      listener = roots.onDidChangeFile((changed) => {
        if (changed.toString() !== uri.toString()) return;
        try {
          assert.equal(
            pending.has(uri.toString()),
            false,
            "narrowed physical template stays out of closed primary selections",
          );
          assert.deepEqual(
            vscode.languages
              .getDiagnostics(uri)
              .filter((item) => item.source === "saltbox-lint"),
            [],
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await writeFile(uri.fsPath, "{% if closed_template_changed %}");
    await delivered;
  } finally {
    if (timer) clearTimeout(timer);
    listener?.dispose();
    await writeFile(uri.fsPath, original);
  }
}
