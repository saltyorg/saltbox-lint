import assert from "node:assert/strict";
import * as vscode from "vscode";
import { createRequire } from "node:module";
import type { ChildProcess, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { hash } from "../../src/protocol.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import {
  quantile,
  primaryRequests,
  validateLiveCheckRecord,
  type LiveCheckRecord,
  type LiveFixture,
} from "./live-check-record.ts";

import {
  createLiveControlEvidence,
  noteLiveOperation,
  noteLiveControlStage,
  reportLiveControlFailure,
  captureLiveInvocationFailure,
  captureLivePendingInvocations,
  type LiveControlEvidence,
} from "./live-control-evidence.ts";
import type {
  LiveOperationName,
  LiveControlName,
} from "./live-control-vocabulary.ts";

const deadlineMs = 15000;
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function observed(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  while (!predicate() && performance.now() < deadline) await pause(10);
  assert.ok(predicate(), message);
}
async function bounded<T>(
  operation: PromiseLike<T>,
  name: LiveOperationName,
  evidence: LiveControlEvidence | undefined,
): Promise<T> {
  noteLiveOperation(evidence, name, "entered");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          noteLiveOperation(evidence, name, "deadline");
          reject(new Error("Live checking control deadline"));
        }, deadlineMs);
      }),
    ]);
    noteLiveOperation(evidence, name, "completed");
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function replace(
  document: vscode.TextDocument,
  text: string,
  name: LiveOperationName,
  evidence: LiveControlEvidence | undefined,
) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    ),
    text,
  );
  assert.equal(
    await bounded(vscode.workspace.applyEdit(edit), name, evidence),
    true,
  );
}
function expected(document: vscode.TextDocument, line: number): boolean {
  return vscode.languages
    .getDiagnostics(document.uri)
    .some(
      (finding) =>
        finding.source === "saltbox-lint" &&
        diagnosticCode(finding) === "jinja-layout" &&
        finding.range.start.line === line + 1,
    );
}
function source(line: number): string {
  return "# 😀é\r\n".repeat(line) + 'value: "😀 {{ value\r\n }}"\r\n';
}
async function diskSources(root: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  async function visit(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if ([".git", ".vscode", ".saltbox-lint"].includes(item.name)) continue;
      const filename = join(directory, item.name);
      if (item.isDirectory()) await visit(filename);
      else if (item.isFile())
        sources.set(filename, hash(await readFile(filename)));
    }
  }
  await visit(root);
  return sources;
}
interface Invocation {
  primary?: string;
  started: number;
  closed?: number;
  cancelled?: boolean;
}

