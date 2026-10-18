import { hostTemporaryDirectory } from "../support/host-temporary.ts";
import { workspaceFixtureDirectory } from "../support/workspace-fixture.ts";
import { closeEditorTabs } from "../support/editor-tabs.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  rename,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";
import { runProcess } from "../../src/process.ts";
import { MarkedRoots } from "../../src/roots.ts";
import { withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { componentUI } from "../support/component-ui.ts";

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(predicate(), message);
}

interface MarkerEvents {
  source: vscode.Uri;
  create(): void;
  change(): void;
  delete(): void;
  lateDelete(): () => void;
}

// Control only marker event delivery. Filesystem queries, canonical identities,
// source watchers and CLI work remain real. Capture a callback separately to
// model an event already queued when its watcher is disposed.
function captureMarkerWatchers() {
  const watchers: MarkerEvents[] = [];
  const original = vscode.workspace.createFileSystemWatcher;
  const createFileSystemWatcher: typeof original = (...args) => {
    const watcher = Reflect.apply(original, vscode.workspace, args);
    const pattern = args[0];
    if (
      !(pattern instanceof vscode.RelativePattern) ||
      pattern.pattern !== ".saltbox-lint"
    )
      return watcher;
    const uri = vscode.Uri.joinPath(pattern.baseUri, ".saltbox-lint");
    const created = new vscode.EventEmitter<vscode.Uri>();
    const changed = new vscode.EventEmitter<vscode.Uri>();
    const deleted = new vscode.EventEmitter<vscode.Uri>();
    const deleteCallbacks: Array<(uri: vscode.Uri) => unknown> = [];
    watchers.push({
      source: pattern.baseUri,
      create: () => created.fire(uri),
      change: () => changed.fire(uri),
      delete: () => deleted.fire(uri),
      lateDelete: () => {
        const pending = [...deleteCallbacks];
        return () => pending.forEach((callback) => callback(uri));
      },
    });
    return {
      ignoreCreateEvents: watcher.ignoreCreateEvents,
      ignoreChangeEvents: watcher.ignoreChangeEvents,
      ignoreDeleteEvents: watcher.ignoreDeleteEvents,
      onDidCreate: created.event,
      onDidChange: changed.event,
      onDidDelete: (listener, receiver, subscriptions) => {
        deleteCallbacks.push((event) =>
          Reflect.apply(listener, receiver, [event]),
        );
        return deleted.event(listener, receiver, subscriptions);
      },
      dispose() {
        watcher.dispose();
        created.dispose();
        changed.dispose();
        deleted.dispose();
        deleteCallbacks.length = 0;
      },
    } satisfies vscode.FileSystemWatcher;
  };
  return { watchers, createFileSystemWatcher };
}

