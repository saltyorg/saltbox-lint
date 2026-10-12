import * as vscode from "vscode";
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";
import { parseFormat } from "../../src/protocol.ts";
import { runProcess } from "../../src/process.ts";
import {
  withTestResources,
  type TestResources,
} from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { setTimeout as pause } from "node:timers/promises";

export async function runProfile(parentSignal?: AbortSignal): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    profile,
  );
  console.log(
    "PASS bounded phase profile: 6 source/apply/idempotence samples; no concurrent builds",
  );
}

async function profile(resources: TestResources): Promise<void> {
  const operation: TestResources["operation"] = (name, perform) =>
    resources.operation(name, (signal) => {
      signal.throwIfAborted();
      return perform(signal);
    });
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  await operation("profile product activation", () => product.activate());
  const executable = join(product.extensionPath, "bin", "saltbox-lint");
  const directory = process.env.SALTBOX_QUALIFICATION_FIXTURES!;
  const destination = process.env.SALTBOX_QUALIFICATION_OUTPUT!;
  const root = vscode.workspace.workspaceFolders![0].uri;
  const uri = vscode.Uri.joinPath(root, "profile.yml");
  await operation("profile initial source", () =>
    vscode.workspace.fs.writeFile(uri, Buffer.from("value: initial\n")),
  );
  const document = await operation("profile source document", () =>
    vscode.workspace.openTextDocument(uri),
  );
  await operation("profile source editor", () =>
    vscode.window.showTextDocument(document, { preview: false }),
  );
  await operation("profile initial check", () =>
    vscode.commands.executeCommand("saltboxLint.checkDocument"),
  );
  const adapter = ownJoinedResource(
    resources,
    "profile component",
    new EditorIntegration(executable),
  );
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
    assert.equal(
      await operation("profile replace source", () =>
        vscode.workspace.applyEdit(edit),
      ),
      true,
    );
    await operation("profile source settling", (signal) =>
      pause(1000, undefined, { signal }),
    );
  };
  for (const name of ["diagnostic-heavy.yml", "flow-heavy.yml"]) {
    const source = await operation("profile fixture source", () =>
      readFile(join(directory, name), "utf8"),
    );
    await replace(source);
    for (let sample = 0; sample < 3; sample++) {
      let start = performance.now();
      const wire = await operation("profile CLI format", (signal) =>
        runProcess(
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
          signal,
        ),
      );
      const cli = performance.now() - start;
      start = performance.now();
      const parsed = parseFormat(wire, "profile.yml", source);
      const protocol = performance.now() - start;
      start = performance.now();
      const direct = await operation("profile component format", () =>
        adapter.format(document, "canonical"),
      );
      const component = performance.now() - start;
      assert.equal(direct.length, parsed.edits.length);
      start = performance.now();
      const edits = await operation("profile installed format", () =>
        vscode.commands.executeCommand<vscode.TextEdit[]>(
          "vscode.executeFormatDocumentProvider",
          uri,
          { tabSize: 2, insertSpaces: true },
        ),
      );
      const sdk = performance.now() - start;
      assert.ok(edits?.length);
      const edit = new vscode.WorkspaceEdit();
      edit.set(uri, edits);
      start = performance.now();
      assert.equal(
        await operation("profile apply format", () =>
          vscode.workspace.applyEdit(edit),
        ),
        true,
      );
      const application = performance.now() - start;
      const after = document.getText();
      const check = await operation("profile CLI idempotence", (signal) =>
        runProcess(
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
          signal,
        ),
      );
      assert.equal(JSON.parse(check).status, "unchanged");
      await operation("profile sample output", () =>
        appendFile(
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
        ),
      );
      await replace(source);
    }
  }
}
