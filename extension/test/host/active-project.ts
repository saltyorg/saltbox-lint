import { hostTemporaryDirectory } from "../support/host-temporary.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile, symlink, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EditorIntegration, tabDocumentUris } from "../../src/editor.ts";
import { runProcess } from "../../src/process.ts";
import { withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { componentUI } from "../support/component-ui.ts";
import { SubcaseFailures } from "../support/subcase-failures.ts";
import { diagnosticSourceFacts } from "../support/diagnostic-source-facts.ts";
import { verifyInstalledProduct } from "./host-preflight.ts";
import {
  reportStartupFailure,
  startupFailureReport,
} from "./startup-failure.ts";

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
export async function runActiveProject(
  parentSignal?: AbortSignal,
): Promise<void> {
  return withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: parentSignal },
    async (resources) => {
      const roots = vscode.workspace.workspaceFolders!;
      const config = vscode.workspace.getConfiguration("saltboxLint");
      const temporary = await hostTemporaryDirectory("saltbox-active-project-");
      resources.defer("remove active-project fixtures", () =>
        rm(temporary, { recursive: true, force: true }),
      );
      const log = join(temporary, "process.log");
      const fixtureEnv: NodeJS.ProcessEnv = {};
      const filesystem = { readFile, realpath };
      const component = process.env.SALTBOX_TEST_SAVE_SCOPE === "1";
      if (component) fixtureEnv.SALTBOX_TEST_PROCESS_LOG = log;
      const invocations = () =>
        existsSync(log)
          ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
          : [];
      const startupGate = join(temporary, "startup");
      if (component) {
        await writeFile(startupGate, "");
        fixtureEnv.SALTBOX_TEST_PROCESS_GATE = startupGate;
      }
      const editor = component
        ? ownJoinedResource(
            resources,
            "active-project adapter",
            new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!, {
              ...componentUI(resources),
              runProcess: (request, signal, observer) =>
                runProcess({ ...request, env: fixtureEnv }, signal, observer),
              readFile: ((...args: Parameters<typeof readFile>) =>
                filesystem.readFile(...args)) as typeof readFile,
            }),
          )
        : undefined;
      const subscriptions: vscode.Disposable[] = [];
      resources.defer("active-project subscriptions", () =>
        subscriptions.forEach((subscription) => subscription.dispose()),
      );
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
        const product = vscode.extensions.getExtension(
          "saltyorg.saltbox-lint",
        )!;
        assert.ok(product);
        if (process.env.SALTBOX_TEST_VSIX) {
          assert.equal(
            verifyInstalledProduct(process.env, {
              id: product.id,
              extensionPath: product.extensionPath,
              version: (product.packageJSON as { version?: unknown }).version,
            }),
            "loaded",
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
      const run = async (name: string, test: () => Promise<void>) => {
        try {
          await test();
          console.log(`PASS ${name}`);
        } catch (error) {
          failures.record(name, error);
          console.error(`FAIL ${name}`, error);
        }
      };
      const uris = roots.map((root) =>
        vscode.Uri.joinPath(root.uri, "roles/example/defaults/main.yml"),
      );
      const savedUris = await Promise.all(
        uris.map(async (uri) => vscode.Uri.file(await realpath(uri.fsPath))),
      );
      const closed = vscode.Uri.joinPath(
        roots[0].uri,
        "roles/example/defaults/closed.yml",
      );
      const related = vscode.Uri.joinPath(
        roots[0].uri,
        "roles/example/defaults/related.yml",
      );
      const savedClosed = vscode.Uri.file(await realpath(closed.fsPath));
      const savedOverviewSecond = vscode.Uri.file(
        await realpath(
          vscode.Uri.joinPath(roots[1].uri, "roles/example/defaults/saved.yml")
            .fsPath,
        ),
      );
      const other = vscode.languages.createDiagnosticCollection(
        "active-project-control",
      );
      resources.defer("control diagnostics", () => other.dispose());
      const failures = new SubcaseFailures();
      try {
        if (editor) {
          await waitFor(
            () => existsSync(startupGate + ".ready"),
            "initial full scan is held before publishing",
          );
          assert.notEqual(
            vscode.window.activeTextEditor?.document.uri.scheme,
            "file",
          );
          assert.ok(invocations()[0].endsWith(" ."));
          assert.equal(findings(savedUris[0]).length, 0);
          delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE;
          editor.refresh([
            vscode.Uri.joinPath(
              roots[0].uri,
              "roles/example/defaults/saved.yml",
            ),
          ]);
          await rm(startupGate);
        }
        try {
          await waitFor(
            () => savedUris.every((uri) => findings(uri).length > 0),
            "startup without file context shows both cached projects",
          );
        } catch (error) {
          reportStartupFailure(error, () => ({
            ...startupFailureReport(
              vscode,
              roots,
              uris,
              tabDocumentUris,
              __filename,
              component ? process.env.SALTBOX_TEST_FIXTURE_PATH : undefined,
            ),
            sourceFacts: diagnosticSourceFacts(vscode, roots, uris),
          }));
        }
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
        if (editor) {
          await rm(startupGate + ".ready");
          await writeFile(startupGate, "");
          fixtureEnv.SALTBOX_TEST_PROCESS_GATE = startupGate;
          editor.refresh([roots[0].uri]);
          await waitFor(
            () => existsSync(startupGate + ".ready"),
            "refreshed full scan is held before publishing",
          );
          assert.equal(findings(savedUris[0]).length, 0);
          delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE;
          // This file's fingerprint is unchanged from the first selected check.
          // Even an echo that needs no selected check must retain full coverage.
          editor.refresh([
            vscode.Uri.joinPath(
              roots[0].uri,
              "roles/example/defaults/saved.yml",
            ),
          ]);
          await rm(startupGate);
          await waitFor(
            () => savedUris.every((uri) => findings(uri).length > 0),
            "unchanged file event cannot strand refreshed full coverage",
          );
          console.log(
            "PASS selected events preserve initial and refreshed full scans",
          );
          const originalRead = filesystem.readFile;
          const filename = await filesystem.realpath(uris[0].fsPath);
          let failedReads = 0;
          filesystem.readFile = function (
            this: unknown,
            ...args: Parameters<typeof originalRead>
          ) {
            if (String(args[0]) === filename) {
              failedReads++;
              return Promise.reject(new Error("test full-scan read failure"));
            }
            return Reflect.apply(originalRead, this, args);
          } as typeof originalRead;
          try {
            editor.refresh([roots[0].uri]);
            await waitFor(
              () => failedReads > 0,
              "full scan reaches failed source read",
            );
            const count = invocations().length;
            await pause(250);
            assert.equal(
              failedReads,
              1,
              "failed full scan must not retry itself",
            );
            assert.equal(
              invocations().length,
              count,
              "failed scan must stay idle",
            );
            assert.equal(findings(savedUris[0]).length, 0);
          } finally {
            filesystem.readFile = originalRead;
          }
          editor.refresh([
            vscode.Uri.joinPath(
              roots[0].uri,
              "roles/example/defaults/saved.yml",
            ),
          ]);
          await waitFor(
            () => savedUris.every((uri) => findings(uri).length > 0),
            "later event restores full coverage after a failed scan",
          );
          console.log(
            "PASS failed full scans retain coverage intent without retries",
          );
        }
        const first = await vscode.workspace.openTextDocument(uris[0]);
        const second = await vscode.workspace.openTextDocument(uris[1]);
        const readme = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(roots[0].uri, "README.md"),
        );
        const relatedDocument =
          await vscode.workspace.openTextDocument(related);
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
                findings(first.uri).length > 0 &&
                findings(second.uri).length === 0,
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
                findings(first.uri).length === 0 &&
                findings(second.uri).length > 0,
              "second project selected",
            );
            await show(first);
            await waitFor(
              () =>
                findings(first.uri).length > 0 &&
                findings(second.uri).length === 0,
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
                findings(savedOverviewSecond).length > 0 &&
                findings(savedClosed).length === 0,
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
              (action) =>
                action.command?.command === "saltboxLint.applySharedFix",
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
            assert.ok(
              findings(doc.uri).some((d) => d.relatedInformation?.length),
            );
            await show(b);
            await replace(doc, doc.getText() + "# unsaved\n");
            await show(doc);
            await waitFor(
              () => findings(doc.uri).length > 0,
              "hidden related diagnostic restored",
            );
            assert.ok(
              findings(doc.uri).every((d) => !d.relatedInformation?.length),
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
            const savedRelatedClosed = vscode.Uri.file(
              await realpath(relatedClosed.fsPath),
            );
            await replace(b, b.getText() + "# unsaved\n");
            await show(readme);
            await waitFor(
              () => findings(savedRelatedClosed).length > 0,
              "saved related findings restored",
            );
            assert.ok(
              findings(savedRelatedClosed).every(
                (d) => !d.relatedInformation?.length,
              ),
              "hidden saved cache must strip stale related locations",
            );
            const doc = await vscode.workspace.openTextDocument(closed);
            await show(doc);
            await check(doc);
            assert.ok(findings(doc.uri).length > 0);
            await vscode.commands.executeCommand(
              "workbench.action.closeActiveEditor",
            );
            await waitFor(
              () => findings(doc.uri).length === 0,
              "closed tab is cleared",
            );
            await show(b);
            await show(readme);
            await pause(100);
            assert.equal(
              findings(doc.uri).length,
              0,
              "display repaint must not restore a closed tab's saved cache",
            );
          },
        );
        if (editor)
          await run(
            "late hidden save and closed-file results update cache without publishing",
            async () => {
              const late = await vscode.workspace.openTextDocument(
                vscode.Uri.joinPath(
                  roots[0].uri,
                  "roles/late/defaults/main.yml",
                ),
              );
              await show(late);
              await check(late);
              const gate = join(temporary, "pending");
              await replace(late, 'value: "{{ changed\n }}"\n');
              const beforeSave = invocations().length;
              await writeFile(gate, "");
              fixtureEnv.SALTBOX_TEST_PROCESS_GATE = gate;
              try {
                assert.equal(await late.save(), true);
                await waitFor(
                  () => existsSync(gate + ".ready"),
                  "real saved CLI result is pending",
                );
                await show(b);
                delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE;
                await rm(gate);
                await waitFor(
                  () =>
                    editor.actions(
                      late,
                      new vscode.Range(0, 0, late.lineCount, 0),
                    ).length > 0,
                  "late hidden result accepted",
                );
                assert.equal(
                  invocations().length,
                  beforeSave + 1,
                  "the isolated save must check only its primary",
                );
                assert.equal(findings(late.uri).length, 0);
                const count = invocations().length;
                await show(late);
                await waitFor(
                  () =>
                    findings(late.uri).some(
                      (d) => diagnosticCode(d) === "jinja-layout",
                    ),
                  "late cached result restored",
                );
                await pause(150);
                assert.equal(
                  invocations().length,
                  count,
                  "restoring cached findings must not invoke CLI",
                );
              } finally {
                delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE;
                await rm(gate, { force: true });
              }
              const closed = vscode.Uri.joinPath(
                roots[0].uri,
                "hidden-new.yml",
              );
              await show(b);
              await vscode.workspace.fs.writeFile(
                closed,
                Buffer.from('value: "{{ new\n }}"\n'),
              );
              const savedNew = vscode.Uri.file(await realpath(closed.fsPath));
              await pause(600);
              assert.equal(findings(savedNew).length, 0);
              await show(readme);
              await waitFor(
                () => findings(savedNew).length > 0,
                "new hidden closed-file result cached",
              );
              await show(b);
              await vscode.workspace.fs.delete(closed);
              await pause(600);
              await show(readme);
              assert.equal(
                findings(savedNew).length,
                0,
                "hidden deletion revokes saved cache",
              );
            },
          );
        if (editor)
          await run(
            "saved rendering cannot commit related locations invalidated while hidden",
            async () => {
              const originalRead = filesystem.readFile;
              const rendered = vscode.Uri.joinPath(
                roots[0].uri,
                "roles/example/defaults/a-related.yml",
              );
              const sentinel = vscode.Uri.joinPath(
                roots[0].uri,
                "roles/example/defaults/z-gate.yml",
              );
              const renderedFilename = await filesystem.realpath(
                rendered.fsPath,
              );
              const savedRendered = vscode.Uri.file(renderedFilename);
              const sentinelFilename = await filesystem.realpath(
                sentinel.fsPath,
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
                if (String(args[0]) === renderedFilename) renderedReads++;
                if (String(args[0]) === sentinelFilename && !held) {
                  held = true;
                  await gate;
                }
                return result;
              }) as typeof originalRead;
              await show(b);
              const scan = resources.operation("held hidden scan", () =>
                editor.checkWorkspace(),
              );
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
                  findings(savedRendered).length,
                  0,
                  "late hidden scan stays hidden",
                );
                await show(readme);
                await waitFor(
                  () => findings(savedRendered).length > 0,
                  "rendered cached findings restored",
                );
                assert.ok(
                  findings(savedRendered).every(
                    (d) => !d.relatedInformation?.length,
                  ),
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
            assert.equal(
              spawnSync("git", ["init", "-q", parent.fsPath]).status,
              0,
            );
            await vscode.workspace.fs.writeFile(
              vscode.Uri.joinPath(parent, ".saltbox-lint"),
              new Uint8Array(),
            );
            const externalDirectory = vscode.Uri.joinPath(parent, "external");
            await vscode.workspace.fs.createDirectory(externalDirectory);
            const external = vscode.Uri.joinPath(
              externalDirectory,
              "README.md",
            );
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
            const externalDoc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(await realpath(external.fsPath)),
            );
            assert.equal(
              vscode.workspace.getWorkspaceFolder(externalDoc.uri),
              undefined,
              "canonical external context has no known workspace owner",
            );
            console.log(
              "SALTBOX_OWNERLESS_CONTEXT " +
                JSON.stringify({
                  publicSourceURI: external.toString().slice(0, 2048),
                  actualModelURI: externalDoc.uri.toString().slice(0, 2048),
                  nativeOwner: (await realpath(externalDoc.uri.fsPath)).slice(
                    0,
                    2048,
                  ),
                  contract:
                    "ownerless canonical file selects containing source root",
                }),
            );
            await show(externalDoc);
            await waitFor(
              () =>
                findings(related).length > 0 && findings(b.uri).length === 0,
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
                  .every(([, ds]) =>
                    ds.every((d) => d.source !== "saltbox-lint"),
                  ),
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
      } catch (error) {
        failures.record("active-project cohort body/setup", error);
      } finally {
        delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE;
        delete fixtureEnv.SALTBOX_TEST_PROCESS_LOG;
      }
      failures.throwIfAny("active-project regressions");
    },
  );
}
