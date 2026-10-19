import { diagnosticCode } from "./diagnostic-code.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { mkdir, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeEditorTabs } from "../support/editor-tabs.ts";
import { disposeResources } from "../../src/disposables.ts";
import { initialCodeActions, sdkCancellation } from "./initial-code-actions.ts";
import { EditorIntegration, type EditorAdapters } from "../../src/editor.ts";
import { runProcess } from "../../src/process.ts";
import {
  withTestResources,
  type TestResources,
} from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { SubcaseFailures } from "../support/subcase-failures.ts";
import {
  CodeActionEvidence,
  type ActionEvidenceStage,
} from "../support/code-action-evidence.ts";
import {
  holdProcessAdmission,
  observeDocumentChange,
} from "../support/process-admission.ts";
const jinja = '---\nvalue: "{{ value\n }}"\n';
async function waitFor(test: () => boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (!test() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  assert.ok(test(), message);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function diagnostics(uri: vscode.Uri) {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source === "saltbox-lint");
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
async function actions(
  document: vscode.TextDocument,
  evidence?: CodeActionEvidence,
  stage: ActionEvidenceStage = "warm",
) {
  const range = new vscode.Range(0, 0, document.lineCount, 0);
  const query = evidence?.begin(stage, range);
  const returned = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    document.uri,
    range,
  );
  const filtered = returned.filter((a) => a.title.includes("this file"));
  if (evidence && query) evidence.returned(query, returned, filtered);
  return filtered;
}
async function waitForInitialActions(
  document: vscode.TextDocument,
  resources: TestResources,
  evidence?: CodeActionEvidence,
) {
  // Local diagnostics can precede a usable main-thread code-action response
  // during editor/provider startup. Establish the observable fixture precondition;
  // post-mutation assertions below must still succeed without polling or rechecks.
  await initialCodeActions(
    resources,
    document,
    new vscode.Range(0, 0, document.lineCount, 0),
    (actions) =>
      actions.some(
        (action) =>
          action.title.includes("this file") &&
          action.command?.command.startsWith("saltboxLint."),
      ),
    { evidence },
  );
}
async function open(uri: vscode.Uri, text: string) {
  let existing: string | undefined;
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
      "utf8",
    );
  } catch {
    /* New test fixture. */
  }
  if (existing !== text)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(() => diagnostics(uri).length > 0, "fixture diagnosed");
  return doc;
}
async function updateFolders(
  start: number,
  count: number,
  ...folders: { uri: vscode.Uri }[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      listener.dispose();
      resolve();
    });
    if (!vscode.workspace.updateWorkspaceFolders(start, count, ...folders)) {
      listener.dispose();
      reject(new Error("workspace update was refused"));
    }
  });
}
export async function runRegressions(
  parentSignal?: AbortSignal,
): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    regressions,
  );
}

