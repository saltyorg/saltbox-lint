import * as vscode from "vscode";
import assert from "node:assert/strict";
import { EditorIntegration } from "../../src/editor.ts";
import type { CheckStatus } from "../../src/editor.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import { createRequire } from "node:module";
import { join } from "node:path";
import { helpChildMatcher } from "./help-child.ts";

async function explainWithEvidence(id: string): Promise<vscode.MarkdownString> {
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  const installedAPI = createRequire(
    join(product.extensionPath, "package.json"),
  )("vscode") as typeof vscode;
  const window = installedAPI.window;
  const noticeDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "showErrorMessage",
  )!;
  const showError = window.showErrorMessage;
  const childProcess = createRequire(__filename)(
    "node:child_process",
  ) as typeof import("node:child_process");
  const spawnDescriptor = Object.getOwnPropertyDescriptor(
    childProcess,
    "spawn",
  )!;
  const spawn = childProcess.spawn;
  const matches = helpChildMatcher(
    join(
      product.extensionUri.fsPath,
      "bin",
      "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
    ),
  );
  const errors: string[] = [];
  const children: {
    args: string[];
    pid?: number;
    stdinError?: string;
    spawnError?: string;
    exit?: { code: number | null; signal: string | null };
  }[] = [];
  const joins: Promise<void>[] = [];
  try {
    Object.defineProperty(window, "showErrorMessage", {
      ...noticeDescriptor,
      value: function (this: unknown, ...args: Parameters<typeof showError>) {
        errors.push(args[0]);
        return Reflect.apply(showError, this, args) as unknown;
      },
    });
    Object.defineProperty(childProcess, "spawn", {
      ...spawnDescriptor,
      value: function (this: unknown, ...args: Parameters<typeof spawn>) {
        const child = Reflect.apply(spawn, this, args) as ReturnType<
          typeof spawn
        >;
        const [file, argv] = args;
        if (Array.isArray(argv) && matches(file, argv)) {
          const observation: (typeof children)[number] = {
            args: [...argv],
            pid: child.pid,
          };
          children.push(observation);
          child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
            observation.stdinError = error.code ?? error.name;
          });
          child.on("error", (error: NodeJS.ErrnoException) => {
            observation.spawnError = error.code ?? error.name;
          });
          joins.push(
            new Promise<void>((resolve) => {
              child.once("close", (code, signal) => {
                observation.exit = { code, signal };
                resolve();
              });
            }),
          );
        }
        return child;
      },
    });
    const markdown = await vscode.commands.executeCommand<
      vscode.MarkdownString | undefined
    >("saltboxLint.explainRule", id);
    await Promise.all(joins);
    assert.ok(
      markdown,
      `installed help returned no Markdown: ${JSON.stringify({ errors, children })}`,
    );
    return markdown;
  } finally {
    Object.defineProperty(window, "showErrorMessage", noticeDescriptor);
    Object.defineProperty(childProcess, "spawn", spawnDescriptor);
    await Promise.all(joins);
  }
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
// Fresh fixture integrations schedule saved and open-document startup checks.
// Join those complete operations before measuring a separately owned request.
async function settleStartup(editor: EditorIntegration): Promise<void> {
  const roots = Reflect.get(editor, "roots");
  const pending = new Set<Promise<unknown>>();
  const startedFolders = new Set<string>();
  let documentStarted = false;
  let started!: () => void;
  const startup = new Promise<void>((resolve) => {
    started = resolve;
  });
  const methods = ["check", "checkSaved"] as const;
  const originals = methods.map((method) => Reflect.get(editor, method));
  for (const [index, method] of methods.entries())
    Reflect.set(
      editor,
      method,
      function (this: EditorIntegration, ...args: unknown[]) {
        const work: Promise<unknown> = originals[index].apply(this, args);
        const joined = work.finally(() => pending.delete(joined));
        pending.add(joined);
        if (method === "checkSaved")
          startedFolders.add(
            (args[0] as vscode.WorkspaceFolder).uri.toString(),
          );
        else documentStarted = true;
        if (
          documentStarted &&
          vscode.workspace.workspaceFolders!.every((folder) =>
            startedFolders.has(folder.uri.toString()),
          )
        )
          started();
        return joined;
      },
    );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await roots.ready();
    await Promise.race([
      (async () => {
        await startup;
        while (pending.size) await Promise.all([...pending]);
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Fixture startup checks did not settle")),
          15000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const [index, method] of methods.entries())
      Reflect.set(editor, method, originals[index]);
  }
}
export async function runHelpStatus(
  document: vscode.TextDocument,
): Promise<void> {
  const original = document.getText();
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
  const markdown = await explainWithEvidence("jinja-layout");
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
  const failed = new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!);
  try {
    await settleStartup(failed);
    await failed.check(document);
    assert.equal(failed.status(document).state, "failed");
    assert.equal(failed.status().state, "failed");
    await replace(document, original + "# failed result revision changed\n");
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
  }
  console.log(
    "PASS status hashes matching failure contents and skips changed failure versions and revisions",
  );
  console.log(
    "PASS installed registry help, trusted command-disabled Markdown, existing documentation links, source and dependency status invalidation",
  );
  const { runHelpConcurrency } = await import("./help-concurrency.ts");
  await runHelpConcurrency(document);
}