export async function checkMarkerEvents(
  extensionPath: string,
  document: vscode.TextDocument,
  parentSignal?: AbortSignal,
) {
  return withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: parentSignal },
    async (resources) => {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)!;
      const marker = vscode.Uri.joinPath(folder.uri, ".saltbox-lint");
      const config = vscode.workspace.getConfiguration(
        "saltboxLint",
        folder.uri,
      );
      const previousRoot = config.inspect<string>("root")?.workspaceFolderValue;
      const temporary = await hostTemporaryDirectory("saltbox-marker-events-");
      resources.defer("marker event temporary files", () =>
        rm(temporary, { recursive: true, force: true }),
      );
      const aliases = await workspaceFixtureDirectory(
        folder.uri.fsPath,
        "saltbox-marker-identity-",
      );
      const markerBytes = await readFile(marker.fsPath);
      resources.defer("restore marker and root", async () => {
        await config.update(
          "root",
          previousRoot,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        await rm(marker.fsPath, { recursive: true, force: true });
        await writeFile(marker.fsPath, markerBytes);
        await rm(marker.fsPath + ".previous", { force: true });
      });
      const log = join(temporary, "process.log");
      const gate = join(temporary, "format");
      const fixtureEnv: NodeJS.ProcessEnv = {};
      let aliasedUri: vscode.Uri | undefined;
      const capture = captureMarkerWatchers();
      fixtureEnv.SALTBOX_TEST_REAL_CLI = join(
        extensionPath,
        "bin",
        "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
      );
      fixtureEnv.SALTBOX_TEST_PROCESS_LOG = log;
      resources.defer("close marker alias tabs", (signal) =>
        closeEditorTabs(signal, aliasedUri ? [aliasedUri] : []),
      );
      const editor = ownJoinedResource(
        resources,
        "marker event adapter",
        new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!, {
          ...componentUI(resources),
          roots: { createFileSystemWatcher: capture.createFileSystemWatcher },
          runProcess: (request, signal, observer) =>
            runProcess({ ...request, env: fixtureEnv }, signal, observer),
        }),
      );
      const ownsDocument = () => editor.providerDocuments().includes(document);
      await editor.check(document, true);
      await editor.checkWorkspace();
      assert.ok(ownsDocument(), "initial source ownership is verified");
      const events = capture.watchers.find(
        (watcher) => watcher.source.toString() === folder.uri.toString(),
      )!;
      assert.ok(events);
      const markerBefore = await lstat(marker.fsPath, { bigint: true });
      await writeFile(gate, "");
      fixtureEnv.SALTBOX_TEST_PROCESS_GATE = gate;
      let settled = false;
      const pending = resources.operation(
        "marker event pending formatter",
        () =>
          editor.format(document, "canonical").then((edits) => {
            settled = true;
            return edits;
          }),
      );
      try {
        await waitFor(
          () =>
            existsSync(gate + ".ready") &&
            existsSync(log) &&
            readFileSync(log, "utf8")
              .split("\n")
              .some((line) => line.split(" ")[1] === "format"),
          "real formatter response reaches the fixture gate",
        );
        events.create();
        events.change();
        events.delete();
        assert.ok(
          ownsDocument(),
          "identical notifications preserve verified ownership synchronously",
        );
        assert.equal(
          settled,
          false,
          "formatter remains pending at its response gate",
        );
        await rm(gate);
        delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE;
        assert.ok(
          (await pending).length > 0,
          "duplicate events preserve the real formatter result",
        );
        const markerAfter = await lstat(marker.fsPath, { bigint: true });
        assert.equal(markerAfter.ino, markerBefore.ino);
        assert.equal(markerAfter.ctimeNs, markerBefore.ctimeNs);
      } finally {
        delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE;
        await rm(gate, { force: true });
        await pending;
      }
      console.log(
        "PASS duplicate marker create/change/delete preserve pending real formatting",
      );

      const removedMarker = marker.fsPath + ".deleted";
      resources.defer("remove deleted marker backup", () =>
        rm(removedMarker, { force: true }),
      );
      const beforeDeletion = await lstat(marker.fsPath, { bigint: true });
      await rename(marker.fsPath, removedMarker);
      await writeFile(marker.fsPath, markerBytes);
      assert.notEqual(
        (await lstat(marker.fsPath, { bigint: true })).ino,
        beforeDeletion.ino,
      );
      events.delete();
      assert.equal(
        ownsDocument(),
        false,
        "delete revokes immediately even if the marker already exists again",
      );
      await editor.check(document, true);
      assert.ok(ownsDocument());

      const prior = await lstat(marker.fsPath, { bigint: true });
      await rename(marker.fsPath, marker.fsPath + ".previous");
      await writeFile(marker.fsPath, "");
      assert.notEqual(
        (await lstat(marker.fsPath, { bigint: true })).ino,
        prior.ino,
      );
      events.change();
      assert.equal(
        ownsDocument(),
        false,
        "same-path regular replacement revokes synchronously",
      );
      await editor.check(document, true);
      assert.ok(ownsDocument());

      await rm(marker.fsPath);
      events.change();
      assert.equal(
        ownsDocument(),
        false,
        "missing marker revokes synchronously on change",
      );
      await editor.check(document, true);
      assert.equal(
        ownsDocument(),
        false,
        "missing marker cannot recover eligibility",
      );
      await writeFile(marker.fsPath, "");
      events.create();
      await editor.check(document, true);
      assert.ok(ownsDocument());

      await rm(marker.fsPath);
      await mkdir(marker.fsPath);
      events.change();
      assert.equal(
        ownsDocument(),
        false,
        "nonregular marker revokes synchronously",
      );
      await editor.check(document, true);
      assert.equal(
        ownsDocument(),
        false,
        "nonregular marker cannot recover eligibility",
      );
      await rm(marker.fsPath, { recursive: true });
      await writeFile(marker.fsPath, "");
      events.create();
      await editor.check(document, true);
      assert.ok(ownsDocument());
      console.log(
        "PASS marker deletion, replacement, missing and nonregular states revoke immediately",
      );

      const manualRoots = new MarkedRoots(undefined, {
        createFileSystemWatcher: capture.createFileSystemWatcher,
      });
      manualRoots.configure();
      try {
        await manualRoots.ready();
        const key = folder.uri.toString();
        const canonical = manualRoots.get(key);
        assert.ok(canonical);
        let changes = 0;
        const listener = manualRoots.onDidChange((changed) => {
          if (changed === key) changes++;
        });
        try {
          await rename(marker.fsPath, marker.fsPath + ".manual-previous");
          await writeFile(marker.fsPath, "");
          await manualRoots.refresh(key);
          assert.equal(manualRoots.get(key), canonical);
          assert.equal(
            changes,
            1,
            "manual refresh must publish changed marker identity even at the same root",
          );
        } finally {
          listener.dispose();
        }
      } finally {
        manualRoots.dispose();
        await rm(marker.fsPath + ".manual-previous", { force: true });
      }
      await editor.check(document, true);
      assert.ok(ownsDocument());
      console.log(
        "PASS manual marker refresh does not hide a replacement identity",
      );

      const staleDelete = events.lateDelete();
      const nestedMarker = vscode.Uri.joinPath(
        folder.uri,
        "roles/example/.saltbox-lint",
      );
      await vscode.workspace.fs.writeFile(nestedMarker, new Uint8Array());
      try {
        await config.update(
          "root",
          "roles/example",
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
        editor.configureRoots();
        await editor.check(document, true);
        assert.ok(
          ownsDocument(),
          "replacement root has verified source ownership",
        );
        staleDelete();
        assert.ok(
          ownsDocument(),
          "disposed root callback cannot revoke its replacement owner's source",
        );
      } finally {
        await vscode.workspace.fs.delete(nestedMarker);
      }
      console.log(
        "PASS stale marker watcher cannot invalidate its replacement root",
      );

      const first = join(aliases, "first");
      const second = join(aliases, "second");
      const alias = join(aliases, "source");
      try {
        await mkdir(first);
        await mkdir(second);
        await writeFile(join(first, ".saltbox-lint"), "");
        await link(join(first, ".saltbox-lint"), join(second, ".saltbox-lint"));
        await writeFile(join(first, "main.yml"), document.getText());
        await writeFile(join(second, "main.yml"), document.getText());
        await symlink(
          first,
          alias,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if (
          !["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        console.log(`SKIP canonical marker alias control: ${String(error)}`);
        return;
      }
      await config.update(
        "root",
        alias,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      editor.configureRoots();
      const opened = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(alias, "main.yml")),
      );
      // Root identity is the subject of this control. Establish the provider's
      // language precondition through a real close/open transition first.
      const plaintext = await vscode.languages.setTextDocumentLanguage(
        opened,
        "plaintext",
      );
      await editor.check(plaintext, true);
      assert.equal(editor.providerDocuments().includes(plaintext), false);
      const displayed = await vscode.window.showTextDocument(plaintext, {
        preview: false,
      });
      const aliased = await vscode.languages.setTextDocumentLanguage(
        displayed.document,
        "yaml",
      );
      aliasedUri = aliased.uri;
      assert.equal(aliased.languageId, "yaml");
      assert.equal(aliased.isClosed, false);
      assert.ok(vscode.workspace.textDocuments.includes(aliased));
      assert.equal(aliased.uri.toString(), opened.uri.toString());
      const canonicalRoot = await realpath(first);
      const canonicalSource = await realpath(aliased.uri.fsPath);
      assert.equal(await realpath(alias), canonicalRoot);
      assert.equal(canonicalSource, join(canonicalRoot, "main.yml"));
      assert.equal(
        vscode.workspace.getWorkspaceFolder(aliased.uri)?.uri.toString(),
        folder.uri.toString(),
      );
      assert.ok((await lstat(join(alias, ".saltbox-lint"))).isFile());
      await editor.check(aliased, true);
      assert.ok(
        editor.providerDocuments().includes(aliased),
        "alias source ownership is verified synchronously: " +
          JSON.stringify({
            uri: aliased.uri.toString(),
            language: aliased.languageId,
            closed: aliased.isClosed,
            current: vscode.workspace.textDocuments.includes(aliased),
            canonicalRoot,
            canonicalSource,
            root: vscode.workspace
              .getConfiguration("saltboxLint", folder.uri)
              .get<string>("root"),
          }),
      );
      const aliasEvents = capture.watchers.findLast(
        (watcher) => watcher.source.fsPath === alias,
      )!;
      assert.ok(aliasEvents);
      const beforeRetarget = await lstat(join(alias, ".saltbox-lint"), {
        bigint: true,
      });
      await rm(alias, { recursive: true });
      await symlink(
        second,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const afterRetarget = await lstat(join(alias, ".saltbox-lint"), {
        bigint: true,
      });
      assert.equal(afterRetarget.ino, beforeRetarget.ino);
      assert.equal(afterRetarget.ctimeNs, beforeRetarget.ctimeNs);
      aliasEvents.change();
      assert.equal(
        editor.providerDocuments().includes(aliased),
        false,
        "canonical target change revokes even with the identical hardlinked marker",
      );
      console.log(
        "PASS canonical target change revokes despite identical marker metadata",
      );
    },
  );
}
