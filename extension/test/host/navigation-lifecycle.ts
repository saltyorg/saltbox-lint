import * as vscode from "vscode";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EditorIntegration } from "../../src/editor.ts";
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
): Promise<void> {
  const executable = process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!;
  const canonical = realpathSync.native(executable);
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-navigation-"));
  const gate = join(temporary, "gate"),
    instances = join(temporary, "instances.jsonl");
  const journal = new FixtureJournal(instances);
  const childProcess = createRequire(__filename)(
    "node:child_process",
  ) as typeof import("node:child_process");
  const descriptor = Object.getOwnPropertyDescriptor(childProcess, "spawn")!;
  const spawn = childProcess.spawn;
  const pending: Promise<unknown>[] = [];
  const adapter = new EditorIntegration(executable);
  const tokens: vscode.CancellationTokenSource[] = [];
  const position = document.positionAt(document.getText().indexOf("_port") + 2);
  let nonce = randomUUID();
  try {
    Object.defineProperty(childProcess, "spawn", {
      ...descriptor,
      value: function (this: unknown, ...args: Parameters<typeof spawn>) {
        const [file, argv, options] = args;
        if (
          Array.isArray(argv) &&
          argv[0] === "query" &&
          realpathSync.native(file) === canonical
        ) {
          return spawn(process.env.SALTBOX_TEST_FIXTURE_PATH!, argv, {
            ...options,
            env: {
              ...options?.env,
              SALTBOX_TEST_REAL_CLI: executable,
              SALTBOX_TEST_PROCESS_INSTANCES: instances,
              SALTBOX_TEST_PROCESS_GATE: gate,
              SALTBOX_TEST_PROCESS_GATE_NONCE: nonce,
            },
          });
        }
        return Reflect.apply(spawn, this, args);
      },
    });
    await writeFile(gate, "held");
    const cancellation = new vscode.CancellationTokenSource();
    tokens.push(cancellation);
    const cancelled = adapter.navigation.definition(
      document,
      position,
      cancellation.token,
    );
    pending.push(cancelled);
    await waitFor(
      () => existsSync(gate + ".ready"),
      "actual query CLI completed before cancellation gate",
    );
    const first = JSON.parse(readFileSync(gate + ".ready", "utf8"));
    assert.equal(first.nonce, nonce);
    assert.equal(first.args[0], "query");
    const firstInstance = fixtureGateInstance(first, instances, journal);
    assert.equal(await fixtureRunning(firstInstance), true);
    cancellation.cancel();
    assert.deepEqual(await cancelled, []);
    await waitFor(
      () => fixtureAbsent(firstInstance),
      "cancelled query process is joined",
    );
    await rm(gate + ".ready", { force: true });
    nonce = randomUUID();
    await vscode.window.showTextDocument(document);
    const closed = vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[]
    >("vscode.executeDefinitionProvider", document.uri, position);
    pending.push(Promise.resolve(closed));
    await waitFor(
      () => existsSync(gate + ".ready"),
      "installed definition provider owns query gate",
    );
    const second = JSON.parse(readFileSync(gate + ".ready", "utf8"));
    assert.equal(second.nonce, nonce);
    const secondInstance = fixtureGateInstance(second, instances, journal);
    assert.equal(await fixtureRunning(secondInstance), true);
    await vscode.commands.executeCommand(
      "workbench.action.revertAndCloseActiveEditor",
    );
    assert.deepEqual(await closed, []);
    await waitFor(
      () => fixtureAbsent(secondInstance),
      "document close joins installed provider query",
    );
    const observations = journal.processes(true);
    assert.ok(observations.length >= 2);
    assert.ok(observations.every((instance) => instance.args?.[0] === "query"));
    for (const instance of observations)
      assert.equal(
        await fixtureRunning(instance),
        false,
        "zero surviving navigation query instances",
      );
    console.log(
      "PASS actual packaged CLI navigation cancellation and installed provider document close join every credentialed query process",
    );
  } finally {
    for (const token of tokens) token.cancel();
    adapter.dispose();
    await rm(gate, { force: true });
    await Promise.allSettled(pending);
    Object.defineProperty(childProcess, "spawn", descriptor);
    for (const token of tokens) token.dispose();
    await waitFor(
      async () =>
        (await Promise.all(journal.processes().map(fixtureAbsent))).every(
          Boolean,
        ),
      "all owned query processes exit before fixture cleanup",
    );
    await rm(temporary, { recursive: true, force: true });
  }
}
