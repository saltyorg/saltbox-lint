import { hostTemporaryDirectory } from "../support/host-temporary.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EditorIntegration } from "../../src/editor.ts";
import { hash, SnapshotIndex } from "../../src/protocol.ts";
import { runProcess } from "../../src/process.ts";
import { withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
import {
  FixtureJournal,
  fixtureGateInstance,
  fixtureRunning,
  fixtureAbsent,
} from "./fixture-processes.ts";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 15000;
  while (!(await predicate()) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(await predicate(), message);
}

export async function runNavigationLifecycle(
  document: vscode.TextDocument,
  parentSignal?: AbortSignal,
): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    async (resources) => {
      const executable = process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!;
      const temporary = await hostTemporaryDirectory("saltbox-navigation-");
      resources.defer("navigation files", () =>
        rm(temporary, { recursive: true, force: true }),
      );
      const instances = join(temporary, "instances.jsonl");
      const journal = new FixtureJournal(instances);
      let nonce = randomUUID();
      let gate = join(temporary, `gate-${nonce}`);
      const root = realpathSync.native(
        vscode.workspace.getWorkspaceFolder(document.uri)!.uri.fsPath,
      );
      const position = document.positionAt(
        document.getText().indexOf("_port") + 2,
      );
      const argvExpected = [
        "query",
        "--root",
        root,
        "--stdin-filename",
        realpathSync.native(document.uri.fsPath),
        "--operation",
        "definition",
        "--offset",
        String(new SnapshotIndex(document.getText()).byteOffset(position)),
        "-",
      ];
      const adapter = new EditorIntegration(executable, {
        runProcess: (request, signal, observeFailure) => {
          if (request.args[0] !== "query")
            return runProcess(request, signal, observeFailure);
          assert.deepEqual(
            request.args,
            argvExpected,
            "only this adapter's exact query owns the fixture gate",
          );
          return runProcess(
            {
              ...request,
              executable: process.env.SALTBOX_TEST_FIXTURE_PATH!,
              env: {
                SALTBOX_TEST_REAL_CLI: executable,
                SALTBOX_TEST_PROCESS_INSTANCES: instances,
                SALTBOX_TEST_PROCESS_GATE: gate,
                SALTBOX_TEST_PROCESS_GATE_NONCE: nonce,
              },
            },
            signal,
            observeFailure,
          );
        },
      });
      ownJoinedResource(resources, "navigation adapter", adapter);
      await adapter.ready();
      await adapter.check(document);
      const version = document.version,
        sourceHash = hash(document.getText());
      assert.equal(adapter.status(document).state, "current");
      const ownCancellation = () => {
        const token = new vscode.CancellationTokenSource();
        const cancel = () => token.cancel();
        resources.signal.addEventListener("abort", cancel, { once: true });
        resources.defer("navigation cancellation token", () => {
          resources.signal.removeEventListener("abort", cancel);
          token.cancel();
          token.dispose();
        });
        return token;
      };
      const cancellation = ownCancellation();
      await writeFile(gate, "held");
      const cancelled = resources.operation("cancelled query", () =>
        adapter.navigation.definition(document, position, cancellation.token),
      );
      await waitFor(
        () => existsSync(gate + ".ready"),
        "component query completed real CLI work before cancellation gate",
      );
      const first = JSON.parse(readFileSync(gate + ".ready", "utf8"));
      assert.equal(first.nonce, nonce);
      assert.deepEqual(first.args, argvExpected);
      const firstInstance = fixtureGateInstance(first, instances, journal);
      assert.equal(await fixtureRunning(firstInstance), true);
      cancellation.cancel();
      assert.deepEqual(await cancelled, []);
      await waitFor(
        () => fixtureAbsent(firstInstance),
        "cancelled component query is joined",
      );
      assert.equal(document.version, version);
      assert.equal(hash(document.getText()), sourceHash);
      nonce = randomUUID();
      gate = join(temporary, `gate-${nonce}`);
      await writeFile(gate, "held");
      await vscode.window.showTextDocument(document);
      const closeToken = ownCancellation();
      const closed = resources.operation("closed query", () =>
        adapter.navigation.definition(document, position, closeToken.token),
      );
      await waitFor(
        () => existsSync(gate + ".ready"),
        "component query reached its fresh close gate",
      );
      const second = JSON.parse(readFileSync(gate + ".ready", "utf8"));
      assert.equal(second.nonce, nonce);
      assert.deepEqual(second.args, argvExpected);
      const secondInstance = fixtureGateInstance(second, instances, journal);
      assert.equal(await fixtureRunning(secondInstance), true);
      // The installed provider executes unchanged. Its query can complete before
      // this public close, so its already accepted locations remain valid results.
      const installed = resources.operation(
        "installed provider close flow",
        () =>
          vscode.commands.executeCommand<
            (vscode.Location | vscode.LocationLink)[]
          >("vscode.executeDefinitionProvider", document.uri, position),
      );
      let observedClose = false;
      const listener = vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (
          event.closed.some(
            (tab) =>
              tab.input instanceof vscode.TabInputText &&
              tab.input.uri.toString() === document.uri.toString(),
          )
        ) {
          observedClose = true;
          adapter.close(document);
        }
      });
      resources.defer("navigation tab close listener", () =>
        listener.dispose(),
      );
      await vscode.commands.executeCommand(
        "workbench.action.revertAndCloseActiveEditor",
      );
      await waitFor(
        () => observedClose,
        "the actual document tab close was observed",
      );
      assert.deepEqual(await closed, []);
      assert.ok(
        Array.isArray(await installed),
        "the installed provider settles its real close flow",
      );
      await waitFor(
        () => fixtureAbsent(secondInstance),
        "document close joins its owned component query",
      );
      assert.equal(hash(document.getText()), sourceHash);
      adapter.dispose();
      await adapter.join();
      const observations = journal.processes(true);
      assert.equal(observations.length, 2);
      for (const instance of observations)
        assert.equal(
          await fixtureRunning(instance),
          false,
          "zero surviving owned navigation query instances",
        );
      console.log(
        "PASS native component query cancellation and real document close join exact credentialed children; installed providers execute unchanged",
      );
    },
  );
}
