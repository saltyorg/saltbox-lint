import * as vscode from "vscode";
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";
import { parseFormat } from "../../src/protocol.ts";
import { runProcess } from "../../src/process.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runProfile(): Promise<void> {
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  await product.activate();
  const executable = join(product.extensionPath, "bin", "saltbox-lint");
  const directory = process.env.SALTBOX_QUALIFICATION_FIXTURES!;
  const destination = process.env.SALTBOX_QUALIFICATION_OUTPUT!;
  const root = vscode.workspace.workspaceFolders![0].uri;
  const uri = vscode.Uri.joinPath(root, "profile.yml");
  await vscode.workspace.fs.writeFile(uri, Buffer.from("value: initial\n"));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  const adapter = new EditorIntegration(executable);
  const replace = async (source: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      ),
      source,
    );
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await pause(1000);
  };
  try {
    for (const name of ["diagnostic-heavy.yml", "flow-heavy.yml"]) {
      const source = await readFile(join(directory, name), "utf8");
      await replace(source);
      for (let sample = 0; sample < 3; sample++) {
        let start = performance.now();
        const wire = await runProcess(
          {
            executable,
            cwd: root.fsPath,
            args: [
              "format",
              "--root",
              root.fsPath,
              "--stdin-filename",
              uri.fsPath,
              "-",
            ],
            input: source,
          },
          new AbortController().signal,
        );
        const cli = performance.now() - start;
        start = performance.now();
        const parsed = parseFormat(wire, "profile.yml", source);
        const protocol = performance.now() - start;
        start = performance.now();
        const direct = await adapter.format(document, "canonical");
        const component = performance.now() - start;
        assert.equal(direct.length, parsed.edits.length);
        start = performance.now();
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
          "vscode.executeFormatDocumentProvider",
          uri,
          { tabSize: 2, insertSpaces: true },
        );
        const sdk = performance.now() - start;
        assert.ok(edits?.length);
        const edit = new vscode.WorkspaceEdit();
        edit.set(uri, edits);
        start = performance.now();
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        const application = performance.now() - start;
        const after = document.getText();
        const check = await runProcess(
          {
            executable,
            cwd: root.fsPath,
            args: [
              "format",
              "--root",
              root.fsPath,
              "--stdin-filename",
              uri.fsPath,
              "-",
            ],
            input: after,
          },
          new AbortController().signal,
        );
        assert.equal(JSON.parse(check).status, "unchanged");
        await appendFile(
          destination,
          JSON.stringify({
            name,
            sample,
            cli,
            protocol,
            component,
            sdk,
            application,
            rawEdits: parsed.edits.length,
            sdkEdits: edits.length,
            diagnostics: vscode.languages.getDiagnostics(uri).length,
            idempotent: true,
          }) + "\n",
        );
        await replace(source);
      }
    }
  } finally {
    adapter.dispose();
  }
  console.log(
    "PASS bounded phase profile: 6 source/apply/idempotence samples; no concurrent builds",
  );
}
