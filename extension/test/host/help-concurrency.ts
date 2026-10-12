import { hostTemporaryDirectory } from "../support/host-temporary.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RuleHelp } from "../../src/help.ts";
import { runProcess } from "../../src/process.ts";
import { withTestResources } from "../support/test-resources.ts";
import {
  fixtureGateInstance,
  fixtureProcesses,
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

export async function runHelpConcurrency(
  document: vscode.TextDocument,
  parentSignal?: AbortSignal,
): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    async (resources) => {
      const original = vscode.window.activeTextEditor!;
      assert.equal(original.document, document);
      resources.defer("original help tab", async () => {
        await vscode.window.showTextDocument(document, {
          viewColumn: original.viewColumn,
          preview: false,
        });
      });
      // Public installed commands execute unchanged. Their scheduling is observed
      // through their returned promises; forced overlap belongs to the component.
      const installed: Promise<vscode.MarkdownString>[] = [];
      for (const root of vscode.workspace.workspaceFolders!) {
        const source = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(root.uri, "roles/example/defaults/main.yml"),
        );
        await vscode.window.showTextDocument(source, { preview: false });
        for (let index = 0; index < 6; index++)
          installed.push(
            resources.operation("installed help command", () =>
              vscode.commands.executeCommand<vscode.MarkdownString>(
                "saltboxLint.explainRule",
                "jinja-layout",
              ),
            ),
          );
      }
      assert.ok(
        (await Promise.all(installed)).every(
          (value) => value instanceof vscode.MarkdownString,
        ),
      );
      const temporary = await hostTemporaryDirectory("saltbox-help-");
      resources.defer("help fixture files", () =>
        rm(temporary, { recursive: true, force: true }),
      );
      const executable = process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!;
      const instances = join(temporary, "instances.jsonl");
      const calls: string[][] = [];
      const createHelp = (prefix: string) => {
        const nonce = randomUUID();
        const gate = join(temporary, `gate-${nonce}`);
        const help = new RuleHelp(executable, (request, signal, observer) => {
          calls.push([...request.args]);
          return runProcess(
            {
              ...request,
              executable: process.env.SALTBOX_TEST_FIXTURE_PATH!,
              env: {
                SALTBOX_TEST_REAL_CLI: executable,
                SALTBOX_TEST_PROCESS_INSTANCES: instances,
                SALTBOX_TEST_PROCESS_GATE: gate,
                SALTBOX_TEST_PROCESS_GATE_NONCE: nonce,
                SALTBOX_TEST_PROCESS_GATE_PREFIX: prefix,
              },
            },
            signal,
            observer,
          );
        });
        resources.defer("help component", async () => {
          help.dispose();
          await help.join();
        });
        resources.signal.addEventListener("abort", () => help.dispose(), {
          once: true,
        });
        return { help, gate, nonce };
      };
      const first = createHelp("--version");
      await writeFile(first.gate, "held");
      const overlapping = Array.from({ length: 12 }, () =>
        resources.operation("overlapping registry", () =>
          first.help.registry(),
        ),
      );
      await waitFor(
        () => existsSync(first.gate + ".ready"),
        "shared version child reaches its exact gate",
      );
      const ready = JSON.parse(readFileSync(first.gate + ".ready", "utf8"));
      assert.equal(ready.nonce, first.nonce);
      assert.equal(
        await fixtureRunning(fixtureGateInstance(ready, instances)),
        true,
      );
      await rm(first.gate);
      assert.ok(
        (await Promise.all(overlapping)).every((rules) =>
          rules.some((rule) => rule.id === "jinja-layout"),
        ),
      );
      assert.deepEqual(
        calls.map((args) => args[0]),
        ["--version", "rules"],
        "twelve forced-overlap component calls share one version and registry child",
      );
      calls.length = 0;
      const second = createHelp("rules");
      await writeFile(second.gate, "held");
      const pending = second.help.registry(true);
      const observedPending = pending.catch(() => undefined);
      await waitFor(
        () => existsSync(second.gate + ".ready"),
        "fresh registry child reaches disposal gate",
      );
      const held = JSON.parse(readFileSync(second.gate + ".ready", "utf8"));
      assert.equal(held.nonce, second.nonce);
      assert.equal(
        await fixtureRunning(fixtureGateInstance(held, instances)),
        true,
      );
      const refreshed = second.help.registry(true);
      const outcomes = resources.operation("disposed help outcomes", () =>
        Promise.allSettled([pending, refreshed]),
      );
      second.help.dispose();
      await second.help.join();
      await observedPending;
      assert.ok(
        (await outcomes).every((outcome) => outcome.status === "rejected"),
      );
      await assert.rejects(second.help.registry(true), /Canceled/);
      assert.deepEqual(
        calls.map((args) => args[0]),
        ["--version", "rules"],
        "disposal prevents queued and late component children",
      );
      first.help.dispose();
      await first.help.join();
      await waitFor(
        async () =>
          (
            await Promise.all(fixtureProcesses(instances).map(fixtureAbsent))
          ).every(Boolean),
        "all exact component help instances terminate",
      );
      console.log(
        "PASS twelve unchanged installed help commands and twelve gated native component calls; disposal joins exact component children",
      );
    },
  );
}
