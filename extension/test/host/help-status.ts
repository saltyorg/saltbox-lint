import * as vscode from "vscode";
import assert from "node:assert/strict";
import { EditorIntegration } from "../../src/editor.ts";
import type { CheckStatus } from "../../src/editor.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import { withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";

async function explainInstalled(id: string): Promise<vscode.MarkdownString> {
  const markdown = await vscode.commands.executeCommand<
    vscode.MarkdownString | undefined
  >("saltboxLint.explainRule", id);
  assert.ok(markdown, "installed help returns its registry Markdown");
  return markdown;
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
async function status(document: vscode.TextDocument) {
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  const value = await vscode.commands.executeCommand<CheckStatus>(
    "saltboxLint.showStatus",
  );
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  return value;
}
async function settleStartup(editor: EditorIntegration): Promise<void> {
  await editor.ready();
  await editor.join();
}
export async function runHelpStatus(
  document: vscode.TextDocument,
  parentSignal?: AbortSignal,
): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    async (resources) => {
      const original = document.getText();
      resources.defer("help source buffer", () => replace(document, original));
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.equal((await status(document)).state, "current");
      const diagnostic = vscode.languages
        .getDiagnostics(document.uri)
        .find((finding) => diagnosticCode(finding) === "jinja-layout");
      assert.ok(
        diagnostic && typeof diagnostic.code === "object",
        `linked diagnostic: ${JSON.stringify(diagnostic?.code)}`,
      );
      assert.equal(
        diagnostic.code.target.toString(),
        "https://github.com/saltyorg/saltbox-lint/blob/main/docs/rules.md#jinja-layout",
      );
      const markdown = await explainInstalled("jinja-layout");
      assert.ok(
        markdown.value.includes(
          new vscode.MarkdownString().appendText(
            "Align multiline Jinja expressions",
          ).value,
        ),
      );
      assert.deepEqual(markdown.isTrusted, { enabledCommands: [] });
      assert.equal(markdown.supportHtml, false);
      const help = vscode.window.activeTextEditor!.document;
      assert.ok(help.uri.scheme.startsWith("saltbox-lint-help-"));
      const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        help.uri,
        new vscode.Position(0, 0),
      );
      assert.ok(
        hover.some((item) =>
          item.contents.some(
            (content) =>
              typeof content === "object" &&
              "value" in content &&
              content.value.includes("jinja-layout"),
          ),
        ),
      );
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      await replace(document, original + "# buffer revision\n");
      assert.equal((await status(document)).state, "stale");
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.equal((await status(document)).state, "current");
      const peer = vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders![0].uri,
        "roles/example/tasks/safe-rule-fixes.yml",
      );
      const peerBytes = await vscode.workspace.fs.readFile(peer);
      try {
        await vscode.workspace.fs.writeFile(
          peer,
          Buffer.concat([
            Buffer.from(peerBytes),
            Buffer.from("# dependency revision\n"),
          ]),
        );
        const deadline = Date.now() + 15000;
        while (
          (await status(document)).state === "current" &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 25));
        assert.notEqual(
          (await status(document)).state,
          "current",
          "dirty result must be invalidated by saved dependency changes",
        );
      } finally {
        await vscode.workspace.fs.writeFile(peer, peerBytes);
        await replace(document, original);
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
      }
      const root = vscode.workspace.workspaceFolders![0];
      const config = vscode.workspace.getConfiguration("saltboxLint", root.uri);
      try {
        await config.update(
          "root",
          "roles/example",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        const unmarked = await status(document);
        assert.equal(unmarked.state, "missing-marker");
        assert.ok(unmarked.reason.includes(".saltbox-lint"));
        await assert.rejects(async () =>
          vscode.workspace.fs.stat(
            vscode.Uri.joinPath(root.uri, "roles/example/.saltbox-lint"),
          ),
        );
      } finally {
        await config.update(
          "root",
          undefined,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
      }
      const failed = new EditorIntegration(
        process.env.SALTBOX_TEST_FIXTURE_PATH!,
      );
      ownJoinedResource(resources, "failed status adapter", failed);
      try {
        await settleStartup(failed);
        await failed.check(document);
        assert.equal(failed.status(document).state, "failed");
        assert.equal(failed.status().state, "failed");
        await replace(
          document,
          original + "# failed result revision changed\n",
        );
        failed.change(document);
        assert.equal(
          failed.status(document).state,
          "eligible",
          "old failure cannot own a changed revision",
        );
        const unsupported = await vscode.workspace.openTextDocument({
          language: "plaintext",
          content: "ineligible source",
        });
        assert.equal(failed.status(unsupported).state, "disabled");
        await replace(document, original + "# hang\n");
        failed.change(document);
        const pending = failed.check(document);
        const checkingDeadline = Date.now() + 2000;
        while (
          failed.status(document).state !== "checking" &&
          Date.now() < checkingDeadline
        )
          await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(
          failed.status(document).state,
          "checking",
          "actual pending request is visible",
        );
        await replace(document, original + "# cancelled request revision\n");
        failed.change(document);
        await pending;
        assert.equal(
          failed.status(document).state,
          "eligible",
          "a cancelled older request cannot become a current failure",
        );
      } finally {
        failed.dispose();
        await failed.join();
        await replace(document, original);
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
      }
      let reads = 0;
      let versionOffset = 0;
      let textOverride: string | undefined;
      const tracked: vscode.TextDocument = Object.create(document, {
        getText: {
          value: () => {
            reads++;
            return textOverride ?? document.getText();
          },
        },
        version: { get: () => document.version + versionOffset },
      });
      const observed = new EditorIntegration(
        process.env.SALTBOX_TEST_FIXTURE_PATH!,
      );
      ownJoinedResource(resources, "status read adapter", observed);
      const expectReads = (state: CheckStatus["state"], count: number) => {
        reads = 0;
        assert.equal(observed.status(tracked).state, state);
        assert.equal(reads, count, `${state} status buffer reads`);
      };
      try {
        await settleStartup(observed);
        await observed.check(tracked);
        expectReads("failed", 1);
        textOverride = original + "# same version, different contents\n";
        expectReads("eligible", 1);
        textOverride = undefined;
        expectReads("failed", 1);
        versionOffset++;
        expectReads("eligible", 0);
        expectReads("eligible", 0);
        versionOffset = 0;
        expectReads("failed", 1);
        observed.change(tracked);
        expectReads("eligible", 0);
        expectReads("eligible", 0);
      } finally {
        observed.dispose();
        await observed.join();
      }
      console.log(
        "PASS status hashes matching failure contents and skips changed failure versions and revisions",
      );
      console.log(
        "PASS installed registry help, trusted command-disabled Markdown, existing documentation links, source and dependency status invalidation",
      );
      const { runHelpConcurrency } = await import("./help-concurrency.ts");
      await runHelpConcurrency(document, resources.signal);
    },
  );
}
