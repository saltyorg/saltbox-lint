import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(predicate(), message);
}
const findings = (document: vscode.TextDocument) =>
  vscode.languages
    .getDiagnostics(document.uri)
    .filter((item) => item.source === "saltbox-lint");

export async function runQueue(): Promise<void> {
  const roots = vscode.workspace.workspaceFolders!;
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-queue-"));
  const log = join(temporary, "process.log");
  const gate = join(temporary, "gate");
  process.env.SALTBOX_TEST_PROCESS_LOG = log;
  const invocations = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
  const documents = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(roots[0].uri, `queue-${index}.yml`),
      ),
    ),
  );
  for (const document of documents)
    await vscode.window.showTextDocument(document, { preview: false });
  const failures: string[] = [];
  const run = async (name: string, operation: () => Promise<void>) => {
    try {
      await operation();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}`, error);
    }
  };
  let editor: EditorIntegration | undefined;
  const release = async () => {
    delete process.env.SALTBOX_TEST_PROCESS_GATE;
    await rm(gate, { force: true });
  };
  const hold = async () => {
    await rm(gate + ".ready", { force: true });
    await writeFile(gate, "");
    process.env.SALTBOX_TEST_PROCESS_GATE = gate;
    const pending = editor!.check(documents[0]);
    await waitFor(
      () => existsSync(gate + ".ready"),
      "held check reached fixture gate",
    );
    return { pending };
  };
  try {
    await run(
      "queue root activation diagnoses all 40 open documents",
      async () => {
        await writeFile(gate, "");
        process.env.SALTBOX_TEST_PROCESS_GATE = gate;
        editor = new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!);
        await waitFor(
          () => existsSync(gate + ".ready"),
          "startup check held at fixture gate",
        );
        await release();
        await waitFor(
          () =>
            documents.every((document) =>
              findings(document).some((d) => d.code === "jinja-layout"),
            ),
          `all 40 open documents must receive diagnostics`,
        );
      },
    );
    // Drain startup work before each subsequent controlled queue exercise.
    await editor!.checkWorkspace();
    await run(
      "queue root refresh diagnoses all 40 open documents",
      async () => {
        const { pending } = await hold();
        editor!.refresh([roots[0].uri]);
        await release();
        await pending;
        await waitFor(
          () =>
            documents.every((document) =>
              findings(document).some((d) => d.code === "jinja-layout"),
            ),
          "root refresh must not lose open documents",
        );
      },
    );
    await editor!.checkWorkspace();
    const invalidations = [
      "none",
      "edit",
      "version",
      "close",
      "root",
      "dispose",
    ] as const;
    for (const [index, invalidation] of invalidations.entries()) {
      await run(
        invalidation === "none"
          ? "queue snapshots are created only when a current check runs"
          : `queue snapshots are lazy and ${invalidation} invalidates pending checks`,
        async () => {
          const root = invalidation === "root" ? roots[1] : roots[0];
          const document = await vscode.workspace.openTextDocument(
            vscode.Uri.joinPath(root.uri, `queue-${40 + index}.yml`),
          );
          await vscode.window.showTextDocument(document, { preview: false });
          assert.equal(document.languageId, "yaml");
          assert.equal(document.isClosed, false);
          let reads = 0;
          let requested = false;
          // VS Code freezes TextDocument methods. Use an inheriting observer,
          // not a Proxy that violates non-writable property invariants.
          const tracked: vscode.TextDocument = Object.create(document, {
            getText: {
              value: (...args: Parameters<vscode.TextDocument["getText"]>) => {
                reads++;
                return document.getText(...args);
              },
            },
            version: {
              get: () => {
                requested = true;
                return document.version;
              },
            },
          });
          const { pending: active } = await hold();
          const before = invocations().length;
          const pending = editor!.check(
            tracked,
            false,
            invalidation === "version" ? undefined : document.version,
          );
          let settled = false;
          void pending.then(() => {
            settled = true;
          });
          await waitFor(() => requested, "requested document version captured");
          // Roots are already ready. Let check's enqueue continuation finish;
          // the fixture gate, not elapsed time, holds the active subprocess.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const queuedReads = reads;
          try {
            if (invalidation === "edit" || invalidation === "version") {
              const edit = new vscode.WorkspaceEdit();
              edit.insert(
                document.uri,
                new vscode.Position(0, 0),
                "# unsaved\n",
              );
              assert.equal(await vscode.workspace.applyEdit(edit), true);
              if (invalidation === "edit") editor!.change(tracked);
            } else if (invalidation === "close") {
              const tabs = vscode.window.tabGroups.all
                .flatMap((group) => group.tabs)
                .filter(
                  (tab) =>
                    tab.input instanceof vscode.TabInputText &&
                    tab.input.uri.toString() === document.uri.toString(),
                );
              await vscode.window.tabGroups.close(tabs, true);
              editor!.close(tracked);
            } else if (invalidation === "root") {
              const changed = new Promise<void>((resolve) => {
                const listener = vscode.workspace.onDidChangeWorkspaceFolders(
                  () => {
                    listener.dispose();
                    resolve();
                  },
                );
              });
              assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true);
              await changed;
              editor!.configureRoots();
            } else if (invalidation === "dispose") editor!.dispose();
            if (invalidation !== "none" && invalidation !== "version")
              await waitFor(
                () => settled,
                "invalidation must remove pending work before the active gate releases",
              );
            await release();
            await Promise.all([active, pending]);
            assert.equal(
              queuedReads,
              0,
              "pending requests must not copy document text or construct indexes",
            );
            if (invalidation === "none") {
              assert.ok(
                reads > 0,
                "current queued request must create its snapshot when running",
              );
              assert.ok(
                invocations()
                  .slice(before)
                  .some((line) => line.includes(document.uri.fsPath)),
                "current queued check must execute",
              );
              assert.ok(
                findings(document).some(
                  (finding) => finding.code === "jinja-layout",
                ),
                "current queued check must publish",
              );
              return;
            }
            assert.equal(
              reads,
              0,
              "obsolete queued work must not create a snapshot",
            );
            assert.ok(
              !invocations()
                .slice(before)
                .some((line) => line.includes(document.uri.fsPath)),
              "obsolete queued check executed",
            );
            assert.equal(
              findings(document).length,
              0,
              "obsolete queued check published diagnostics",
            );
          } finally {
            await release();
          }
        },
      );
    }
  } finally {
    editor?.dispose();
    await release();
    delete process.env.SALTBOX_TEST_PROCESS_LOG;
    await rm(temporary, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], "queue regressions");
}
