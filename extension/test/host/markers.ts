import { hostTemporaryDirectory } from "../support/host-temporary.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { rm, mkdir, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EditorIntegration } from "../../src/editor.ts";
import { runProcess } from "../../src/process.ts";
import {
  updateProviders,
  type ProviderRegistration,
} from "../../src/providers.ts";
import { withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { componentUI } from "../support/component-ui.ts";
import { observeRootFormatting } from "./root-observations.ts";
import { checkMarkerEvents } from "./marker-events.ts";
import { checkFormatReadiness } from "./format-readiness.ts";
import { gateFormatterSource } from "./formatter-source-gate.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const diagnostics = (uri: vscode.Uri) =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === "saltbox-lint");
async function waitFor(
  test: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await pause(25);
  }
  assert.fail(message);
}
async function actions(document: vscode.TextDocument) {
  return (
    await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
    )
  ).filter((a) => a.title.startsWith("Saltbox Lint:"));
}
async function formatting(document: vscode.TextDocument) {
  return (
    (await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      document.uri,
      { tabSize: 2, insertSpaces: true },
    )) ?? []
  );
}
async function marker(root: vscode.Uri, present: boolean) {
  const uri = vscode.Uri.joinPath(root, ".saltbox-lint");
  if (present) await vscode.workspace.fs.writeFile(uri, new Uint8Array());
  else await vscode.workspace.fs.delete(uri, { recursive: true });
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
export async function runMarkers(parentSignal?: AbortSignal): Promise<void> {
  return withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: parentSignal },
    async (resources) => {
      const extension = vscode.extensions.getExtension(
        "saltyorg.saltbox-lint",
      )!;
      const roots = vscode.workspace.workspaceFolders!;
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(roots[0].uri, "roles/example/defaults/main.yml"),
      );
      await vscode.window.showTextDocument(document, { preview: false });
      await pause(700);
      assert.equal(
        extension.isActive,
        false,
        "opening unmarked YAML must not activate the extension",
      );
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.equal(
        extension.isActive,
        true,
        "manual command bootstraps the marker watcher",
      );
      assert.deepEqual(
        diagnostics(document.uri),
        [],
        "unmarked root must not publish diagnostics through manual command activation",
      );
      assert.deepEqual(await formatting(document), []);
      assert.deepEqual(await actions(document), []);
      console.log(
        "PASS unmarked YAML startup stays inactive; implicit command activation remains inert",
      );

      const temporary = await hostTemporaryDirectory("saltbox-marker-");
      const log = join(temporary, "process.log");
      const fixtureEnv: NodeJS.ProcessEnv = { SALTBOX_TEST_PROCESS_LOG: log };
      resources.defer("marker component fixtures", () =>
        rm(temporary, { recursive: true, force: true }),
      );
      const fixtureProcess: typeof runProcess = (request, signal, observer) =>
        runProcess({ ...request, env: fixtureEnv }, signal, observer);
      const isolated = ownJoinedResource(
        resources,
        "unmarked adapter",
        new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!, {
          ...componentUI(resources),
          runProcess: fixtureProcess,
        }),
      );
      try {
        await isolated.check(document, true);
        await isolated.checkWorkspace();
        assert.deepEqual(await isolated.format(document, "canonical"), []);
        await isolated.fixAll(document.uri);
        assert.equal(
          existsSync(log),
          false,
          "unmarked roots must not spawn any CLI process",
        );
        assert.deepEqual(isolated.providerDocuments(), []);
      } finally {
        isolated.dispose();
        await isolated.join();
      }

      await marker(roots[0].uri, true);
      await waitFor(
        () =>
          diagnostics(document.uri).some(
            (d) => diagnosticCode(d) === "jinja-layout",
          ),
        "marker creation starts fresh checks",
      );
      const original = document.getText();
      assert.ok(
        (await formatting(document)).length > 0,
        "marked root formatter available",
      );
      const savedActions = await actions(document);
      assert.ok(savedActions.length > 0);
      const second = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(roots[1].uri, "roles/example/defaults/main.yml"),
      );
      await vscode.window.showTextDocument(second, { preview: false });
      await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
      assert.deepEqual(diagnostics(second.uri), []);
      assert.deepEqual(await actions(second), []);
      assert.deepEqual(await formatting(second), []);
      assert.ok(diagnostics(document.uri).length > 0);
      console.log(
        "PASS mixed roots isolate diagnostics, workspace scans, actions and formatting",
      );

      await marker(roots[1].uri, true);
      await waitFor(
        () => diagnostics(second.uri).length > 0,
        "second root opts in",
      );
      await checkFormatReadiness(
        join(
          extension.extensionPath,
          "bin",
          "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
        ),
        document,
        resources.signal,
      );
      await replace(document, original + "# hang\n");
      const pending = ownJoinedResource(
        resources,
        "marker cancellation adapter",
        new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!, {
          ...componentUI(resources),
          runProcess: fixtureProcess,
        }),
      );
      try {
        const check = resources.operation("marker canceled check", () =>
          pending.check(document),
        );
        const format = resources.operation("marker canceled format", () =>
          pending.format(document, "canonical"),
        );
        await waitFor(
          () =>
            existsSync(log) &&
            ["check", "format"].every((command) =>
              readFileSync(log, "utf8")
                .split("\n")
                .some((line) => line.split(" ")[1] === command),
            ),
          "both real CLI processes started",
        );
        const pids = readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => Number(line.split(" ")[0]));
        await marker(roots[0].uri, false);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          pending.dispose();
        }, 5000);
        try {
          assert.deepEqual(await format, []);
          assert.equal(
            timedOut,
            false,
            "marker removal cancels pending format within its existing budget",
          );
        } finally {
          clearTimeout(timer);
          await format;
        }
        await check;
        await waitFor(
          () =>
            pids.every((pid) => {
              try {
                process.kill(pid, 0);
                return false;
              } catch {
                return true;
              }
            }),
          "marker removal kills pending CLI processes",
        );
        assert.equal(pending.providerDocuments().includes(document), false);
      } finally {
        pending.dispose();
        await pending.join();
      }
      await replace(document, original);
      await waitFor(
        () => diagnostics(document.uri).length === 0,
        "removed marker clears diagnostics",
      );
      assert.ok(
        diagnostics(second.uri).length > 0,
        "unaffected marked root remains diagnosed",
      );
      for (const action of savedActions.filter(
        (a) => a.command?.command === "saltboxLint.applySharedFix",
      ))
        await vscode.commands.executeCommand(
          action.command!.command,
          ...action.command!.arguments!,
        );
      await vscode.commands.executeCommand("saltboxLint.fixAll", document.uri);
      assert.equal(
        document.getText(),
        original,
        "cached/manual fixes cannot bypass marker removal",
      );
      assert.deepEqual(await formatting(document), []);
      assert.deepEqual(await actions(document), []);
      console.log(
        "PASS marker deletion cancels real pending processes, clears stale state and preserves other roots",
      );

      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint"),
      );
      await pause(300);
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.deepEqual(
        diagnostics(document.uri),
        [],
        "marker directory does not opt in",
      );
      await marker(roots[0].uri, false);
      await marker(roots[0].uri, true);
      await waitFor(
        () => diagnostics(document.uri).length > 0,
        "regular marker re-add restores fresh checks",
      );
      assert.ok((await formatting(document)).length > 0);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint"),
        Buffer.from("{}\n"),
      );
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      await waitFor(
        () => diagnostics(document.uri).length > 0,
        "nonempty valid configuration keeps the root enabled",
      );
      const renamedMarker = vscode.Uri.joinPath(
        roots[0].uri,
        ".saltbox-lint-disabled",
      );
      const rename = new vscode.WorkspaceEdit();
      rename.renameFile(
        vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint"),
        renamedMarker,
      );
      assert.equal(await vscode.workspace.applyEdit(rename), true);
      await waitFor(
        () => diagnostics(document.uri).length === 0,
        "marker rename withdraws opt-in",
      );
      assert.deepEqual(await formatting(document), []);
      await vscode.workspace.fs.rename(
        renamedMarker,
        vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint"),
      );
      await waitFor(
        () => diagnostics(document.uri).length > 0,
        "renaming marker back restores fresh checks",
      );
      console.log(
        "PASS nonregular marker rejected and regular marker re-add restores providers",
      );
      const nested = vscode.Uri.joinPath(roots[0].uri, "roles/example");
      const nestedIndex = vscode.workspace.workspaceFolders!.length;
      const updateFolders = async (count: number, add = false) => {
        await new Promise<void>((resolve, reject) => {
          const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            listener.dispose();
            resolve();
          });
          if (
            !vscode.workspace.updateWorkspaceFolders(
              nestedIndex,
              count,
              ...(add ? [{ uri: nested }] : []),
            )
          ) {
            listener.dispose();
            reject(new Error("workspace change refused"));
          }
        });
      };
      const nestedObservation = observeRootFormatting(document);
      resources.defer("nested workspace formatting observations", () =>
        nestedObservation.dispose(),
      );
      await updateFolders(0, true);
      try {
        await waitFor(
          () => diagnostics(document.uri).length === 0,
          "new unmarked nested owner clears parent diagnostics",
        );
        const closedUri = vscode.Uri.joinPath(nested, "defaults/closed.yml");
        await vscode.workspace.fs.writeFile(closedUri, Buffer.from(original));
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
        assert.deepEqual(
          diagnostics(closedUri),
          [],
          "parent saved scan cannot publish into unmarked closed child file",
        );
        assert.deepEqual(diagnostics(document.uri), []);
        assert.deepEqual(await formatting(document), []);
        assert.deepEqual(await actions(document), []);
        await marker(nested, true);
        await waitFor(
          () => diagnostics(document.uri).length > 0,
          "nested root opts in independently",
        );
        const nestedEdits = await formatting(document);
        try {
          assert.ok(nestedEdits.length > 0);
        } catch (error) {
          try {
            nestedObservation.note("nested workspace format response", {
              edits: nestedEdits.length,
            });
            console.error(
              "SALTBOX_MARKER_FORMAT_FAILURE " + nestedObservation.report(),
            );
          } catch (evidenceError) {
            throw new AggregateError(
              [error, evidenceError],
              "Nested workspace formatting and its failure evidence failed",
              { cause: error },
            );
          }
          throw error;
        }
        await marker(nested, false);
      } finally {
        await updateFolders(1);
      }
      console.log(
        "PASS nested unmarked workspace ownership excludes parent providers and saved scans",
      );

      const config = vscode.workspace.getConfiguration(
        "saltboxLint",
        roots[0].uri,
      );
      const observed = observeRootFormatting(document);
      try {
        await config.update(
          "root",
          "roles/example",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        observed.note("after-config-update");
        try {
          await waitFor(
            () => diagnostics(document.uri).length === 0,
            "override requires its own marker",
          );
          observed.note("after-diagnostics-clear");
          await marker(nested, true);
          observed.note("after-marker-create");
          await waitFor(
            () => diagnostics(document.uri).length > 0,
            "nested override marker restores checks",
          );
          observed.note("after-diagnostics-return");
          observed.note("before-format");
          const edits = await formatting(document);
          observed.note("after-format", { edits: edits.length });
          const failure =
            edits.length === 0
              ? "nested override formatter unavailable: " + observed.report()
              : undefined;
          assert.ok(edits.length > 0, failure);
        } finally {
          await marker(nested, false);
          await config.update(
            "root",
            undefined,
            vscode.ConfigurationTarget.WorkspaceFolder,
          );
        }
      } finally {
        observed.dispose();
      }

      const externalRoot = join(roots[0].uri.fsPath, "..", "external-root");
      await mkdir(externalRoot, { recursive: true });
      assert.equal(spawnSync("git", ["init", "-q", externalRoot]).status, 0);
      const alias = join(roots[0].uri.fsPath, "external");
      await symlink(
        externalRoot,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const specialUri = vscode.Uri.file(join(alias, "[value]{one}.yml"));
      await vscode.workspace.fs.writeFile(specialUri, Buffer.from(original));
      const special = await vscode.workspace.openTextDocument(specialUri);
      await vscode.window.showTextDocument(special, { preview: false });
      await config.update(
        "root",
        externalRoot,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      try {
        await marker(vscode.Uri.file(externalRoot), true);
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        await waitFor(
          () => diagnostics(special.uri).length > 0,
          "external override marker watches source host",
        );
        assert.ok(
          (await formatting(special)).length > 0,
          "literal glob characters retain formatter registration",
        );
        // setTextDocumentLanguage is a no-op when the mode already matches.
        // Establish a real transition before observing automatic source admission.
        const languageSource = await vscode.languages.setTextDocumentLanguage(
          special,
          "plaintext",
        );
        assert.equal(languageSource.languageId, "plaintext");
        assert.equal(languageSource.uri.toString(), special.uri.toString());
        const sourceIdentity = await realpath(languageSource.uri.fsPath);
        const sourceGate = gateFormatterSource(
          languageSource.uri,
          sourceIdentity,
        );
        const component = ownJoinedResource(
          resources,
          "literal-path provider adapter",
          new EditorIntegration(
            join(
              extension.extensionPath,
              "bin",
              "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
            ),
            { ...componentUI(resources), readFile: sourceGate.readFile },
          ),
        );
        const providers = new Map<string, ProviderRegistration>();
        resources.defer("literal-path component providers", () => {
          for (const provider of providers.values())
            provider.disposable.dispose();
          providers.clear();
        });
        resources.defer("formatter source gate", () => sourceGate.dispose());
        let controlledFormatter:
          vscode.DocumentFormattingEditProvider | undefined;
        const refreshProviders = () =>
          updateProviders(
            {
              providerDocuments: () => component.providerDocuments(),
              writable: (document) => component.writable(document),
              actions: (document, range) => component.actions(document, range),
              navigation: component.navigation,
              format: (document, mode, token) =>
                sourceGate.invoke(document, () =>
                  component.format(document, mode, token),
                ),
            },
            providers,
            {
              registerDocumentFormattingEditProvider(selector, provider) {
                const source = vscode.workspace.textDocuments.find(
                  (document) =>
                    document.uri.toString() === languageSource.uri.toString() &&
                    !document.isClosed,
                );
                if (source && vscode.languages.match(selector, source) > 0)
                  controlledFormatter = provider;
                const registration =
                  vscode.languages.registerDocumentFormattingEditProvider(
                    selector,
                    provider,
                  );
                return new vscode.Disposable(() => {
                  if (controlledFormatter === provider)
                    controlledFormatter = undefined;
                  registration.dispose();
                });
              },
            },
          );
        const eligibility = component.onDidChangeEligibility(refreshProviders);
        resources.defer("literal-path eligibility listener", () =>
          eligibility.dispose(),
        );
        let changed: vscode.TextDocument | undefined;
        let pendingFormat: Promise<vscode.TextEdit[]> | undefined;
        try {
          changed = await vscode.languages.setTextDocumentLanguage(
            languageSource,
            "ansible",
          );
          assert.equal(changed.languageId, "ansible");
          assert.equal(changed.uri.toString(), languageSource.uri.toString());
          assert.equal(changed.isClosed, false);
          assert.ok(vscode.workspace.textDocuments.includes(changed));
          // The installed product retains the real language transition and result check.
          await waitFor(
            async () => (await formatting(changed!)).length > 0,
            "installed Ansible formatter is available after automatic language admission",
          );
          await component.check(changed, true);
          refreshProviders();
          // A separately owned native component provider holds its injected read.
          // Installed provider registrations and global filesystem APIs stay untouched.
          await waitFor(
            () =>
              sourceGate.counts().automaticEntries > 0 &&
              providers.has(changed!.uri.toString()),
            "automatic Ansible admission restores its literal-path formatter",
          );
          const cancellation = new vscode.CancellationTokenSource();
          resources.defer("literal-path provider cancellation", () =>
            cancellation.dispose(),
          );
          let settled = false;
          pendingFormat = resources.operation(
            "held literal-path formatting",
            () =>
              Promise.resolve(
                controlledFormatter!.provideDocumentFormattingEdits(
                  changed!,
                  { tabSize: 2, insertSpaces: true },
                  cancellation.token,
                ),
              ).then((edits) => {
                settled = true;
                return edits ?? [];
              }),
          );
          const first = await Promise.race([
            sourceGate.entered.then(() => "identity"),
            pendingFormat.then(() => "settled"),
          ]);
          assert.equal(
            first,
            "identity",
            "Ansible formatter must validate source identity before settling: " +
              JSON.stringify(sourceGate.counts()),
          );
          assert.equal(sourceGate.counts().invocations, 1);
          assert.ok(sourceGate.counts().formatterEntries > 0);
          assert.equal(settled, false, "formatter waits for source validation");
          sourceGate.release();
          assert.ok(
            (await pendingFormat).length > 0,
            "Ansible formatter remains available after source validation",
          );
        } finally {
          await sourceGate.dispose();
          if (pendingFormat) await Promise.allSettled([pendingFormat]);
        }
        await marker(vscode.Uri.file(externalRoot), false);
        await waitFor(
          () => diagnostics(special.uri).length === 0,
          "outside workspace marker removal observed",
        );
        assert.ok(changed);
        assert.equal(changed.isClosed, false);
        assert.deepEqual(await formatting(changed), []);
      } finally {
        await config.update(
          "root",
          undefined,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
      }
      console.log(
        "PASS nested/external root overrides and literal-path YAML/Ansible provider lifecycle",
      );
      await checkMarkerEvents(
        extension.extensionPath,
        document,
        resources.signal,
      );
    },
  );
}
