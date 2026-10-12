import { hostTemporaryDirectory } from "../support/host-temporary.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";
import { runProcess } from "../../src/process.ts";
import { TestResources, withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { componentUI } from "../support/component-ui.ts";
import { SubcaseFailures } from "../support/subcase-failures.ts";

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

export async function runQueue(parentSignal?: AbortSignal): Promise<void> {
  return withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: parentSignal },
    async (resources) => {
      const roots = vscode.workspace.workspaceFolders!;
      const temporary = await hostTemporaryDirectory("saltbox-queue-");
      resources.defer("queue fixtures", () =>
        rm(temporary, { recursive: true, force: true }),
      );
      const log = join(temporary, "process.log"),
        gate = join(temporary, "gate");
      const fixtureEnv: NodeJS.ProcessEnv = { SALTBOX_TEST_PROCESS_LOG: log };
      const requests: {
        filename: string;
        input: string | Uint8Array | undefined;
      }[] = [];
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
      let editor: EditorIntegration | undefined;
      const release = async () => {
        delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE;
        await rm(gate, { force: true });
      };
      resources.defer("startup gate", release);
      const run = async (
        name: string,
        operation: (owner: TestResources) => Promise<void>,
      ) => {
        try {
          await withTestResources(
            { cleanupTimeoutMs: 5000, operationSignal: resources.signal },
            operation,
          );
          console.log(`PASS ${name}`);
        } catch (error) {
          failures.record(name, error);
          console.error(`FAIL ${name}`, error);
        }
      };
      const hold = async (owner: TestResources) => {
        owner.defer("release case gate", release);
        await rm(gate + ".ready", { force: true });
        await writeFile(gate, "");
        fixtureEnv.SALTBOX_TEST_PROCESS_GATE = gate;
        const pending = owner.operation("held native queue check", (signal) =>
          editor!.check(documents[0], false, undefined, false, signal),
        );
        await waitFor(
          () => existsSync(gate + ".ready"),
          "held check reached fixture gate",
        );
        return { pending };
      };
      const failures = new SubcaseFailures();
      try {
        await run(
          "queue root activation diagnoses all 40 open documents",
          async (owner) => {
            owner.defer("release startup gate", release);
            await writeFile(gate, "");
            fixtureEnv.SALTBOX_TEST_PROCESS_GATE = gate;
            editor = ownJoinedResource(
              resources,
              "queue adapter",
              new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!, {
                ...componentUI(resources),
                runProcess: (request, signal, observer) => {
                  const at = request.args.indexOf("--stdin-filename");
                  if (request.args[0] === "check" && at >= 0)
                    requests.push({
                      filename: request.args[at + 1],
                      input: request.input,
                    });
                  return runProcess(
                    { ...request, env: fixtureEnv },
                    signal,
                    observer,
                  );
                },
              }),
            );
            await waitFor(
              () => existsSync(gate + ".ready"),
              "startup check held at fixture gate",
            );
            await release();
            await waitFor(
              () =>
                documents.every((document) =>
                  findings(document).some(
                    (finding) => diagnosticCode(finding) === "jinja-layout",
                  ),
                ),
              "all 40 open documents receive findings",
            );
          },
        );
        assert.equal(
          failures.hasFailures,
          false,
          "startup must establish the remaining queue controls",
        );
        await editor!.checkWorkspace();
        await editor!.join();
        await run(
          "queue root refresh diagnoses all 40 open documents",
          async (owner) => {
            const { pending } = await hold(owner);
            editor!.refresh([roots[0].uri]);
            await release();
            await pending;
            await waitFor(
              () =>
                documents.every((document) =>
                  findings(document).some(
                    (finding) => diagnosticCode(finding) === "jinja-layout",
                  ),
                ),
              "root refresh keeps all 40 documents",
            );
          },
        );
        await editor!.checkWorkspace();
        await editor!.join();
        for (const [index, invalidation] of [
          "none",
          "edit",
          "version",
          "close",
          "root",
          "dispose",
        ].entries()) {
          await run(
            invalidation === "none"
              ? "queue current requests transmit the actual native buffer"
              : `queue ${invalidation} invalidates pending native checks`,
            async (owner) => {
              const root = invalidation === "root" ? roots[1] : roots[0];
              const document = await vscode.workspace.openTextDocument(
                vscode.Uri.joinPath(root.uri, `queue-${40 + index}.yml`),
              );
              await vscode.window.showTextDocument(document, {
                preview: false,
              });
              const filename = await realpath(document.uri.fsPath);
              const original = document.getText();
              owner.defer("restore native queued buffer", async () => {
                if (!document.isClosed && document.getText() !== original)
                  await replace(document, original);
              });
              if (invalidation === "none") {
                await replace(document, original + "# current native input\n");
                editor!.change(document);
              }
              const { pending: active } = await hold(owner);
              const before = invocations().length,
                beforeRequests = requests.length;
              let settled = false;
              const pending = owner.operation(
                "queued native source check",
                async (signal) => {
                  try {
                    await editor!.check(
                      document,
                      false,
                      invalidation === "version" ? undefined : document.version,
                      false,
                      signal,
                    );
                  } finally {
                    settled = true;
                  }
                },
              );
              await waitFor(
                () => editor!.status(document).state === "checking",
                "the actual native model is queued behind the held child",
              );
              const queuedState = editor!.status(document).state;
              if (invalidation === "edit" || invalidation === "version") {
                await replace(document, "# unsaved\n" + document.getText());
                if (invalidation === "edit") editor!.change(document);
              } else if (invalidation === "close") {
                const tabs = vscode.window.tabGroups.all
                  .flatMap((group) => group.tabs)
                  .filter(
                    (tab) =>
                      tab.input instanceof vscode.TabInputText &&
                      tab.input.uri.toString() === document.uri.toString(),
                  );
                assert.equal(
                  await vscode.window.tabGroups.close(tabs, true),
                  true,
                );
                await waitFor(
                  () =>
                    !vscode.window.tabGroups.all.some((group) =>
                      group.tabs.some(
                        (tab) =>
                          tab.input instanceof vscode.TabInputText &&
                          tab.input.uri.toString() === document.uri.toString(),
                      ),
                    ),
                  "the selected native tab is absent",
                );
                editor!.close(document);
              } else if (invalidation === "root") {
                let done!: () => void;
                const changed = new Promise<void>((resolve) => {
                  done = resolve;
                });
                const listener = vscode.workspace.onDidChangeWorkspaceFolders(
                  () => {
                    listener.dispose();
                    done();
                  },
                );
                owner.defer("root removal listener", () => listener.dispose());
                assert.equal(
                  vscode.workspace.updateWorkspaceFolders(1, 1),
                  true,
                );
                await changed;
                editor!.configureRoots();
              } else if (invalidation === "dispose") editor!.dispose();
              if (invalidation !== "none" && invalidation !== "version")
                await waitFor(
                  () => settled,
                  "invalidation settles queued work before releasing the active child",
                );
              await release();
              await Promise.all([active, pending]);
              assert.equal(queuedState, "checking");
              const selected = requests
                .slice(beforeRequests)
                .filter((request) => request.filename === filename);
              const executed = invocations()
                .slice(before)
                .some((line) => line.includes(filename));
              if (invalidation === "none") {
                assert.equal(selected.length, 1);
                assert.equal(
                  selected[0].input,
                  document.getText(),
                  "native check receives current source bytes",
                );
                assert.equal(executed, true);
                assert.ok(
                  findings(document).some(
                    (finding) => diagnosticCode(finding) === "jinja-layout",
                  ),
                );
              } else {
                assert.deepEqual(
                  selected,
                  [],
                  "obsolete native input never reaches the backend adapter",
                );
                assert.equal(executed, false);
                assert.equal(findings(document).length, 0);
              }
            },
          );
        }
      } catch (error) {
        failures.record("queue cohort body/setup", error);
      }
      failures.throwIfAny("queue regressions");
    },
  );
}