async function regressions(resources: TestResources): Promise<void> {
  const extension = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  await extension.activate();
  const roots = vscode.workspace.workspaceFolders!;
  const failures = new SubcaseFailures();
  const component = (
    owner: TestResources,
    adapters: Partial<EditorAdapters> = {},
  ) =>
    ownJoinedResource(
      owner,
      "regression component",
      new EditorIntegration(
        join(
          extension.extensionPath,
          "bin",
          "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
        ),
        adapters,
      ),
    );
  const run = async (
    name: string,
    test: (owner: TestResources) => Promise<void>,
  ) => {
    if (
      process.env.SALTBOX_REVIEW_CASE &&
      !name.startsWith(process.env.SALTBOX_REVIEW_CASE)
    )
      return;
    try {
      await withTestResources(
        { cleanupTimeoutMs: 15000, operationSignal: resources.signal },
        test,
      );
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.record(name, error);
      console.error(`FAIL ${name}`, error);
    }
  };
  await run(
    "initial SDK action setup survives in-flight matching provider registration",
    async (owner) => {
      const uri = vscode.Uri.joinPath(
        roots[0].uri,
        `sdk-initial-${randomUUID()}.yml`,
      );
      const restored = Buffer.from('---\nvalue: "{{ value }}"\n');
      let resource = uri;
      // The workspace/profile owner removes the fixture after SDK/native close.
      owner.defer("initial action fixture", async (signal) => {
        await closeEditorTabs(signal, [resource]);
        await vscode.workspace.fs.writeFile(uri, restored);
      });
      const document = await open(uri, jinja);
      resource = document.uri;
      const requested = new vscode.Range(0, 0, document.lineCount - 1, 0);
      let lateProvider: vscode.Disposable | undefined;
      const callbacks: Promise<vscode.CodeAction[]>[] = [];
      owner.defer("coexisting provider callbacks", async () => {
        const outcomes = await Promise.allSettled(callbacks);
        const failures = outcomes.filter(
          (result) => result.status === "rejected",
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Coexisting provider callbacks failed",
          );
      });
      let triggered = false;
      const blocker = vscode.languages.registerCodeActionsProvider("*", {
        provideCodeActions(_document, range, context, token) {
          if (
            triggered ||
            context.triggerKind !== vscode.CodeActionTriggerKind.Invoke ||
            !range.isEqual(requested)
          )
            return [];
          triggered = true;
          const pending = (async (): Promise<vscode.CodeAction[]> => {
            let complete!: () => void;
            let reject!: (error: unknown) => void;
            const receipt = new Promise<void>((done, fail) => {
              complete = done;
              reject = fail;
            });
            const cancelled = token.onCancellationRequested(() => complete());
            const abort = () => reject(owner.signal.reason);
            owner.signal.addEventListener("abort", abort, { once: true });
            const timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Matching registration did not cancel the SDK cohort",
                  ),
                ),
              10000,
            );
            try {
              // The callback proves that the SDK selected this cohort. Observe
              // cancellation before registering the new matching provider.
              lateProvider = vscode.languages.registerCodeActionsProvider("*", {
                provideCodeActions: () => [],
              });
              if (token.isCancellationRequested) complete();
              if (owner.signal.aborted) abort();
              await receipt;
              return [];
            } finally {
              clearTimeout(timeout);
              owner.signal.removeEventListener("abort", abort);
              cancelled.dispose();
            }
          })();
          callbacks.push(pending);
          return pending;
        },
      });
      owner.defer("coexisting action providers", () =>
        disposeResources(lateProvider ? [lateProvider, blocker] : [blocker]),
      );
      const ready = (actions: readonly vscode.CodeAction[]) =>
        actions.some(
          (action) =>
            action.title.includes("this file") &&
            action.command?.command === "saltboxLint.applySharedFix",
        );
      let queries = 0;
      let firstActions: vscode.CodeAction[] | undefined;
      let firstCancelled = false;
      const result = await initialCodeActions(
        owner,
        document,
        requested,
        ready,
        {
          async request() {
            const first = ++queries === 1;
            const pending = vscode.commands.executeCommand<vscode.CodeAction[]>(
              "vscode.executeCodeActionProvider",
              document.uri,
              requested,
            );
            try {
              const returned = await pending;
              if (first) firstActions = returned;
              return returned;
            } catch (error) {
              if (first && sdkCancellation(error)) firstCancelled = true;
              throw error;
            }
          },
        },
      );
      assert.equal(
        triggered,
        true,
        "the controlled provider must join the original SDK cohort",
      );
      assert.ok(
        firstCancelled || (firstActions && !ready(firstActions)),
        "the controlled registration must invalidate the original SDK cohort",
      );
      assert.ok(
        result.queries >= 2,
        "setup must observe the invalidated cohort before the actual action",
      );
      assert.ok(ready(result.actions));
      console.log(
        "SALTBOX_INITIAL_ACTION_COHORT " +
          JSON.stringify({
            queries: result.queries,
            firstCancelled,
            firstActions: firstActions?.map((action) => ({
              title: action.title,
              command: action.command?.command,
            })),
            finalCommands: result.actions.map(
              (action) => action.command?.command,
            ),
          }),
      );
    },
  );
  await run(
    "I1 unrelated edits preserve current actions and pending format",
    async (owner) => {
      const document = await open(
        vscode.Uri.joinPath(roots[0].uri, "independent.yml"),
        jinja,
      );
      const markdownUri = vscode.Uri.joinPath(roots[1].uri, "readme.md");
      await vscode.workspace.fs.writeFile(markdownUri, Buffer.from("one\n"));
      const markdown = await vscode.workspace.openTextDocument(markdownUri);
      const evidence = new CodeActionEvidence(
        [
          {
            label: "yaml",
            document,
            diagnostics: () => vscode.languages.getDiagnostics(document.uri),
          },
          {
            label: "markdown",
            document: markdown,
            diagnostics: () => vscode.languages.getDiagnostics(markdown.uri),
          },
        ],
        {
          changed: vscode.workspace.onDidChangeTextDocument,
          opened: vscode.workspace.onDidOpenTextDocument,
          closed: vscode.workspace.onDidCloseTextDocument,
          diagnosticsChanged: vscode.languages.onDidChangeDiagnostics,
          write: (line) => console.error(line),
        },
      );
      owner.defer("I1 code action evidence", () => evidence.dispose());
      try {
        await waitForInitialActions(document, owner, evidence);
      } catch (error) {
        evidence.failure("warm", error);
      }
      await replace(markdown, "two\n");
      try {
        const afterMarkdown = await actions(
          document,
          evidence,
          "after-markdown",
        );
        assert.ok(
          afterMarkdown.length > 0,
          "unrelated Markdown invalidated YAML actions",
        );
      } catch (error) {
        evidence.failure("after-markdown", error);
      }
      const otherYaml = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(roots[1].uri, "roles/example/defaults/main.yml"),
      );
      evidence.track({
        label: "other-yaml",
        document: otherYaml,
        diagnostics: () => vscode.languages.getDiagnostics(otherYaml.uri),
      });
      await replace(otherYaml, '---\nexample_value: "{{ other\n }}"\n');
      await otherYaml.save();
      await waitFor(
        () =>
          diagnostics(otherYaml.uri).some(
            (d) => diagnosticCode(d) === "jinja-layout",
          ),
        "other root saved diagnostics refreshed",
      );
      try {
        const afterOtherYaml = await actions(
          document,
          evidence,
          "after-other-yaml",
        );
        assert.ok(
          afterOtherYaml.length > 0,
          "another root's YAML save invalidated cached actions",
        );
      } catch (error) {
        evidence.failure("after-other-yaml", error);
      }
      const formatGate = ownJoinedResource(
        owner,
        "unrelated edit format admission",
        holdProcessAdmission(runProcess, "format"),
      );
      const editor = component(owner, { runProcess: formatGate.runProcess });
      const changes = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) editor.change(e.document);
      });
      try {
        await replace(document, 'value: ["😀",1]\n');
        const pending = owner.operation("format during unrelated edit", () =>
          editor.format(document, "canonical"),
        );
        const admitted = await owner.operation(
          "unrelated edit format snapshot",
          () => formatGate.admission(),
        );
        assert.equal(admitted.input, document.getText());
        const changed = ownJoinedResource(
          owner,
          "unrelated Markdown edit receipt",
          observeDocumentChange(
            markdown,
            vscode.workspace.onDidChangeTextDocument,
          ),
        );
        await replace(markdown, "three\n");
        await changed.changed();
        formatGate.release();
        assert.ok(
          (await pending).length > 0,
          "unrelated edit discarded pending format",
        );
      } finally {
        formatGate.release();
        changes.dispose();
        editor.dispose();
      }
    },
  );
  await run(
    "I1 unrelated Markdown preserves a pending actual CLI format",
    async (owner) => {
      const document = await open(
        vscode.Uri.joinPath(roots[0].uri, "pending.yml"),
        jinja,
      );
      const markdownUri = vscode.Uri.joinPath(roots[1].uri, "pending.md");
      await vscode.workspace.fs.writeFile(markdownUri, Buffer.from("one"));
      const markdown = await vscode.workspace.openTextDocument(markdownUri);
      const formatGate = ownJoinedResource(
        owner,
        "pending actual format admission",
        holdProcessAdmission(runProcess, "format"),
      );
      const editor = component(owner, { runProcess: formatGate.runProcess });
      const changes = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length) editor.change(event.document);
      });
      try {
        await replace(document, "value: [1,2]\n");
        const pending = owner.operation(
          "actual format during Markdown edit",
          () => editor.format(document, "canonical"),
        );
        const admitted = await owner.operation(
          "pending actual format snapshot",
          () => formatGate.admission(),
        );
        assert.equal(admitted.input, document.getText());
        const changed = ownJoinedResource(
          owner,
          "pending Markdown edit receipt",
          observeDocumentChange(
            markdown,
            vscode.workspace.onDidChangeTextDocument,
          ),
        );
        await replace(markdown, "changed");
        await changed.changed();
        formatGate.release();
        assert.ok(
          (await pending).length > 0,
          "unrelated edit discarded pending format",
        );
      } finally {
        formatGate.release();
        changes.dispose();
        editor.dispose();
      }
    },
  );
  await run(
    "I2 closing one of two tabs preserves the remaining owner",
    async () => {
      const document = await open(
        vscode.Uri.joinPath(roots[0].uri, "two-tabs.yml"),
        jinja,
      );
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
      const owners = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === document.uri.toString(),
        );
      assert.equal(owners.length, 2);
      await vscode.window.tabGroups.close(owners[0], true);
      assert.ok(
        diagnostics(document.uri).length > 0,
        "first tab close cleared a still-owned document",
      );
      assert.ok((await actions(document)).length > 0);
    },
  );
  await run(
    "I2 closed retained models stay cleared through context refresh until reopen",
    async () => {
      const document = await open(
        vscode.Uri.joinPath(roots[0].uri, "closed.yml"),
        jinja,
      );
      await actions(document);
      const owners = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === document.uri.toString(),
        );
      await vscode.window.tabGroups.close(owners, true);
      await waitFor(
        () => diagnostics(document.uri).length === 0,
        "close clears diagnostics",
      );
      const other = await open(
        vscode.Uri.joinPath(roots[0].uri, "refresh.yml"),
        jinja,
      );
      await replace(other, jinja + "\n");
      await other.save();
      await waitFor(
        () => diagnostics(other.uri).length > 0,
        "refresh completed for active owner",
      );
      await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
      assert.equal(
        diagnostics(document.uri).length,
        0,
        "context refresh republished a closed tab",
      );
      await vscode.window.showTextDocument(document, { preview: false });
      await waitFor(
        () => diagnostics(document.uri).length > 0,
        "reopen rechecks retained model",
      );
    },
  );
  await run(
    "I4 dirty symlink workspace suppresses canonical saved diagnostics",
    async () => {
      const parent = join(roots[0].uri.fsPath, "..", "alias-case");
      const diskRoot = join(parent, "real");
      const aliasRoot = join(parent, "alias");
      await mkdir(join(diskRoot, "roles/example/defaults"), {
        recursive: true,
      });
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(join(diskRoot, ".saltbox-lint")),
        new Uint8Array(),
      );
      spawnSync("git", ["init", "-q", diskRoot]);
      try {
        await symlink(
          diskRoot,
          aliasRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(join(aliasRoot, "roles/example/defaults/main.yml")),
        Buffer.from(jinja),
      );
      const alias = vscode.Uri.file(
        join(aliasRoot, "roles/example/defaults/main.yml"),
      );
      const canonical = vscode.Uri.file(await realpath(alias.fsPath));
      const index = vscode.workspace.workspaceFolders!.length;
      await updateFolders(index, 0, { uri: vscode.Uri.file(aliasRoot) });
      await waitFor(
        () => vscode.workspace.workspaceFolders!.length === index + 1,
        "alias workspace added",
      );
      try {
        const document = await open(alias, jinja);
        const saved = spawnSync(
          join(
            extension.extensionPath,
            "bin",
            "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
          ),
          ["check", "--root", diskRoot, "--format", "json", "."],
          { cwd: diskRoot, encoding: "utf8" },
        );
        assert.ok(
          JSON.parse(saved.stdout).diagnostics.some(
            (d: { rule_id: string }) => d.rule_id === "jinja-layout",
          ),
          "saved fixture must be discoverable and dirty-different",
        );
        await replace(document, "value: clean\n");
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        assert.ok(
          !diagnostics(alias).some((d) => diagnosticCode(d) === "jinja-layout"),
        );
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
        assert.equal(
          diagnostics(canonical).length,
          0,
          "saved diagnostics leaked through canonical URI",
        );
        assert.ok(
          !diagnostics(alias).some((d) => diagnosticCode(d) === "jinja-layout"),
        );
        await replace(document, 'value: "{{ unsaved\n }}"\n');
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        await waitFor(
          () => diagnostics(alias).length > 0,
          "dirty alias diagnosed",
        );
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
        assert.equal(diagnostics(canonical).length, 0);
        assert.ok(diagnostics(alias).length > 0);
      } finally {
        await updateFolders(index, 1);
        await waitFor(
          () => vscode.workspace.workspaceFolders!.length === index,
          "alias workspace removed",
        );
      }
      await updateFolders(index, 0, { uri: vscode.Uri.file(diskRoot) });
      await waitFor(
        () => vscode.workspace.workspaceFolders!.length === index + 1,
        "canonical replacement root added",
      );
      try {
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
        const expectedOwner = await realpath(
          join(diskRoot, "roles/example/defaults/main.yml"),
        );
        const observedOwner = await realpath(canonical.fsPath);
        assert.equal(observedOwner, expectedOwner);
        const savedDiagnostics = diagnostics(canonical);
        assert.ok(
          savedDiagnostics.some(
            (diagnostic) => diagnosticCode(diagnostic) === "jinja-layout",
          ),
          "removed alias still owns a canonical scan source",
        );
        console.log(
          "SALTBOX_I4_SAVED_OWNER " +
            JSON.stringify({
              stage: "canonical replacement saved source",
              queryURI: canonical.toString().slice(0, 2048),
              expectedOwner: expectedOwner.slice(0, 2048),
              observedOwner: observedOwner.slice(0, 2048),
              diagnostics: savedDiagnostics.slice(0, 16).map((diagnostic) => ({
                code: diagnosticCode(diagnostic),
                start: {
                  line: diagnostic.range.start.line,
                  character: diagnostic.range.start.character,
                },
                end: {
                  line: diagnostic.range.end.line,
                  character: diagnostic.range.end.character,
                },
              })),
              truncated: savedDiagnostics.length > 16,
            }),
        );
      } finally {
        await updateFolders(index, 1);
        await waitFor(
          () => vscode.workspace.workspaceFolders!.length === index,
          "replacement root removed",
        );
      }
    },
  );
  await run(
    "I6 parent root refresh preserves nested open diagnostics",
    async (owner) => {
      const nested = vscode.Uri.joinPath(roots[0].uri, "roles/example");
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(nested, ".saltbox-lint"),
        new Uint8Array(),
      );
      const index = vscode.workspace.workspaceFolders!.length;
      await updateFolders(index, 0, { uri: nested });
      const editor = component(owner);
      try {
        const document = await open(
          vscode.Uri.joinPath(nested, "defaults/main.yml"),
          jinja,
        );
        await editor.checkWorkspace();
        await editor.check(document);
        const before = diagnostics(document.uri);
        assert.ok(before.some((d) => diagnosticCode(d) === "jinja-layout"));
        editor.refresh([roots[0].uri]);
        assert.deepEqual(
          diagnostics(document.uri),
          before,
          "parent scan invalidation cleared the unaffected nested document owner",
        );
      } finally {
        editor.dispose();
        await updateFolders(index, 1);
      }
    },
  );
  await run(
    "I6 installed parent save preserves nested document diagnostics",
    async () => {
      const nested = vscode.Uri.joinPath(roots[0].uri, "roles/example");
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(nested, ".saltbox-lint"),
        new Uint8Array(),
      );
      const index = vscode.workspace.workspaceFolders!.length;
      await updateFolders(index, 0, { uri: nested });
      try {
        const document = await open(
          vscode.Uri.joinPath(nested, "defaults/main.yml"),
          jinja,
        );
        const parent = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(roots[0].uri, "independent.yml"),
        );
        // Establish initial watcher quiescence before populating both saved scans.
        await pause(500);
        await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        const before = diagnostics(document.uri);
        assert.ok(before.some((d) => diagnosticCode(d) === "jinja-layout"));
        await replace(parent, jinja + "# scoped parent refresh\n");
        await parent.save();
        await waitFor(
          () =>
            diagnostics(parent.uri).some(
              (d) => diagnosticCode(d) === "jinja-layout",
            ),
          "affected parent refresh completed",
        );
        assert.deepEqual(
          diagnostics(document.uri),
          before,
          "installed parent save cleared nested diagnostics",
        );
      } finally {
        await updateFolders(index, 1);
      }
    },
  );
  await run(
    "POLICY explicitly grouped Cloudflare condition stays intact",
    async () => {
      const directory = vscode.Uri.joinPath(
        roots[0].uri,
        "roles/example/tasks",
      );
      await vscode.workspace.fs.createDirectory(directory);
      const source =
        '- name: Check Cloudflare state\n  ansible.builtin.debug:\n    msg: "{{ value\n     }}"\n  when:\n    - ((cloudflare_ipv4_record is defined) and (cloudflare_ipv4_record | length > 0))\n';
      const document = await open(
        vscode.Uri.joinPath(directory, "grouped-when.yml"),
        source,
      );
      await waitFor(
        () =>
          diagnostics(document.uri).some(
            (d) => diagnosticCode(d) === "jinja-layout",
          ),
        "actual source snapshot diagnosed",
      );
      assert.ok(
        !diagnostics(document.uri).some(
          (d) =>
            diagnosticCode(d) === "ansible-when-list" ||
            diagnosticCode(d) === "ansible-when-parentheses",
        ),
        "explicitly grouped Cloudflare condition was split or rejected",
      );
      assert.equal(document.getText(), source);
    },
  );
  await run(
    "I5 a retained quick fix cannot bind to a replacement report",
    async () => {
      const folder = vscode.Uri.joinPath(roots[0].uri, "roles/example/tasks");
      await vscode.workspace.fs.createDirectory(folder);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(folder, ".saltbox-lint"),
        new Uint8Array(),
      );
      const source =
        '################################\n# Settings\n################################\nvalue: "{{ a\n | f }}"\n';
      const document = await open(
        vscode.Uri.joinPath(folder, "main.yml"),
        source,
      );
      let original: vscode.CodeAction | undefined;
      for (let attempt = 0; attempt < 100 && !original; attempt++) {
        original = (await actions(document)).find((action) =>
          action.title.includes("Jinja"),
        );
        if (!original) await pause(25);
      }
      assert.ok(original?.command);
      const config = vscode.workspace.getConfiguration(
        "saltboxLint",
        roots[0].uri,
      );
      try {
        await config.update(
          "root",
          "roles/example/tasks",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        await waitFor(
          () =>
            diagnostics(document.uri).some(
              (d) => diagnosticCode(d) === "section-spacing",
            ),
          "root configuration refresh completed",
        );
        await vscode.commands.executeCommand("saltboxLint.checkDocument");
        await waitFor(
          () =>
            diagnostics(document.uri).some(
              (d) => diagnosticCode(d) === "section-spacing",
            ),
          "new root report has reassigned fix IDs",
        );
        const replacement = await actions(document);
        assert.ok(
          replacement.some((action) => action.title.includes("blank lines")),
        );
        assert.equal(document.getText(), source);
        await vscode.commands.executeCommand(
          original.command.command,
          ...(original.command.arguments ?? []),
        );
        assert.equal(
          document.getText(),
          source,
          "old action applied new report's fix-1",
        );
      } finally {
        await config.update(
          "root",
          undefined,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
      }
    },
  );
  failures.throwIfAny("review regressions");
}
