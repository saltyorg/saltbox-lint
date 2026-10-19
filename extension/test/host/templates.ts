import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readFile, writeFile, unlink, realpath } from "node:fs/promises";
import { hash, parseCheck } from "../../src/protocol.ts";
import { runProcess } from "../../src/process.ts";
import { EditorIntegration, type CheckStatus } from "../../src/editor.ts";
import type { QueryReport } from "../../src/navigation-protocol.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import { checkPendingWritableOwnership } from "./writable-ownership.ts";
import { observeDirtyReference } from "./dirty-reference-observer.ts";
import { synchronizeDirtyAliases } from "./dirty-alias-buffers.ts";
import {
  withTestResources,
  type TestResources,
} from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { componentUI } from "../support/component-ui.ts";
import { initialCodeActions } from "./initial-code-actions.ts";
import {
  classifyClosedFileEvent,
  observeClosedFileEvent,
} from "../support/closed-file-event.ts";

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
async function showTemplateDocument(uri: vscode.Uri) {
  const editor = await vscode.window.showTextDocument(uri);
  assert.equal(editor.document.uri.toString(), uri.toString());
  assert.equal(editor.document.isClosed, false);
  assert.equal(vscode.window.activeTextEditor, editor);
  return editor;
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

export async function runTemplates(parentSignal?: AbortSignal): Promise<void> {
  return withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: parentSignal },
    async (resources) => {
      const root = vscode.workspace.workspaceFolders![0].uri;
      const executable = process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!;
      // Preflight observation runs before the original template sequence. Failure
      // leaves identity unavailable and never changes an installed test outcome.
      const cli: { spellings: string[]; identityEqual: boolean | undefined } = {
        spellings: [executable],
        identityEqual: undefined,
      };
      let observedRoot = root.fsPath;
      try {
        observedRoot = realpathSync.native(root.fsPath);
        const canonicalCLI = realpathSync.native(executable);
        cli.spellings.push(canonicalCLI);
        const product = vscode.extensions.getExtension("saltyorg.saltbox-lint");
        if (product) {
          const productCLI = join(
            product.extensionPath,
            "bin",
            "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
          );
          cli.identityEqual =
            realpathSync.native(productCLI) === canonicalCLI &&
            readFileSync(productCLI).equals(readFileSync(executable));
          if (cli.identityEqual) cli.spellings.push(productCLI);
        }
      } catch {
        // Identity comparison is evidence only.
      }
      console.log(
        "SALTBOX_TEMPLATE_WORKSPACE_IDENTITY " +
          JSON.stringify({ publicRoot: root.fsPath, nativeRoot: observedRoot }),
      );
      await checkPendingWritableOwnership(executable, root, resources.signal);
      const retainedDocuments = new Map<string, vscode.TextDocument>();
      // Exercise the first extensionless alias before any conventional template
      // has established an owner for the same physical file.
      for (const uri of [
        vscode.Uri.joinPath(root, "readonly-alias/config"),
        vscode.Uri.joinPath(root, "reverse-alias.j2"),
        vscode.Uri.joinPath(root, "roles/readonly/templates/reverse.yaml"),
        ...["config", "config.yaml", "config.j2"].map((basename) =>
          vscode.Uri.joinPath(root, "roles/readonly/templates", basename),
        ),
        ...["config", "config.yaml", "config.j2"].map((basename) =>
          vscode.Uri.joinPath(
            root,
            "roles/readonly-directory/templates",
            basename,
          ),
        ),
      ]) {
        const originalBytes = await readFile(uri.fsPath);
        const original = originalBytes.toString("utf8");
        let document = (await showTemplateDocument(uri)).document;
        const originalEol = document.eol;
        resources.defer(`restore template ${uri.toString()}`, async () => {
          const current =
            vscode.workspace.textDocuments.find(
              (source) => source.uri.toString() === uri.toString(),
            ) ?? document;
          if (current.getText() === original && current.eol === originalEol)
            return;
          const restored = await showTemplateDocument(uri);
          await vscode.commands.executeCommand("workbench.action.files.revert");
          assert.equal(restored.document.getText(), original);
          assert.equal(restored.document.eol, originalEol);
          await vscode.commands.executeCommand(
            "workbench.action.closeActiveEditor",
          );
        });
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
              content.value.includes(
                "Literal&nbsp;source&nbsp;representation",
              ) &&
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
        const references = await vscode.commands.executeCommand<
          vscode.Location[]
        >("vscode.executeReferenceProvider", uri, position);
        assert.ok(
          references.some(
            (location) => location.uri.toString() === uri.toString(),
          ),
        );
        const impactEditor = await showTemplateDocument(uri);
        document = impactEditor.document;
        assert.equal(document.getText(), original);
        assert.equal(document.eol, originalEol);
        impactEditor.selection = new vscode.Selection(position, position);
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
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor",
        );
        document = (await showTemplateDocument(uri)).document;
        assert.equal(document.getText(), original);
        assert.equal(document.eol, originalEol);
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
        // The CLI overlays every admitted spelling of this physical template.
        // Verify navigation while the buffer differs from all saved spellings.
        await replace(document, original + "{# unsaved template comment #}\n");
        // Earlier editor tabs may be closed while their public models remain
        // open. Establish coherent overlays for this fixture's physical aliases.
        const aliases = await synchronizeDirtyAliases({
          root: root.fsPath,
          owner: uri.path.includes("reverse")
            ? vscode.Uri.joinPath(root, "roles/readonly/defaults/reverse.yml")
                .fsPath
            : uri.fsPath,
          primary: document,
          baseline: originalBytes,
          knownURIs: [
            "reverse-alias.j2",
            "roles/readonly/templates/reverse.yaml",
            "roles/readonly/defaults/reverse.yml",
            "readonly-alias/reverse.yaml",
            ...["config", "config.yaml", "config.j2"].flatMap((basename) => [
              "readonly-alias/" + basename,
              "roles/readonly/templates/" + basename,
              "roles/readonly-directory/templates/" + basename,
              "roles/readonly-directory/tasks/" + basename,
            ]),
          ].map((path) => vscode.Uri.joinPath(root, path).toString()),
          documents: () => vscode.workspace.textDocuments,
          replace,
          restoreClean: async (alias) => {
            const primaryEditor = vscode.window.activeTextEditor;
            const editor = await showTemplateDocument(alias.uri);
            assert.equal(editor.document, alias);
            await vscode.commands.executeCommand(
              "workbench.action.files.revert",
            );
            assert.equal(alias.isDirty, false);
            await vscode.commands.executeCommand(
              "workbench.action.closeActiveEditor",
            );
            if (primaryEditor) {
              const restored = await showTemplateDocument(
                primaryEditor.document.uri,
              );
              assert.equal(restored.document, primaryEditor.document);
            }
          },
        });
        try {
          await vscode.commands.executeCommand("saltboxLint.checkDocument");
          assert.deepEqual(findings(document), []);
          await waitFor(async () => {
            const locations = await vscode.commands.executeCommand<
              (vscode.Location | vscode.LocationLink)[]
            >("vscode.executeDefinitionProvider", uri, position);
            return locations.length === 3;
          }, "dirty template aliases retain definition navigation");
          const observer =
            uri.toString() ===
            vscode.Uri.joinPath(
              root,
              "roles/readonly/templates/reverse.yaml",
            ).toString()
              ? observeDirtyReference({
                  document,
                  documents: () => vscode.workspace.textDocuments,
                  retainedDocuments: () => [...retainedDocuments.values()],
                  tabURIs: () =>
                    vscode.window.tabGroups.all.flatMap((group) =>
                      group.tabs.flatMap((tab) => {
                        if (tab.input instanceof vscode.TabInputText)
                          return [tab.input.uri.toString()];
                        if (tab.input instanceof vscode.TabInputTextDiff)
                          return [
                            tab.input.original.toString(),
                            tab.input.modified.toString(),
                          ];
                        return [];
                      }),
                    ),
                  aliases: [
                    "reverse-alias.j2",
                    "roles/readonly/templates/reverse.yaml",
                    "roles/readonly/defaults/reverse.yml",
                    "readonly-alias/reverse.yaml",
                  ].map((path) => ({
                    path,
                    uri: vscode.Uri.joinPath(root, path).toString(),
                  })),
                  root: observedRoot,
                  owner: join(
                    observedRoot,
                    "roles/readonly/defaults/reverse.yml",
                  ),
                  ownerPath: "roles/readonly/defaults/reverse.yml",
                  source: uri.fsPath,
                  position,
                  baseline: originalBytes,
                  cli,
                })
              : undefined;
          try {
            aliases.assertCurrent();
            const request = () =>
              vscode.commands.executeCommand<vscode.Location[]>(
                "vscode.executeReferenceProvider",
                uri,
                position,
              );
            const dirtyReferences = await (observer
              ? observer.request(request)
              : request());
            assert.ok(
              dirtyReferences.some(
                (location) => location.uri.toString() === uri.toString(),
              ),
              "dirty template reference aliases use the captured buffer coordinates",
            );
            aliases.assertCurrent();
            const lookupStart = document
              .getText()
              .indexOf("lookup('role_var', '_port'");
            const lookupEnd = document.getText().indexOf(")", lookupStart) + 1;
            const primaryLocation = dirtyReferences.find(
              (location) => location.uri.toString() === uri.toString(),
            )!;
            assert.deepEqual(
              primaryLocation.range.start,
              document.positionAt(lookupStart),
            );
            assert.deepEqual(
              primaryLocation.range.end,
              document.positionAt(lookupEnd),
            );
            assert.equal(
              document.getText(primaryLocation.range),
              document.getText().slice(lookupStart, lookupEnd),
            );
          } catch (error) {
            observer?.failure();
            throw error;
          } finally {
            observer?.dispose();
          }
          assert.equal(await readFile(uri.fsPath, "utf8"), original);
        } finally {
          await aliases.restore();
        }
        const bad = " \t😀{% if enabled -%}\r\n{{ value }}  ";
        // WorkspaceEdit uses the existing model EOL. Admit the intended CRLF
        // fixture explicitly before measuring any read-only operation.
        const beforeAdmission = { text: document.getText(), eol: document.eol };
        const admissionEditor = await showTemplateDocument(uri);
        document = admissionEditor.document;
        assert.deepEqual(
          { text: document.getText(), eol: document.eol },
          beforeAdmission,
        );
        assert.equal(
          await admissionEditor.edit((edit) =>
            edit.setEndOfLine(vscode.EndOfLine.CRLF),
          ),
          true,
        );
        await replace(document, bad);
        assert.equal(document.getText(), bad);
        assert.equal(document.eol, vscode.EndOfLine.CRLF);
        const before = Object.freeze({
          text: document.getText(),
          eol: document.eol,
          version: document.version,
        });
        assert.deepEqual(await readFile(uri.fsPath), originalBytes);
        console.log(
          "SALTBOX_TEMPLATE_PRESERVATION " +
            JSON.stringify({
              path: uri.path.slice(root.path.length),
              modelSha256: hash(before.text),
              modelBytes: Buffer.byteLength(before.text),
              eol: before.eol,
              documentVersion: before.version,
              diskSha256: hash(originalBytes),
            }),
        );
        const assertPreserved = async () => {
          assert.equal(document.getText(), before.text);
          assert.equal(document.eol, before.eol);
          assert.equal(document.version, before.version);
          assert.deepEqual(await readFile(uri.fsPath), originalBytes);
        };
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        await assertPreserved();
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
        const actionModel = () => {
          const current = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.toString() === document.uri.toString(),
          );
          return {
            uri: document.uri.toString(),
            version: document.version,
            language: document.languageId,
            closed: document.isClosed,
            sameCurrentModel: current === document,
            currentVersion: current?.version,
            currentLanguage: current?.languageId,
            diagnosticCodes: findings(document)
              .map((item) => item.code)
              .slice(0, 12),
          };
        };
        const beforeActions = actionModel();
        const { actions } = await initialCodeActions(
          resources,
          document,
          new vscode.Range(0, 0, document.lineCount, 0),
          (actions) =>
            actions.some(
              (action) => action.command?.command === "saltboxLint.explainRule",
            ),
        );
        await assertPreserved();
        try {
          assert.ok(
            actions.some(
              (action) => action.command?.command === "saltboxLint.explainRule",
            ),
          );
        } catch (error) {
          try {
            const afterActions = actionModel();
            const active =
              vscode.window.activeTextEditor?.document.uri.toString();
            const status = await vscode.commands.executeCommand(
              "saltboxLint.showStatus",
            );
            console.error(
              "SALTBOX_TEMPLATE_ACTION_FAILURE " +
                JSON.stringify({
                  beforeActions,
                  afterActions,
                  requestedUri: uri.toString(),
                  active,
                  status,
                  publicRoot: root.fsPath,
                  nativeRoot: observedRoot,
                  commands: actions
                    .slice(0, 20)
                    .map((action) => action.command?.command),
                }),
            );
          } catch (evidenceError) {
            throw new AggregateError(
              [error, evidenceError],
              "Template action failure and its evidence failed",
              { cause: error },
            );
          }
          throw error;
        }
        assert.ok(
          !actions.some(
            (action) =>
              action.command?.command === "saltboxLint.fixAll" ||
              action.command?.command === "saltboxLint.applySharedFix",
          ),
        );
        await vscode.commands.executeCommand("saltboxLint.fixAll", uri);
        await assertPreserved();
        await vscode.commands.executeCommand(
          "saltboxLint.applySharedFix",
          uri,
          hash(before.text),
          "unavailable-template-fix",
          "unavailable-template-report",
        );
        await assertPreserved();
        const formats = await vscode.commands.executeCommand<
          vscode.TextEdit[] | undefined
        >("vscode.executeFormatDocumentProvider", uri, {
          tabSize: 2,
          insertSpaces: true,
        });
        assert.deepEqual(formats === undefined ? [] : formats, []);
        await assertPreserved();
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
          await assertPreserved();
        }
        await replace(
          document,
          "#jinja2:line_statement_prefix:'#'\r\n{{ value",
        );
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
        assert.match(
          status.reason,
          /Template coverage is bounded and read-only/,
        );
        assert.match(status.reason, /partial coverage/);
        const beforeRevert = {
          text: document.getText(),
          eol: document.eol,
          version: document.version,
        };
        document = (await showTemplateDocument(uri)).document;
        assert.deepEqual(
          {
            text: document.getText(),
            eol: document.eol,
            version: document.version,
          },
          beforeRevert,
        );
        await vscode.commands.executeCommand("workbench.action.files.revert");
        assert.equal(document.getText(), original);
        assert.equal(document.eol, originalEol);
        assert.deepEqual(await readFile(uri.fsPath), originalBytes);
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor",
        );
        retainedDocuments.set(uri.toString(), document);
      }
      const fullRootAdapter = ownJoinedResource(
        resources,
        "full-root template adapter",
        new EditorIntegration(executable, componentUI(resources)),
      );
      try {
        await runCrossRoleTemplateConfiguration(root, fullRootAdapter);
        await runExternalTemplateDeletion(
          vscode.Uri.joinPath(root, "standalone.j2"),
          fullRootAdapter,
        );
      } finally {
        fullRootAdapter.dispose();
        await fullRootAdapter.join();
      }
      const configuration = vscode.workspace.getConfiguration(
        "saltboxLint",
        root,
      );
      const previous =
        configuration.inspect<string>("root")?.workspaceFolderValue;
      let adapter: EditorIntegration | undefined;
      resources.defer("template root configuration", () =>
        configuration.update(
          "root",
          previous,
          vscode.ConfigurationTarget.WorkspaceFolder,
        ),
      );
      const contextEvents = new vscode.EventEmitter<vscode.Uri>();
      resources.defer("template context observer", () =>
        contextEvents.dispose(),
      );
      const selectedSources: string[] = [];
      try {
        await configuration.update(
          "root",
          "roles/readonly/templates",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        adapter = ownJoinedResource(
          resources,
          "narrow-root template adapter",
          new EditorIntegration(executable, {
            ...componentUI(resources),
            roots: {
              createFileSystemWatcher: (...args) => {
                const watcher = vscode.workspace.createFileSystemWatcher(
                  ...args,
                );
                const observe =
                  (event: vscode.Event<vscode.Uri>): vscode.Event<vscode.Uri> =>
                  (listener, receiver, disposables) =>
                    event(
                      (uri) => {
                        Reflect.apply(listener, receiver, [uri]);
                        contextEvents.fire(uri);
                      },
                      undefined,
                      disposables,
                    );
                return {
                  ignoreCreateEvents: watcher.ignoreCreateEvents,
                  ignoreChangeEvents: watcher.ignoreChangeEvents,
                  ignoreDeleteEvents: watcher.ignoreDeleteEvents,
                  onDidCreate: observe(watcher.onDidCreate),
                  onDidChange: observe(watcher.onDidChange),
                  onDidDelete: observe(watcher.onDidDelete),
                  dispose: () => watcher.dispose(),
                };
              },
            },
            runProcess: async (request, signal, observer) => {
              if (request.args[0] === "check") {
                const stdin = request.args.indexOf("--stdin-filename");
                const selection = request.args.indexOf("--");
                if (stdin >= 0) selectedSources.push(request.args[stdin + 1]);
                else if (selection >= 0)
                  selectedSources.push(...request.args.slice(selection + 1));
              }
              return runProcess(request, signal, observer);
            },
          }),
        );
        const changes = vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.contentChanges.length) adapter?.change(event.document);
        });
        resources.defer("template document change listener", () =>
          changes.dispose(),
        );
        await observeClosedTemplateContext(
          resources,
          vscode.Uri.joinPath(
            root,
            "roles/readonly/templates/closed-config.yaml",
          ),
          adapter,
          contextEvents.event,
          selectedSources,
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
        await adapter?.join();
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
              vscode.Uri.joinPath(root, "roles/readonly/templates/config")
                .fsPath,
            ],
          },
          new AbortController().signal,
        ),
        /read-only/,
      );
      assert.equal(await readFile(yaml.fsPath, "utf8"), before);
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
              vscode.Uri.joinPath(
                root,
                "roles/readonly-directory/templates/config.yaml",
              ).fsPath,
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
    },
  );
}