// Runs last in normal mode. Only the installed extension receives edit/config
// events. The host wraps the shared Node spawn function without changing any
// arguments, environment, pipes, return value or signal behavior.
export async function runLiveChecking(): Promise<void> {
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  assert.ok(product.isActive);
  // Match the controller's context.asAbsolutePath basis. On Windows,
  // extensionPath can retain a different drive spelling than extensionUri.fsPath.
  const executable = join(
    product.extensionUri.fsPath,
    "bin",
    "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
  );
  assert.equal(
    realpathSync.native(executable),
    realpathSync.native(process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!),
  );
  const runtimeRequire = createRequire(__filename);
  const runtimeModule =
    runtimeRequire.cache[
      runtimeRequire.resolve(
        join(product.extensionUri.fsPath, "dist", "extension.js"),
      )
    ];
  assert.ok(runtimeModule, "installed extension runtime is already cached");
  assert.equal(
    runtimeModule.loaded,
    true,
    "installed extension runtime is loaded",
  );
  const runtime = runtimeModule.exports as { deactivate(): Promise<void> };
  assert.equal(
    typeof runtime.deactivate,
    "function",
    "installed extension runtime exposes deactivation",
  );
  const root = vscode.workspace.workspaceFolders![0].uri;
  const configuration = vscode.workspace.getConfiguration("saltboxLint", root);
  assert.equal(configuration.get("checkOnType", false), false);
  const smallURI = vscode.Uri.joinPath(root, "live-small.yml");
  const heavyURI = vscode.Uri.joinPath(
    root,
    "roles/livecontext/tasks/main.yml",
  );
  const contextURI = vscode.Uri.joinPath(
    root,
    "roles/livecontext/defaults/main.yml",
  );
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(root, "roles/livecontext/tasks"),
  );
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(root, "roles/livecontext/defaults"),
  );
  const context = Array.from(
    { length: 4000 },
    (_, index) => `livecontext_role_value_${index}: ${index}\n`,
  ).join("");
  await vscode.workspace.fs.writeFile(contextURI, Buffer.from(context));
  for (const uri of [smallURI, heavyURI])
    await vscode.workspace.fs.writeFile(uri, Buffer.from(source(1)));
  const small = await vscode.workspace.openTextDocument(smallURI);
  const heavy = await vscode.workspace.openTextDocument(heavyURI);
  const primaryFilenames = new Map([
    [small, realpathSync.native(small.uri.fsPath)],
    [heavy, realpathSync.native(heavy.uri.fsPath)],
  ]);
  await vscode.window.showTextDocument(heavy, { preview: false });
  await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
  for (const document of [small, heavy]) {
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("saltboxLint.checkDocument");
    await observed(
      () => expected(document, 1),
      "baseline expected diagnostics",
    );
  }
  const childProcesses = createRequire(__filename)("node:child_process") as {
    spawn: typeof spawn;
  };
  const descriptor = Object.getOwnPropertyDescriptor(childProcesses, "spawn")!;
  const original = childProcesses.spawn;
  const invocations: Invocation[] = [];
  let overflow = false;
  let launchControl: ((invocation: Invocation) => void) | undefined;
  const wrapped = (...args: Parameters<typeof spawn>): ChildProcess => {
    const child = Reflect.apply(original, childProcesses, args) as ChildProcess;
    const started = performance.now();
    if (args[0] === executable) {
      if (invocations.length >= 256) overflow = true;
      else {
        const argv = args[1] ?? [];
        const position = argv.indexOf("--stdin-filename");
        const invocation: Invocation = {
          started,
          primary: position < 0 ? undefined : argv[position + 1],
        };
        invocations.push(invocation);
        child.once("close", (_code, signal) => {
          invocation.cancelled =
            child.killed || signal === "SIGKILL" || signal === "SIGTERM";
          invocation.closed = performance.now();
        });
        const control = launchControl;
        if (control && invocation.primary === primaryFilenames.get(heavy)) {
          launchControl = undefined;
          child.once("spawn", () => control(invocation));
        }
      }
    }
    return child;
  };
  Object.defineProperty(childProcesses, "spawn", {
    ...descriptor,
    value: wrapped,
  });
  const checkpoints: {
    name: string;
    launches: number;
    closes: number;
    active: number;
  }[] = [];
  const checkpoint = async (name: string) => {
    await observed(
      () => invocations.every((item) => item.closed !== undefined),
      `${name} native CLI close join`,
    );
    checkpoints.push({
      name,
      launches: invocations.length,
      closes: invocations.filter((item) => item.closed !== undefined).length,
      active: invocations.filter((item) => item.closed === undefined).length,
    });
    assert.equal(overflow, false, "live invocation evidence bound");
  };
  const primaryCalls = (document: vscode.TextDocument) =>
    primaryRequests(invocations, primaryFilenames.get(document)!);
  let changed = 0;
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length && [small, heavy].includes(event.document))
      changed = performance.now();
  });
  const evidence = createLiveControlEvidence();
  const controlledInvocations = new Map<LiveControlName, Invocation>();
  const fixtureRecords: LiveFixture[] = [];
  let bufferUnchanged = true;
  let finalRecord: LiveCheckRecord | undefined;
  let failed = false;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await pause(650);
    await checkpoint("baseline");
    // A bounded observation window proves absence while typing is disabled.
    const offBefore = invocations.length;
    for (let index = 2; index <= 6; index++)
      await replace(small, source(index), "default-off-edit", evidence);
    await pause(650);
    assert.equal(
      invocations.length - offBefore,
      0,
      "default-off typing launches",
    );
    const saveBefore = primaryCalls(small).length;
    assert.equal(
      await bounded(small.save(), "default-off-save", evidence),
      true,
    );
    await observed(
      () => expected(small, 6),
      "default-off save publishes current findings",
    );
    await checkpoint("default-off-save");
    assert.equal(
      primaryCalls(small).length - saveBefore,
      1,
      "default-off one primary save check",
    );
    const diskBefore = await diskSources(root.fsPath);
    await bounded(
      configuration.update(
        "checkOnType",
        true,
        vscode.ConfigurationTarget.WorkspaceFolder,
      ),
      "enable-setting",
      evidence,
    );
    await observed(
      () =>
        vscode.workspace
          .getConfiguration("saltboxLint", root)
          .get("checkOnType", false),
      "setting enables installed typing path",
    );
    for (const [kind, document, contextBytes] of [
      ["small", small, 0],
      ["context-heavy", heavy, Buffer.byteLength(context)],
    ] as const) {
      const samples: { requestLatencyMs: number; acceptedLatencyMs: number }[] =
        [];
      for (let sample = 0; sample < 20; sample++) {
        const line = 10 + sample;
        const text = source(line);
        const before = primaryCalls(document).length;
        await replace(
          document,
          text,
          kind === "small" ? "small-sample-edit" : "context-heavy-sample-edit",
          evidence,
        );
        const started = changed;
        await observed(
          () => primaryCalls(document).length > before,
          "debounced packaged check launches",
        );
        const request = primaryCalls(document)[before];
        await observed(
          () => expected(document, line),
          "latest Unicode/CRLF diagnostic accepted",
        );
        samples.push({
          requestLatencyMs: request.started - started,
          acceptedLatencyMs: performance.now() - started,
        });
        assert.equal(
          document.getText(),
          text,
          "typing checks preserve current buffer",
        );
        bufferUnchanged &&= document.getText() === text;
        await observed(
          () => request.closed !== undefined,
          "sample packaged CLI joined",
        );
        assert.equal(
          primaryCalls(document).length - before,
          1,
          "one check per paused burst",
        );
      }
      fixtureRecords.push({
        kind,
        primaryBytes: Buffer.byteLength(document.getText()),
        contextBytes,
        samples,
        requestMedianMs: quantile(
          samples.map((sample) => sample.requestLatencyMs),
          0.5,
        ),
        requestP95Ms: quantile(
          samples.map((sample) => sample.requestLatencyMs),
          0.95,
        ),
        acceptedMedianMs: quantile(
          samples.map((sample) => sample.acceptedLatencyMs),
          0.5,
        ),
        acceptedP95Ms: quantile(
          samples.map((sample) => sample.acceptedLatencyMs),
          0.95,
        ),
      });
    }
    await checkpoint("idle");
    const sustainedBefore = primaryCalls(small).length;
    const sustainedStart = performance.now();
    for (let edit = 0; edit < 20; edit++) {
      await replace(small, source(40 + edit), "sustained-edit", evidence);
      // This cadence is workload input, never a completion assertion.
      await pause(25);
    }
    assert.equal(
      primaryCalls(small).length - sustainedBefore,
      0,
      "sustained edits do not launch before a typing pause",
    );
    await observed(
      () => expected(small, 59),
      "sustained typing accepts its latest snapshot",
    );
    await checkpoint("sustained");
    const elapsedMs = performance.now() - sustainedStart;
    const launches = primaryCalls(small).length - sustainedBefore;
    assert.equal(
      launches,
      1,
      "sustained typing coalesces to one latest request",
    );
    const sustained = {
      edits: 20,
      elapsedMs,
      launches,
      launchesPerSecond: (launches * 1000) / elapsedMs,
    };

    // A bounded larger snapshot leaves time for real editor control roundtrips.
    // Cancellation controls begin at the observed native process spawn event.
    const slow =
      Array.from(
        { length: 40000 },
        (_, index) => `entry_${index}: [1, 2, 3, 4, 5]\n`,
      ).join("") + source(80);
    let controlNumber = 0;
    async function cancelControl(
      name: LiveControlName,
      action: () => Promise<unknown>,
    ): Promise<number> {
      let resolve!: (milliseconds: number) => void;
      let reject!: (error: unknown) => void;
      const completed = new Promise<number>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      noteLiveControlStage(evidence, name, "waiting-for-launch");
      launchControl = (invocation) => {
        try {
          controlledInvocations.set(name, invocation);
        } catch {
          // Evidence bookkeeping cannot change the original control.
        }
        noteLiveControlStage(evidence, name, "action-pending");
        const started = performance.now();
        assert.equal(
          invocation.closed,
          undefined,
          "control observes a live native CLI",
        );
        void action()
          .then(async () => {
            noteLiveControlStage(evidence, name, "waiting-for-close");
            await observed(
              () => invocation.closed !== undefined,
              "cancelled native CLI close join",
            );
            assert.equal(
              invocation.cancelled,
              true,
              "control cancels the native CLI before joining it",
            );
            noteLiveControlStage(evidence, name, "close-completed");
            resolve(invocation.closed! - started);
          })
          .catch(reject);
      };
      await replace(
        heavy,
        slow + `# control ${++controlNumber}\r\n`,
        "control-launch-edit",
        evidence,
      );
      return bounded(completed, name, evidence);
    }
    const supersededCloseMs = await cancelControl("superseded", async () => {
      await replace(heavy, source(90), "superseded-edit", evidence);
    });
    await observed(
      () => expected(heavy, 90),
      "superseded response cannot replace latest findings",
    );
    await checkpoint("superseded");
    const manualCloseMs = await cancelControl("manual", async () => {
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
    });
    await checkpoint("manual");
    assert.ok(manualCloseMs < deadlineMs);
    // Save the small primary while typing owns the heavy active subprocess.
    await replace(small, source(91), "save-preparation-edit", evidence);
    const saveCloseMs = await cancelControl("save", async () => {
      await small.save();
    });
    await observed(
      () => expected(small, 91),
      "save has priority over active typing",
    );
    await checkpoint("save");
    assert.ok(saveCloseMs < deadlineMs);
    // Reset disk baseline after the explicitly requested save control.
    const diskAfterSave = await diskSources(root.fsPath);
    for (const [filename, value] of diskBefore)
      if (filename !== small.uri.fsPath)
        assert.equal(
          diskAfterSave.get(filename),
          value,
          "live checks preserve other saved sources",
        );
    const settingOffCloseMs = await cancelControl("setting-off", async () => {
      await configuration.update(
        "checkOnType",
        false,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    });
    await checkpoint("setting-off");
    await configuration.update(
      "checkOnType",
      true,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
    const marker = vscode.Uri.joinPath(root, ".saltbox-lint");
    const markerRemovalCloseMs = await cancelControl(
      "marker-removal",
      async () => {
        await vscode.workspace.fs.delete(marker);
      },
    );
    await observed(
      () =>
        vscode.languages
          .getDiagnostics(heavy.uri)
          .every((finding) => finding.source !== "saltbox-lint"),
      "marker removal withdraws installed findings",
    );
    await checkpoint("marker-removed");
    await vscode.workspace.fs.writeFile(marker, Buffer.alloc(0));
    await vscode.window.showTextDocument(heavy, { preview: false });
    await vscode.commands.executeCommand("saltboxLint.checkDocument");
    await vscode.commands.executeCommand("saltboxLint.checkWorkspace");
    await checkpoint("marker-restored");
    const template = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(root, "roles/readonly/templates/config.yaml"),
    );
    primaryFilenames.set(template, realpathSync.native(template.uri.fsPath));
    await vscode.window.showTextDocument(template, { preview: false });
    await vscode.commands.executeCommand("saltboxLint.checkDocument");
    await checkpoint("template-baseline");
    const templateBefore = primaryCalls(template).length;
    await replace(
      template,
      template.getText() + " ",
      "template-edit",
      evidence,
    );
    await pause(650);
    assert.equal(
      primaryCalls(template).length,
      templateBefore,
      "templates excluded from typing",
    );
    await vscode.window.showTextDocument(heavy, { preview: false });
    // Give the last control a new snapshot so a document event is emitted.
    await replace(heavy, source(95), "restored-edit", evidence);
    await observed(
      () => expected(heavy, 95),
      "restored marker permits latest buffer",
    );
    await checkpoint("before-deactivate");
    const deactivateCloseMs = await cancelControl("deactivate", () =>
      runtime.deactivate(),
    );
    await checkpoint("deactivated");
    const diskAfter = await diskSources(root.fsPath);
    assert.deepEqual(
      diskAfter,
      diskAfterSave,
      "all saved source bytes unchanged by live checks",
    );
    const record: LiveCheckRecord = {
      schemaVersion: 1,
      target: `${process.platform}-${process.arch}`,
      expectedVersion: process.env.SALTBOX_TEST_EXPECTED_VSCODE_VERSION!,
      actualVersion: vscode.version,
      mode: "normal",
      boundary: "installed-cli-spawn-and-close",
      bounds: { debounceMs: 300, maxDocuments: 32 },
      fixtures: fixtureRecords,
      sustained,
      defaultOff: { typingLaunches: 0, saveLaunches: 1 },
      cancellation: {
        supersededCloseMs,
        manualCloseMs,
        saveCloseMs,
        settingOffCloseMs,
        markerRemovalCloseMs,
        deactivateCloseMs,
      },
      checkpoints,
      preservation: { diskSourcesUnchanged: true, bufferUnchanged },
      assertions: {
        actualInstalled: true,
        latestUnicodeCRLF: true,
        burstCoalesced: true,
        manualPriority: true,
        savePriority: true,
        templateExcluded: true,
      },
    };
    finalRecord = record;
  } catch (error) {
    failed = true;
    primaryFailure = error;
    reportLiveControlFailure(
      evidence,
      { fixtures: fixtureRecords.length, checkpoints: checkpoints.length },
      undefined,
      captureLiveInvocationFailure(
        invocations,
        controlledInvocations,
        overflow,
      ),
      captureLivePendingInvocations(
        invocations,
        controlledInvocations,
        overflow,
        { evidence, primaryFilenames, small, heavy },
      ),
    );
  } finally {
    launchControl = undefined;
    try {
      await bounded(runtime.deactivate(), "cleanup-deactivate", evidence);
      await observed(
        () => invocations.every((item) => item.closed !== undefined),
        "final installed native CLI join",
      );
    } catch (error) {
      cleanupFailures.push(error);
      if (!failed)
        reportLiveControlFailure(evidence, {
          fixtures: fixtureRecords.length,
          checkpoints: checkpoints.length,
        });
    } finally {
      try {
        Object.defineProperty(childProcesses, "spawn", descriptor);
      } catch (error) {
        cleanupFailures.push(error);
      } finally {
        try {
          changeListener.dispose();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
  }
  if (failed) {
    if (cleanupFailures.length)
      console.error("SALTBOX_LIVE_CHECK_CLEANUP_FAILURE", {
        failures: cleanupFailures.length,
      });
    throw primaryFailure;
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, "Live checking cleanup failed");
  assert.ok(finalRecord, "complete live checking record");
  validateLiveCheckRecord(finalRecord);
  console.log("SALTBOX_LIVE_CHECK_ACCEPTANCE " + JSON.stringify(finalRecord));
  console.log(
    "PASS installed live checking: default-off save parity, current Unicode/CRLF buffers, bounded typing, cancellation joins and source preservation",
  );
}
