import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorIntegration } from "../../src/editor.ts";
import { MarkedRoots } from "../../src/roots.ts";

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
  return {
    watchers,
    during<T>(operation: () => T): T {
      const descriptor = Object.getOwnPropertyDescriptor(
        vscode.workspace,
        "createFileSystemWatcher",
      )!;
      const original = vscode.workspace.createFileSystemWatcher;
      const replacement: typeof original = (...args) => {
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
      Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
        ...descriptor,
        value: replacement,
      });
      try {
        return operation();
      } finally {
        Object.defineProperty(
          vscode.workspace,
          "createFileSystemWatcher",
          descriptor,
        );
      }
    },
  };
}

export async function checkMarkerEvents(
  extensionPath: string,
  document: vscode.TextDocument,
) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)!;
  const marker = vscode.Uri.joinPath(folder.uri, ".saltbox-lint");
  const config = vscode.workspace.getConfiguration("saltboxLint", folder.uri);
  const previousRoot = config.inspect<string>("root")?.workspaceFolderValue;
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-marker-events-"));
  const aliases = await mkdtemp(join(folder.uri.fsPath, "marker-identity-"));
  const log = join(temporary, "process.log");
  const gate = join(temporary, "format");
  const previousCLI = process.env.SALTBOX_TEST_REAL_CLI;
  const previousLog = process.env.SALTBOX_TEST_PROCESS_LOG;
  const previousGate = process.env.SALTBOX_TEST_PROCESS_GATE;
  let aliasedUri: vscode.Uri | undefined;
  const capture = captureMarkerWatchers();
  process.env.SALTBOX_TEST_REAL_CLI = join(
    extensionPath,
    "bin",
    "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
  );
  process.env.SALTBOX_TEST_PROCESS_LOG = log;
  const editor = capture.during(
    () => new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!),
  );
  const ownsDocument = () => editor.providerDocuments().includes(document);
  try {
    await editor.check(document, true);
    await editor.checkWorkspace();
    assert.ok(ownsDocument(), "initial source ownership is verified");
    const events = capture.watchers.find(
      (watcher) => watcher.source.toString() === folder.uri.toString(),
    )!;
    assert.ok(events);
    const markerBefore = await lstat(marker.fsPath, { bigint: true });
    await writeFile(gate, "");
    process.env.SALTBOX_TEST_PROCESS_GATE = gate;
    let settled = false;
    const pending = editor.format(document, "canonical").then((edits) => {
      settled = true;
      return edits;
    });
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
      delete process.env.SALTBOX_TEST_PROCESS_GATE;
      assert.ok(
        (await pending).length > 0,
        "duplicate events preserve the real formatter result",
      );
      const markerAfter = await lstat(marker.fsPath, { bigint: true });
      assert.equal(markerAfter.ino, markerBefore.ino);
      assert.equal(markerAfter.ctimeNs, markerBefore.ctimeNs);
    } finally {
      delete process.env.SALTBOX_TEST_PROCESS_GATE;
      await rm(gate, { force: true });
      await pending;
    }
    console.log(
      "PASS duplicate marker create/change preserve pending real formatting",
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

    const manualRoots = new MarkedRoots();
    capture.during(() => manualRoots.configure());
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
      capture.during(() => editor.configureRoots());
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
    capture.during(() => editor.configureRoots());
    const aliased = await vscode.workspace.openTextDocument(
      vscode.Uri.file(join(alias, "main.yml")),
    );
    aliasedUri = aliased.uri;
    await vscode.window.showTextDocument(aliased, { preview: false });
    await editor.check(aliased, true);
    assert.ok(editor.providerDocuments().includes(aliased));
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
  } finally {
    editor.dispose();
    const aliasTabs = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === aliasedUri?.toString(),
      ),
    );
    if (aliasTabs.length)
      assert.equal(
        await vscode.window.tabGroups.close(aliasTabs),
        true,
        "auxiliary marker alias tabs close before fixture removal",
      );
    await config.update(
      "root",
      previousRoot,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
    await rm(marker.fsPath, { recursive: true, force: true });
    await writeFile(marker.fsPath, "");
    await rm(marker.fsPath + ".previous", { force: true });
    for (const [key, value] of [
      ["SALTBOX_TEST_REAL_CLI", previousCLI],
      ["SALTBOX_TEST_PROCESS_LOG", previousLog],
      ["SALTBOX_TEST_PROCESS_GATE", previousGate],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    await rm(temporary, { recursive: true, force: true });
    // Native watcher/child handles may outlive synchronous disposal on Windows.
    await rm(aliases, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
