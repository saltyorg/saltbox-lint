import * as vscode from "vscode";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleHelp } from "../../src/help.ts";
import {
  fixtureGateInstance,
  fixtureProcesses,
  fixtureRunning,
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

export async function runHelpConcurrency(document: vscode.TextDocument) {
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  const executable = join(
    product.extensionPath,
    "bin",
    "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
  );
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-help-"));
  const gate = join(temporary, "gate");
  const instances = join(temporary, "instances.jsonl");
  // Observe the installed product's real command and process adapter. Redirect
  // only help children through the lifetime/gate fixture, which runs its exact
  // installed CLI. The product executable, source and other children stay intact.
  const childProcess = createRequire(__filename)(
    "node:child_process",
  ) as typeof import("node:child_process");
  const descriptor = Object.getOwnPropertyDescriptor(childProcess, "spawn")!;
  const originalSpawn = childProcess.spawn;
  const calls: string[][] = [];
  let prefix = "--version";
  const owned = new RuleHelp(executable);
  const pending: Promise<unknown>[] = [];
  try {
    Object.defineProperty(childProcess, "spawn", {
      ...descriptor,
      value: function (
        this: unknown,
        ...args: Parameters<typeof originalSpawn>
      ) {
        const [file, argv, options] = args;
        if (
          file === executable &&
          Array.isArray(argv) &&
          ["--version", "rules"].includes(argv[0])
        ) {
          calls.push([...argv]);
          return originalSpawn(process.env.SALTBOX_TEST_FIXTURE_PATH!, argv, {
            ...options,
            env: {
              ...options?.env,
              SALTBOX_TEST_REAL_CLI: executable,
              SALTBOX_TEST_PROCESS_INSTANCES: instances,
              SALTBOX_TEST_PROCESS_GATE: gate,
              SALTBOX_TEST_PROCESS_GATE_PREFIX: prefix,
            },
          });
        }
        return Reflect.apply(originalSpawn, this, args);
      },
    });
    await writeFile(gate, "held");
    // All twelve calls stay outstanding while the first version observation is
    // held, including calls from both roots of the installed multi-root host.
    for (const root of vscode.workspace.workspaceFolders!) {
      const source = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(root.uri, "roles/example/defaults/main.yml"),
      );
      await vscode.window.showTextDocument(source, { preview: false });
      for (let index = 0; index < 6; index++)
        pending.push(
          Promise.resolve(
            vscode.commands.executeCommand(
              "saltboxLint.explainRule",
              "jinja-layout",
            ),
          ),
        );
    }
    await waitFor(
      () => existsSync(gate + ".ready"),
      "manual version child reaches gate",
    );
    const ready = JSON.parse(readFileSync(gate + ".ready", "utf8"));
    assert.equal(
      await fixtureRunning(fixtureGateInstance(ready, instances)),
      true,
    );
    await vscode.commands.executeCommand("saltboxLint.showStatus");
    await rm(gate);
    const values = await Promise.all(pending);
    assert.ok(values.every((value) => value instanceof vscode.MarkdownString));
    assert.equal(
      calls.filter((args) => args[0] === "--version").length,
      1,
      "twelve overlapping installed manual commands share one version child",
    );
    console.log(
      "PASS installed overlapping help commands share one version child across both roots",
    );

    calls.length = 0;
    prefix = "rules";
    await rm(gate + ".ready");
    await writeFile(gate, "held");
    const first = owned.registry(true);
    pending.push(first.catch(() => undefined));
    await waitFor(
      () => existsSync(gate + ".ready"),
      "registry child reaches gate",
    );
    const held = JSON.parse(readFileSync(gate + ".ready", "utf8"));
    assert.equal(
      await fixtureRunning(fixtureGateInstance(held, instances)),
      true,
    );
    const refreshed = owned.registry(true);
    const outcomes = Promise.allSettled([first, refreshed]);
    pending.push(outcomes);
    owned.dispose();
    assert.ok(
      (await outcomes).every((outcome) => outcome.status === "rejected"),
    );
    await assert.rejects(owned.registry(true), /Canceled/);
    assert.deepEqual(
      calls.map((args) => args[0]),
      ["--version", "rules"],
      "disposal prevents queued and late version children",
    );
    console.log(
      "PASS installed CLI help disposal joins its held registry and prevents queued and late children",
    );
  } finally {
    owned.dispose();
    await rm(gate, { force: true });
    await Promise.allSettled(pending);
    Object.defineProperty(childProcess, "spawn", descriptor);
    try {
      await waitFor(
        async () =>
          (
            await Promise.all(fixtureProcesses(instances).map(fixtureRunning))
          ).every((live) => !live),
        "all observed help child lifetimes terminate",
      );
      console.log(
        `MEASURE help cleanup observed_processes=${fixtureProcesses(instances).length} surviving=0`,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }
}
