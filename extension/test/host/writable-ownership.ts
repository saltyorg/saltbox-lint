import { hostTemporaryDirectory } from "../support/host-temporary.ts";
import { workspaceFixtureDirectory } from "../support/workspace-fixture.ts";
import { closeEditorTabs } from "../support/editor-tabs.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";
import { runProcess } from "../../src/process.ts";
import { withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import { componentUI } from "../support/component-ui.ts";
import {
  captureWritableOwnershipPreconditions,
  collectWritableOwnershipStages,
  collectWritableProcessFailure,
  reportWritableOwnershipFailure,
} from "./writable-ownership-failure.ts";
import {
  FixtureJournal,
  FixtureGateCohort,
  fixtureAbsent,
  fixtureRunning,
} from "./fixture-processes.ts";
import { reportFixtureFailures } from "./fixture-failure-log.ts";

export async function checkPendingWritableOwnership(
  executable: string,
  root: vscode.Uri,
  parentSignal?: AbortSignal,
) {
  return withTestResources(
    { cleanupTimeoutMs: 5000, operationSignal: parentSignal },
    async (resources) => {
      const temporary = await hostTemporaryDirectory(
        "saltbox-writable-response-",
      );
      resources.defer("writable response temporary files", () =>
        rm(temporary, { recursive: true, force: true }),
      );
      const fixture = vscode.Uri.file(
        await workspaceFixtureDirectory(
          root.fsPath,
          "saltbox-writable-response-control-",
        ),
      );
      const fixtureUris: vscode.Uri[] = [];
      resources.defer("writable response fixture tabs", (signal) =>
        closeEditorTabs(signal, fixtureUris),
      );
      const original = vscode.Uri.joinPath(fixture, "roles/owner/defaults");
      const template = vscode.Uri.joinPath(fixture, "roles/owner/templates");
      const alias = vscode.Uri.joinPath(fixture, "alias");
      const bytes = Buffer.from('---\nowner_value: "{{ value\n }}"\n');
      const instances = join(temporary, "instances.jsonl");
      const journal = new FixtureJournal(instances);
      const modes = ["canonical", "lint-fixes", "fixAll"] as const;
      let completed = 0;
      const cohort = new FixtureGateCohort(
        instances,
        journal,
        modes.flatMap((mode) => [mode + ":stable", mode + ":retarget"]),
      );
      const fixtureEnv: NodeJS.ProcessEnv = {};
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
      fixtureEnv.SALTBOX_TEST_REAL_CLI = executable;
      fixtureEnv.SALTBOX_TEST_PROCESS_INSTANCES = instances;
      fixtureEnv.SALTBOX_TEST_PROCESS_GATE_PREFIX = "format";
      delete fixtureEnv.SALTBOX_TEST_PROCESS_GATE_PATHS;
      const until = async (
        predicate: () => Promise<boolean>,
        message: string,
      ) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.fail(message);
      };
      resources.defer("writable fixture credentials", () =>
        until(async () => {
          const states = await Promise.all(
            journal
              .processes(journal.observations().length > 0)
              .map(fixtureAbsent),
          );
          return states.every(Boolean);
        }, "all response-gated fixture credentials are absent after joins"),
      );
      try {
        await vscode.workspace.fs.createDirectory(original);
        await vscode.workspace.fs.createDirectory(template);
        for (const directory of [original, template])
          await writeFile(join(directory.fsPath, "main.yaml"), bytes);
        const canonicalRoot = await realpath(root.fsPath);
        const canonicalSource = await realpath(
          join(original.fsPath, "main.yaml"),
        );
        for (const mode of modes) {
          for (const retarget of [false, true]) {
            await symlink(original.fsPath, alias.fsPath, "junction");
            const uri = vscode.Uri.joinPath(alias, "main.yaml");
            const document = await vscode.workspace.openTextDocument(uri);
            fixtureUris.push(document.uri);
            await vscode.window.showTextDocument(document, { preview: false });
            const editor = ownJoinedResource(
              resources,
              "writable response adapter",
              new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!, {
                ...componentUI(resources),
                roots: { createFileSystemWatcher: intercept },
                runProcess: (request, signal, observer) =>
                  runProcess({ ...request, env: fixtureEnv }, signal, observer),
              }),
            );
            const nonce = randomUUID();
            // Windows may deny replacement of a prior readiness file. Each
            // credentialed control publishes into its own fresh gate instead.
            const gate = join(temporary, `response-${nonce}`);
            const failures = join(temporary, `failures-${nonce}.jsonl`);
            fixtureEnv.SALTBOX_TEST_PROCESS_FAILURE_LOG = failures;
            fixtureEnv.SALTBOX_TEST_PROCESS_GATE_NONCE = nonce;
            fixtureEnv.SALTBOX_TEST_PROCESS_GATE = gate;
            await writeFile(gate, "");
            let settled = false;
            let acceptedReady = false;
            const stages = collectWritableOwnershipStages();
            const processFailure = collectWritableProcessFailure();
            const publicPreconditions =
              mode === "fixAll"
                ? captureWritableOwnershipPreconditions(document, uri, bytes)
                : undefined;
            const pending = resources.operation(
              "pending writable response",
              () =>
                (mode === "fixAll"
                  ? editor.fixAll(uri, stages.collect, processFailure.collect)
                  : editor.format(
                      document,
                      mode,
                      undefined,
                      stages.collect,
                      processFailure.collect,
                    )
                ).then((result) => {
                  settled = true;
                  return result;
                }),
            );
            let failed = false;
            let primaryFailure: unknown;
            try {
              let controlled:
                ReturnType<FixtureGateCohort["capture"]> | undefined;
              await until(async () => {
                try {
                  const ready = JSON.parse(
                    await readFile(gate + ".ready", "utf8"),
                  );
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
              failed = true;
              primaryFailure = error;
              reportFixtureFailures(failures, undefined, "format");
              reportWritableOwnershipFailure(error, {
                control: `${mode}:${retarget ? "retarget" : "stable"}`,
                completed,
                settled,
                acceptedReady,
                publicPreconditions,
                stages: stages.records,
                processFailure: processFailure.category,
              });
            } finally {
              await withTestResources({ cleanupTimeoutMs: 5000 }, (cleanup) => {
                cleanup.defer("reset writable iteration alias", () =>
                  rm(alias.fsPath, { recursive: true, force: true }),
                );
                cleanup.defer("close writable iteration alias", (signal) =>
                  closeEditorTabs(signal, [document.uri]),
                );
                cleanup.defer(
                  "settle writable iteration response",
                  async () => {
                    await pending;
                  },
                );
                ownJoinedResource(
                  cleanup,
                  "writable iteration adapter",
                  editor,
                );
                cleanup.defer("release writable iteration gate", () =>
                  rm(gate, { force: true }),
                );
                if (failed) throw primaryFailure;
              });
            }
          }
        }
        cohort.complete();
        console.log(
          "PASS real pending canonical, lint-fixes and Fix All reject identical-byte template retargets before filesystem callbacks; stable YAML remains writable",
        );
      } finally {
        delayed = false;
      }
    },
  );
}