async function runCrossRoleTemplateConfiguration(
  root: vscode.Uri,
  adapter: EditorIntegration,
): Promise<void> {
  const alias = vscode.Uri.joinPath(
    root,
    "roles/template-origin/templates/alias.j2",
  );
  const task = vscode.Uri.joinPath(
    root,
    "roles/template-origin/tasks/main.yml",
  );
  const original = await readFile(task.fsPath, "utf8");
  const template = await readFile(alias.fsPath, "utf8");
  const document = await vscode.workspace.openTextDocument(alias);
  await vscode.window.showTextDocument(document);
  try {
    await adapter.check(document, true);
    const partial = () =>
      findings(document).some(
        (item) => diagnosticCode(item) === "template-partial-coverage",
      );
    const syntax = () =>
      findings(document).some(
        (item) => diagnosticCode(item) === "template-syntax",
      );
    assert.equal(adapter.status(document).state, "current");
    assert.equal(
      partial(),
      true,
      "original role configuration makes canonical-template grammar unavailable",
    );
    assert.equal(
      syntax(),
      false,
      "task delimiter uncertainty must not fabricate default syntax errors",
    );
    // The closed original role task must refresh the canonical snapshot through
    // its real filesystem event. No manual check or synthetic event follows.
    await writeFile(task.fsPath, "[]\n");
    await waitFor(
      async () =>
        adapter.status(document).state === "current" && syntax() && !partial(),
      "original role task change refreshes the open cross-role template",
    );
    await writeFile(task.fsPath, original);
    await waitFor(
      async () =>
        adapter.status(document).state === "current" && partial() && !syntax(),
      "original role configuration recovery refreshes the canonical template snapshot",
    );
    assert.equal(await readFile(alias.fsPath, "utf8"), template);
    assert.equal(document.getText(), template);
    console.log(
      "PASS cross-role template snapshot retains original role task configuration and refreshes on its real saved event",
    );
  } finally {
    await writeFile(task.fsPath, original);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
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
  resources: TestResources,
  uri: vscode.Uri,
  adapter: EditorIntegration,
  contextEvents: vscode.Event<vscode.Uri>,
  selectedSources: string[],
): Promise<void> {
  const closedSource = realpathSync.native(uri.fsPath);
  assert.ok(
    !vscode.workspace.textDocuments.some(
      (document) =>
        classifyClosedFileEvent(document.uri, uri, closedSource) !==
        "unrelated",
    ),
    "closed template fixture has never been opened",
  );
  await adapter.ready();
  await adapter.join();
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: resources.signal },
    async (owner) => {
      const original = await owner.operation(
        "closed template original bytes",
        () => readFile(uri.fsPath),
      );
      owner.defer("closed template disk restoration", () =>
        writeFile(uri.fsPath, original),
      );
      const before = selectedSources.length;
      const changedText = "{% if closed_template_changed %}";
      const observer = ownJoinedResource(
        owner,
        "closed template filesystem event",
        observeClosedFileEvent(uri, closedSource, contextEvents, {
          expectedSha256: hash(changedText),
        }),
      );
      await owner.operation("closed template external mutation", () =>
        writeFile(uri.fsPath, changedText),
      );
      await owner.operation("closed template actual watcher event", () =>
        observer.changed(),
      );
      // The adapter's public join includes timers and complete saved rendering.
      // Observe its actual submitted selections after the real callback completes.
      await adapter.join();
      assert.ok(
        !selectedSources.slice(before).includes(closedSource),
        "narrowed physical template stays out of closed primary selections",
      );
      assert.deepEqual(
        vscode.languages
          .getDiagnostics(uri)
          .filter((item) => item.source === "saltbox-lint"),
        [],
      );
    },
  );
}
