import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EditorIntegration } from "../../src/editor.ts";

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
export async function runSaveScope(): Promise<void> {
  const roots = vscode.workspace.workspaceFolders!;
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-save-scope-"));
  const log = join(temporary, "process.log");
  process.env.SALTBOX_TEST_PROCESS_LOG = log;
  const invocations = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
  const editor = new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!);
  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length) editor.change(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) =>
      editor.saved(document),
    ),
  ];
  const failures: string[] = [];
  const run = async (name: string, test: () => Promise<void>) => {
    if (
      process.env.SALTBOX_REVIEW_CASE &&
      !name.startsWith(process.env.SALTBOX_REVIEW_CASE)
    )
      return;
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}`, error);
    }
  };
  try {
    await run("one startup saved scan per marked root", async () => {
      await waitFor(
        () => invocations().filter((line) => line.endsWith(" .")).length >= 2,
        "startup should launch one saved scan for each marked root",
      );
      assert.equal(
        invocations().filter((line) => line.endsWith(" .")).length,
        2,
      );
    });
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(roots[0].uri, "roles/example/defaults/main.yml"),
    );
    const canonicalFilename = await realpath(document.uri.fsPath);
    const otherUri = vscode.Uri.joinPath(roots[0].uri, "other.yml");
    await vscode.workspace.fs.writeFile(
      otherUri,
      Buffer.from('value: "{{ other\n }}"\n'),
    );
    const other = await vscode.workspace.openTextDocument(otherUri);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.window.showTextDocument(other, { preview: false });
    await editor.check(document, true);
    await editor.check(other, true);
    await pause(300);
    const original = document.getText();
    await run(
      "typing retains displayed findings but revokes stale actions",
      async () => {
        const before = findings(document.uri);
        assert.ok(before.length > 0);
        const actions = editor.actions(
          document,
          new vscode.Range(0, 0, document.lineCount, 0),
        );
        const saved = actions.find(
          (action) => action.command?.command === "saltboxLint.applySharedFix",
        )!.command!;
        const count = invocations().length;
        await replace(document, "value: 1\n");
        await pause(250);
        assert.equal(
          invocations().length,
          count,
          "typing must not launch a check",
        );
        assert.deepEqual(
          findings(document.uri),
          before,
          "typing must retain last displayed diagnostics",
        );
        assert.deepEqual(
          editor.actions(
            document,
            new vscode.Range(0, 0, document.lineCount, 0),
          ),
          [],
        );
        const [uri, hash, id, reportId] = saved.arguments!;
        await editor.applyShared(uri, hash, id, reportId);
        assert.equal(document.getText(), "value: 1\n");
      },
    );
    await replace(document, original);
    await editor.check(document, true);
    await editor.check(other, true);
    await pause(300);
    await writeFile(log, "");
    await run(
      "saving A checks only A and preserves B diagnostics and actions",
      async () => {
        const before = findings(other.uri);
        const actions = editor.actions(
          other,
          new vscode.Range(0, 0, other.lineCount, 0),
        );
        await replace(document, "value: 1\n");
        assert.equal(await document.save(), true);
        await waitFor(() => invocations().length > 0, "saved document checked");
        await pause(400);
        assert.deepEqual(
          findings(other.uri),
          before,
          "saving A must preserve B diagnostics",
        );
        assert.deepEqual(
          editor.actions(other, new vscode.Range(0, 0, other.lineCount, 0)),
          actions,
          "saving A must preserve B report and action authority",
        );
        assert.equal(
          invocations().length,
          1,
          `save/watcher echoes must produce one check: ${JSON.stringify(invocations())}`,
        );
        assert.ok(invocations()[0].includes(canonicalFilename));
        assert.ok(!invocations()[0].endsWith(" ."));
        await waitFor(
          () => !findings(document.uri).some((d) => d.code === "jinja-layout"),
          "saved clean expression replaces old Jinja findings",
        );
        const beforeWorkspace = editor.actions(
          other,
          new vscode.Range(0, 0, other.lineCount, 0),
        );
        await editor.checkWorkspace();
        assert.notDeepEqual(
          editor.actions(other, new vscode.Range(0, 0, other.lineCount, 0)),
          beforeWorkspace,
          "manual workspace check must refresh unchanged clean open reports",
        );
      },
    );
    await run(
      "pending and failed save checks retain last displayed diagnostics",
      async () => {
        await replace(document, original);
        await editor.check(document, true);
        const before = findings(document.uri);
        const gate = join(temporary, "pending");
        await writeFile(gate, "");
        process.env.SALTBOX_TEST_PROCESS_GATE = gate;
        try {
          await replace(document, "value: 2\n");
          assert.equal(await document.save(), true);
          await waitFor(
            () => existsSync(gate + ".ready"),
            "real CLI response is held pending",
          );
          assert.deepEqual(
            findings(document.uri),
            before,
            "pending save must retain old findings",
          );
          assert.deepEqual(
            editor.actions(
              document,
              new vscode.Range(0, 0, document.lineCount, 0),
            ),
            [],
          );
          await rm(gate);
          await waitFor(
            () =>
              !findings(document.uri).some((d) => d.code === "jinja-layout"),
            "completed save replaces findings",
          );
        } finally {
          delete process.env.SALTBOX_TEST_PROCESS_GATE;
          await rm(gate, { force: true });
        }
        await replace(document, original);
        await editor.check(document, true);
        const last = findings(document.uri);
        process.env.SALTBOX_TEST_PROCESS_FAIL = "1";
        try {
          await replace(document, "value: 3\n");
          await editor.check(document);
          assert.deepEqual(
            findings(document.uri),
            last,
            "failed recheck retains last known diagnostics",
          );
          assert.deepEqual(
            editor.actions(
              document,
              new vscode.Range(0, 0, document.lineCount, 0),
            ),
            [],
          );
        } finally {
          delete process.env.SALTBOX_TEST_PROCESS_FAIL;
        }
      },
    );
    await run(
      "explicit saves recheck unchanged bytes while watcher echoes do not",
      async () => {
        await replace(document, original);
        await editor.check(document, true);
        assert.ok(
          findings(document.uri).some((d) => d.code === "jinja-layout"),
          "setup fixture must publish Jinja findings",
        );
        await replace(document, "value: 1\n");
        assert.equal(await document.save(), true);
        await waitFor(
          () => !findings(document.uri).some((d) => d.code === "jinja-layout"),
          "initial save must publish clean diagnostics",
        );
        await writeFile(log, "");
        editor.saved(document);
        await waitFor(
          () => invocations().length === 1,
          "explicit save notification forces one check",
        );
        editor.refresh([document.uri]);
        editor.refresh([document.uri]);
        await pause(350);
        assert.equal(
          invocations().length,
          1,
          "watcher echoes must not duplicate explicit save",
        );
      },
    );
    await run(
      "typing after save does not check the newer unsaved buffer",
      async () => {
        await replace(document, original);
        await editor.check(document, true);
        const before = findings(document.uri);
        await writeFile(log, "");
        await replace(document, "value: 1\n");
        assert.equal(await document.save(), true);
        await replace(document, 'value: "{{ newer\n }}"\n');
        await pause(400);
        assert.equal(
          invocations().length,
          0,
          "deferred save must not check newer unsaved text",
        );
        assert.deepEqual(findings(document.uri), before);
        assert.deepEqual(
          editor.actions(
            document,
            new vscode.Range(0, 0, document.lineCount, 0),
          ),
          [],
        );
        await editor.check(document, true);
        assert.equal(
          invocations().length,
          1,
          "explicit manual check may inspect unsaved text",
        );
      },
    );
    await run(
      "closed-file change bursts use selected paths without opening models",
      async () => {
        const first = vscode.Uri.joinPath(roots[0].uri, "closed-one.yml");
        const second = vscode.Uri.joinPath(roots[0].uri, "closed-two.yml");
        await writeFile(log, "");
        await Promise.all(
          [first, second].map((uri) =>
            vscode.workspace.fs.writeFile(
              uri,
              Buffer.from('value: "{{ closed\n }}"\n'),
            ),
          ),
        );
        await waitFor(
          () => findings(first).length > 0 && findings(second).length > 0,
          "closed changed files diagnosed",
        );
        assert.equal(invocations().length, 1, JSON.stringify(invocations()));
        assert.ok(
          invocations()[0].includes("closed-one.yml") &&
            invocations()[0].includes("closed-two.yml"),
        );
        assert.ok(!invocations()[0].endsWith(" ."));
        assert.equal(
          vscode.workspace.textDocuments.some((doc) =>
            [first.toString(), second.toString()].includes(doc.uri.toString()),
          ),
          false,
        );
        const retained = findings(second);
        await vscode.workspace.fs.writeFile(first, Buffer.from("value: 1\n"));
        await waitFor(
          () => findings(first).length === 0,
          "closed fixed file diagnostics replaced",
        );
        assert.deepEqual(findings(second), retained);
        await vscode.workspace.fs.delete(second);
        await waitFor(
          () => findings(second).length === 0,
          "deleted closed file clears diagnostics",
        );
      },
    );
    await run(
      "new file events do not lose an active selected batch",
      async () => {
        const first = vscode.Uri.joinPath(roots[0].uri, "batch-first.yml");
        const second = vscode.Uri.joinPath(roots[0].uri, "batch-second.yml");
        await vscode.workspace.fs.writeFile(
          first,
          Buffer.from('value: "{{ first\n }}"\n'),
        );
        await waitFor(
          () => findings(first).length > 0,
          "first batch fixture diagnosed",
        );
        const gate = join(temporary, "batch");
        await writeFile(gate, "");
        process.env.SALTBOX_TEST_PROCESS_GATE = gate;
        try {
          await vscode.workspace.fs.writeFile(first, Buffer.from("value: 1\n"));
          await waitFor(
            () => existsSync(gate + ".ready"),
            "selected first-file result held",
          );
          await vscode.workspace.fs.writeFile(
            second,
            Buffer.from('value: "{{ second\n }}"\n'),
          );
          delete process.env.SALTBOX_TEST_PROCESS_GATE;
          await rm(gate);
          await waitFor(
            () => findings(first).length === 0 && findings(second).length > 0,
            "both selected batches eventually publish",
          );
        } finally {
          delete process.env.SALTBOX_TEST_PROCESS_GATE;
          await rm(gate, { force: true });
        }
      },
    );
    await run(
      "atomic delete/create save echoes keep displayed diagnostics",
      async () => {
        await replace(document, original);
        assert.equal(await document.save(), true);
        await waitFor(
          () =>
            findings(document.uri).some((d) => d.code === "jinja-layout") &&
            editor.actions(
              document,
              new vscode.Range(0, 0, document.lineCount, 0),
            ).length > 0,
          "atomic-save fixture has current diagnosed snapshot",
        );
        const before = findings(document.uri);
        await vscode.workspace.fs.delete(document.uri);
        await vscode.workspace.fs.writeFile(
          document.uri,
          Buffer.from(original),
        );
        // Replay a delayed delete notification after its replacement exists.
        editor.removeFile(document.uri);
        assert.deepEqual(
          findings(document.uri),
          before,
          "transient delete echo must not hide diagnostics",
        );
        await pause(250);
        assert.deepEqual(findings(document.uri), before);
      },
    );
    await run(
      "late workspace scans cannot restore changed or deleted findings",
      async () => {
        const uri = vscode.Uri.joinPath(roots[0].uri, "late.yml");
        await vscode.workspace.fs.writeFile(
          uri,
          Buffer.from('value: "{{ late\n }}"\n'),
        );
        await waitFor(
          () => findings(uri).length > 0,
          "late-scan fixture diagnosed",
        );
        const gate = join(temporary, "late-scan");
        await writeFile(gate, "");
        process.env.SALTBOX_TEST_PROCESS_GATE = gate;
        const scan = editor.checkWorkspace();
        try {
          await waitFor(
            () => existsSync(gate + ".ready"),
            "old full scan captured before deletion",
          );
          await vscode.workspace.fs.delete(uri);
          await waitFor(
            () => findings(uri).length === 0,
            "deletion clears only deleted source",
          );
          await rm(gate);
          await scan;
          assert.deepEqual(findings(uri), []);
          assert.ok(
            findings(other.uri).length > 0,
            "unaffected diagnostics survive canceled full scan",
          );
        } finally {
          delete process.env.SALTBOX_TEST_PROCESS_GATE;
          await rm(gate, { force: true });
          await scan;
        }
      },
    );
    await run(
      "external mixed-case YAML events refresh only affected diagnostics",
      async () => {
        const upper = vscode.Uri.joinPath(roots[0].uri, "external-event.YML");
        const mixed = vscode.Uri.joinPath(roots[0].uri, "external-event.YaMl");
        const unrelated = findings(other.uri);
        assert.ok(unrelated.length > 0);
        try {
          await writeFile(upper.fsPath, 'value: "{{ external\n }}"\n');
          await waitFor(
            () => findings(upper).some((d) => d.code === "jinja-layout"),
            "external uppercase YAML creation refreshes diagnostics",
          );
          assert.deepEqual(findings(other.uri), unrelated);

          await writeFile(upper.fsPath, "value: 1\n");
          await waitFor(
            () => findings(upper).length === 0,
            "external uppercase YAML change clears diagnostics",
          );
          assert.deepEqual(findings(other.uri), unrelated);

          await writeFile(upper.fsPath, 'value: "{{ external\n }}"\n');
          await waitFor(
            () => findings(upper).some((d) => d.code === "jinja-layout"),
            "external uppercase YAML change restores diagnostics",
          );
          await rename(upper.fsPath, mixed.fsPath);
          await waitFor(
            () =>
              findings(upper).length === 0 &&
              findings(mixed).some((d) => d.code === "jinja-layout"),
            "external mixed-case YAML rename moves diagnostics",
          );
          assert.deepEqual(findings(other.uri), unrelated);

          await rm(mixed.fsPath);
          await waitFor(
            () => findings(mixed).length === 0,
            "external mixed-case YAML deletion clears diagnostics",
          );
          assert.deepEqual(findings(other.uri), unrelated);
        } finally {
          await rm(upper.fsPath, { force: true });
          await rm(mixed.fsPath, { force: true });
        }
      },
    );
    await run(
      "external source roots watch closed siblings and deduplicate overlapping watches",
      async () => {
        const parent = vscode.Uri.joinPath(roots[0].uri, "..");
        const marker = vscode.Uri.joinPath(parent, ".saltbox-lint");
        const sibling = vscode.Uri.joinPath(
          parent,
          "roles/external/defaults/main.yml",
        );
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(parent, "roles/external/defaults"),
        );
        const config = vscode.workspace.getConfiguration(
          "saltboxLint",
          roots[0].uri,
        );
        assert.equal(spawnSync("git", ["init", "-q", parent.fsPath]).status, 0);
        await vscode.workspace.fs.writeFile(marker, new Uint8Array());
        await vscode.workspace.fs.writeFile(
          sibling,
          Buffer.from('value: "{{ sibling\n }}"\n'),
        );
        await config.update(
          "root",
          "..",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        editor.configureRoots();
        try {
          assert.equal(vscode.workspace.getWorkspaceFolder(sibling), undefined);

          await waitFor(
            () => findings(sibling).length > 0,
            "startup diagnoses a closed file outside workspace folders",
          );
          await waitFor(
            () =>
              [document, other].every(
                (doc) =>
                  editor.actions(doc, new vscode.Range(0, 0, doc.lineCount, 0))
                    .length > 0,
              ),
            "startup open-document reports are current before counting file changes",
          );
          await writeFile(log, "");
          await vscode.workspace.fs.writeFile(
            sibling,
            Buffer.from("value: 1\n"),
          );
          await waitFor(
            () => !findings(sibling).some((d) => d.code === "jinja-layout"),
            "external sibling write refreshes its diagnostics",
          );
          assert.equal(invocations().length, 1, JSON.stringify(invocations()));
          assert.ok(
            invocations()[0].includes("roles/external/defaults/main.yml"),
          );
          assert.ok(!invocations()[0].endsWith(" ."));
          await vscode.workspace.fs.writeFile(
            sibling,
            Buffer.from('value: "{{ sibling\n }}"\n'),
          );
          await waitFor(
            () => findings(sibling).some((d) => d.code === "jinja-layout"),
            "external sibling is diagnosed again",
          );
          await vscode.workspace.fs.delete(sibling);
          await waitFor(
            () => findings(sibling).length === 0,
            "external sibling deletion clears diagnostics",
          );
          assert.equal(
            vscode.workspace.textDocuments.some(
              (doc) => doc.uri.toString() === sibling.toString(),
            ),
            false,
          );
          const overlap = vscode.Uri.joinPath(roots[1].uri, "overlap.yml");
          await writeFile(log, "");
          await vscode.workspace.fs.writeFile(
            overlap,
            Buffer.from('value: "{{ overlap\n }}"\n'),
          );
          await waitFor(
            () => findings(overlap).length > 0,
            "known nested marked owner receives its changed-file result",
          );
          await pause(250);
          assert.equal(
            invocations().length,
            1,
            "overlapping source-root watcher echoes must coalesce",
          );
          await vscode.workspace.fs.writeFile(
            sibling,
            Buffer.from('value: "{{ alias\n }}"\n'),
          );
          await waitFor(
            () => findings(sibling).some((d) => d.code === "jinja-layout"),
            "recreated sibling publishes findings before alias ownership",
          );
          const aliasDirectory = vscode.Uri.joinPath(
            roots[0].uri,
            "external-link",
          );
          await symlink(
            vscode.Uri.joinPath(parent, "roles/external").fsPath,
            aliasDirectory.fsPath,
            process.platform === "win32" ? "junction" : "dir",
          );
          const aliasDocument = await vscode.workspace.openTextDocument(
            vscode.Uri.joinPath(aliasDirectory, "defaults/main.yml"),
          );
          await vscode.window.showTextDocument(aliasDocument, {
            preview: false,
          });
          await editor.check(aliasDocument, true);
          await pause(300);
          await writeFile(log, "");
          await replace(aliasDocument, "value: 1\n");
          assert.equal(await aliasDocument.save(), true);
          await waitFor(
            () =>
              !findings(aliasDocument.uri).some(
                (d) => d.code === "jinja-layout",
              ),
            "saved alias receives fresh diagnostics",
          );
          await pause(250);
          assert.equal(
            invocations().length,
            1,
            "canonical watcher and saved alias must share one check: " +
              JSON.stringify(invocations()),
          );
          await vscode.workspace.fs.delete(marker);
          await waitFor(
            () =>
              editor
                .providerDocuments()
                .every(
                  (doc) =>
                    vscode.workspace
                      .getWorkspaceFolder(doc.uri)
                      ?.uri.toString() !== roots[0].uri.toString(),
                ),
            "parent root opt-out is observed",
          );
          await pause(150);
          await writeFile(log, "");
          await vscode.workspace.fs.writeFile(
            sibling,
            Buffer.from('value: "{{ disabled\n }}"\n'),
          );
          await pause(350);
          assert.deepEqual(findings(sibling), []);
          assert.equal(
            invocations().length,
            0,
            "disabled external root must stop watching and checking siblings",
          );
        } finally {
          await config.update(
            "root",
            undefined,
            vscode.ConfigurationTarget.WorkspaceFolder,
          );
          editor.configureRoots();
          await rm(marker.fsPath, { force: true });
          await rm(sibling.fsPath, { force: true });
        }
      },
    );
  } finally {
    subscriptions.forEach((subscription) => subscription.dispose());
    editor.dispose();
    delete process.env.SALTBOX_TEST_PROCESS_LOG;
    await rm(temporary, { recursive: true, force: true });
  }
  assert.deepEqual(failures, []);
}
