import * as vscode from "vscode";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EditorIntegration } from "../../src/editor.ts";
import {
  captureWritableOwnershipPreconditions,
  reportWritableOwnershipFailure,
} from "./writable-ownership-failure.ts";
import {
  FixtureJournal,
  FixtureGateCohort,
  fixtureAbsent,
  fixtureRunning,
} from "./fixture-processes.ts";

export async function checkPendingWritableOwnership(
  executable: string,
  root: vscode.Uri,
) {
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-writable-response-"));
  const fixture = vscode.Uri.joinPath(root, "writable-response-control");
  const original = vscode.Uri.joinPath(fixture, "roles/owner/defaults");
  const template = vscode.Uri.joinPath(fixture, "roles/owner/templates");
  const alias = vscode.Uri.joinPath(fixture, "alias");
  const bytes = Buffer.from('---\nowner_value: "{{ value\n }}"\n');
  const gate = join(temporary, "response");
  const instances = join(temporary, "instances.jsonl");
  const journal = new FixtureJournal(instances);
  const modes = ["canonical", "lint-fixes", "fixAll"] as const;
  let completed = 0;
  const cohort = new FixtureGateCohort(
    instances,
    journal,
    modes.flatMap((mode) => [mode + ":stable", mode + ":retarget"]),
  );
  const keys = [
    "SALTBOX_TEST_REAL_CLI",
    "SALTBOX_TEST_PROCESS_GATE",
    "SALTBOX_TEST_PROCESS_GATE_NONCE",
    "SALTBOX_TEST_PROCESS_INSTANCES",
    "SALTBOX_TEST_PROCESS_GATE_PREFIX",
    "SALTBOX_TEST_PROCESS_GATE_PATHS",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const descriptor = Object.getOwnPropertyDescriptor(
    vscode.workspace,
    "createFileSystemWatcher",
  )!;
  const watch = vscode.workspace.createFileSystemWatcher;
  let delayed = true;
  // Deliver no filesystem callbacks to newly created watchers during this
  // control. Their real registrations resume after it, including registrations
  // made by the installed extension while these documents were opened.
  const intercept: typeof watch = (...args) => {
    const watcher = Reflect.apply(watch, vscode.workspace, args);
    const event =
      (subscribe: vscode.Event<vscode.Uri>): vscode.Event<vscode.Uri> =>
      (listener, receiver, subscriptions) =>
        subscribe(
          (uri) => {
            if (!delayed) Reflect.apply(listener, receiver, [uri]);
          },
          undefined,
          subscriptions,
        );
    return {
      ignoreCreateEvents: watcher.ignoreCreateEvents,
      ignoreChangeEvents: watcher.ignoreChangeEvents,
      ignoreDeleteEvents: watcher.ignoreDeleteEvents,
      onDidCreate: event(watcher.onDidCreate),
      onDidChange: event(watcher.onDidChange),
      onDidDelete: event(watcher.onDidDelete),
      dispose: () => watcher.dispose(),
    };
  };
  Object.defineProperty(vscode.workspace, "createFileSystemWatcher", {
    ...descriptor,
    value: intercept,
  });
  process.env.SALTBOX_TEST_REAL_CLI = executable;
  process.env.SALTBOX_TEST_PROCESS_INSTANCES = instances;
  process.env.SALTBOX_TEST_PROCESS_GATE_PREFIX = "format";
  delete process.env.SALTBOX_TEST_PROCESS_GATE_PATHS;
  const until = async (predicate: () => Promise<boolean>, message: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(message);
  };
  try {
    await vscode.workspace.fs.createDirectory(original);
    await vscode.workspace.fs.createDirectory(template);
    for (const directory of [original, template])
      await writeFile(join(directory.fsPath, "main.yaml"), bytes);
    const canonicalRoot = await realpath(root.fsPath);
    const canonicalSource = await realpath(join(original.fsPath, "main.yaml"));
    for (const mode of modes) {
      for (const retarget of [false, true]) {
        await symlink(original.fsPath, alias.fsPath, "junction");
        const uri = vscode.Uri.joinPath(alias, "main.yaml");
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
        const editor = new EditorIntegration(
          process.env.SALTBOX_TEST_FIXTURE_PATH!,
        );
        const nonce = randomUUID();
        process.env.SALTBOX_TEST_PROCESS_GATE_NONCE = nonce;
        process.env.SALTBOX_TEST_PROCESS_GATE = gate;
        await writeFile(gate, "");
        let settled = false;
        let acceptedReady = false;
        const publicPreconditions =
          mode === "fixAll"
            ? captureWritableOwnershipPreconditions(document, uri, bytes)
            : undefined;
        const pending = (
          mode === "fixAll" ? editor.fixAll(uri) : editor.format(document, mode)
        ).then((result) => {
          settled = true;
          return result;
        });
        try {
          let controlled: ReturnType<FixtureGateCohort["capture"]> | undefined;
          await until(async () => {
            try {
              const ready = JSON.parse(await readFile(gate + ".ready", "utf8"));
              if (ready.nonce !== nonce) return false;
              controlled = cohort.capture(
                mode + (retarget ? ":retarget" : ":stable"),
                ready,
                nonce,
                [
                  "format",
                  "--root",
                  canonicalRoot,
                  "--stdin-filename",
                  canonicalSource,
                  "--mode",
                  mode === "fixAll" ? "lint-fixes" : mode,
                  "-",
                ],
              );
              assert.equal(await fixtureRunning(controlled), true);
              acceptedReady = true;
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return false;
              throw error;
            }
          }, "exact real formatter response reaches its credentialed gate");
          assert.equal(settled, false);
          assert.equal(
            editor.writable(document),
            true,
            "remembered owner is still YAML before callback delivery",
          );
          if (retarget) {
            await rm(alias.fsPath, { recursive: true });
            await symlink(template.fsPath, alias.fsPath, "junction");
            assert.equal(
              editor.writable(document),
              true,
              "withheld callbacks leave the old capability visible",
            );
          }
          await rm(gate);
          const result = await pending;
          assert.ok(controlled);
          await until(
            () => fixtureAbsent(controlled!),
            "the exact controlled formatter has joined",
          );
          if (mode === "fixAll")
            assert.equal(
              document.getText() === bytes.toString("utf8"),
              retarget,
              "stable YAML accepts Fix All; a retargeted template does not",
            );
          else
            assert.equal(
              result!.length > 0,
              !retarget,
              "stable YAML accepts formatting; a retargeted template does not",
            );
          assert.deepEqual(
            await readFile(join(template.fsPath, "main.yaml")),
            bytes,
            "template disk bytes stay unchanged",
          );
          completed++;
        } catch (error) {
          reportWritableOwnershipFailure(error, {
            control: `${mode}:${retarget ? "retarget" : "stable"}`,
            completed,
            settled,
            acceptedReady,
            publicPreconditions,
          });
        } finally {
          await rm(gate, { force: true });
          await pending;
          editor.dispose();
          await vscode.commands.executeCommand(
            "workbench.action.revertAndCloseActiveEditor",
          );
          await rm(alias.fsPath, { recursive: true, force: true });
        }
      }
    }
    cohort.complete();
    console.log(
      "PASS real pending canonical, lint-fixes and Fix All reject identical-byte template retargets before filesystem callbacks; stable YAML remains writable",
    );
  } finally {
    delayed = false;
    Object.defineProperty(
      vscode.workspace,
      "createFileSystemWatcher",
      descriptor,
    );
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await until(async () => {
      const states = await Promise.all(
        journal.processes(journal.observations().length > 0).map(fixtureAbsent),
      );
      return states.every(Boolean);
    }, "all response-gated fixture credentials are absent after joins");
    await rm(fixture.fsPath, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}
