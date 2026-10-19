import { EditorIntegration } from "../../src/editor.ts";
import { runProcess } from "../../src/process.ts";
import {
  createLiveProcessTracker,
  type LiveNativeInvocation,
} from "../support/live-processes.ts";
import {
  withTestResources,
  type TestResources,
} from "../support/test-resources.ts";
import { replaceLiveBuffer } from "./live-editor.ts";
import {
  createLiveBounded,
  cancelLiveControl,
  runManualLiveControl,
  runSaveLiveControl,
  cleanupLiveControls,
  captureLiveFailure,
  finishLiveFailure,
  prepareLiveBaseline,
  type LiveCancelContext,
} from "../support/live-controls.ts";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { readFile, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { hash } from "../../src/protocol.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import {
  liveSource as source,
  liveContext,
  liveTemplate,
} from "../support/live-fixture.ts";
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
type Invocation = LiveNativeInvocation;

// The performance profile owns one native component and its real editor events.
// Installed-package functional behavior runs separately without interception.
export async function runLivePerformance(
  parentSignal?: AbortSignal,
): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    (resources) => livePerformance(resources),
  );
}

async function livePerformance(resources: TestResources): Promise<void> {
  const bounded = createLiveBounded({ cancel: () => resources.cancel() });
  const replace = (
    document: vscode.TextDocument,
    text: string,
    name: LiveOperationName,
    evidence: LiveControlEvidence | undefined,
  ) => replaceLiveBuffer(document, text, name, evidence, bounded);
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint");
  assert.equal(
    product?.isActive ?? false,
    false,
    "performance profile owns a component adapter beside an inactive installed package",
  );
  const executable = process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!;
  const installed = process.env.SALTBOX_TEST_EXPECTED_PRODUCT_PATH;
  assert.ok(installed, "performance requires the verified installed backend");
  assert.equal(
    realpathSync.native(executable),
    realpathSync.native(
      join(
        installed,
        "bin",
        "saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
      ),
    ),
  );
  const root = vscode.workspace.workspaceFolders![0].uri;
  const configuration = vscode.workspace.getConfiguration("saltboxLint", root);
  assert.equal(configuration.get("checkOnType", false), false);
  const previous =
    configuration.inspect<boolean>("checkOnType")?.workspaceFolderValue;
  resources.defer("live performance setting", () =>
    configuration.update(
      "checkOnType",
      previous,
      vscode.ConfigurationTarget.WorkspaceFolder,
    ),
  );
  const markerURI = vscode.Uri.joinPath(root, ".saltbox-lint");
  const markerBytes = await vscode.workspace.fs.readFile(markerURI);
  resources.defer("live performance marker", () =>
    vscode.workspace.fs.writeFile(markerURI, markerBytes),
  );
  const smallURI = vscode.Uri.joinPath(root, "live-small.yml");
  const heavyURI = vscode.Uri.joinPath(
    root,
    "roles/livecontext/tasks/main.yml",
  );
  const contextURI = vscode.Uri.joinPath(
    root,
    "roles/livecontext/defaults/main.yml",
  );
  const context = liveContext();
  assert.deepEqual(
    Buffer.from(await vscode.workspace.fs.readFile(contextURI)),
    Buffer.from(context),
    "context fixture is complete before SDK startup",
  );
  for (const uri of [smallURI, heavyURI])
    assert.deepEqual(
      Buffer.from(await vscode.workspace.fs.readFile(uri)),
      Buffer.from(source(1)),
      "live source fixture is complete before SDK startup",
    );
  const templateURI = vscode.Uri.joinPath(
    root,
    "roles/readonly/templates/config.yaml",
  );
  assert.deepEqual(
    Buffer.from(await vscode.workspace.fs.readFile(templateURI)),
    Buffer.from(liveTemplate),
    "template fixture is complete before SDK startup",
  );
  const small = await vscode.workspace.openTextDocument(smallURI);
  const heavy = await vscode.workspace.openTextDocument(heavyURI);
  const primaryFilenames = new Map([
    [small, realpathSync.native(small.uri.fsPath)],
    [heavy, realpathSync.native(heavy.uri.fsPath)],
  ]);
  await vscode.window.showTextDocument(heavy, { preview: false });
  let controlContext: LiveCancelContext<vscode.TextDocument> | undefined;
  const processTracker = createLiveProcessTracker(runProcess, {
    onSpawn(invocation) {
      const control = controlContext?.launchControl;
      if (control && invocation.primary === primaryFilenames.get(heavy)) {
        controlContext!.launchControl = undefined;
        control(invocation);
      }
    },
  });
  const invocations = processTracker.invocations;
  const adapter = new EditorIntegration(executable, {
    runProcess: processTracker.runner,
  });
  const cancel = () => adapter.dispose();
  resources.signal.addEventListener("abort", cancel, { once: true });
  resources.defer("live performance adapter", async () => {
    resources.signal.removeEventListener("abort", cancel);
    adapter.dispose();
    await adapter.join();
  });
  const events = vscode.Disposable.from(
    vscode.workspace.onDidOpenTextDocument((document) =>
      adapter.open(document),
    ),
    vscode.workspace.onDidSaveTextDocument((document) =>
      adapter.saved(document),
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length) adapter.change(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) =>
      adapter.close(document),
    ),
  );
  resources.defer("live performance events", () => events.dispose());
  const runtime = {
    deactivate: async () => {
      adapter.dispose();
      await adapter.join();
    },
  };
  const commands = {
    executeCommand: async (command: string) => {
      if (command === "saltboxLint.checkWorkspace")
        return adapter.checkWorkspace();
      assert.equal(command, "saltboxLint.checkDocument");
      const document = vscode.window.activeTextEditor?.document;
      return document && adapter.check(document, true);
    },
  };
  await adapter.ready();
  await commands.executeCommand("saltboxLint.checkWorkspace");
  for (const document of [small, heavy]) {
    await vscode.window.showTextDocument(document, { preview: false });
    await commands.executeCommand("saltboxLint.checkDocument");
    await observed(
      () => expected(document, 1),
      "baseline expected diagnostics",
    );
  }
  const checkpoints: {
    name: string;
    launches: number;
    closes: number;
    active: number;
    requests: {
      admitted: number;
      settled: number;
      cancelledBeforeSpawn: number;
    };
  }[] = [];
  const checkpoint = async (name: string) => {
    await observed(
      () =>
        processTracker.requests.every(
          (request) => request.settled !== undefined,
        ),
      `${name} admitted runner operation join`,
    );
    await observed(
      () => invocations.every((item) => item.closed !== undefined),
      `${name} native CLI close join`,
    );
    processTracker.assertJoined();
    checkpoints.push({
      name,
      launches: invocations.length,
      closes: invocations.filter((item) => item.closed !== undefined).length,
      active: invocations.filter((item) => item.closed === undefined).length,
      requests: processTracker.accounting(),
    });
    assert.equal(
      processTracker.overflow,
      false,
      "live invocation evidence bound",
    );
  };
  const primaryCalls = (document: vscode.TextDocument) =>
    primaryRequests(invocations, primaryFilenames.get(document)!);
  let changed = 0;
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length && [small, heavy].includes(event.document))
      changed = performance.now();
  });
  resources.defer("live performance change listener", () =>
    changeListener.dispose(),
  );
  const evidence = createLiveControlEvidence();
  const controlledInvocations = new Map<LiveControlName, Invocation>();
  const fixtureRecords: LiveFixture[] = [];
  let bufferUnchanged = true;
  let finalRecord: LiveCheckRecord | undefined;
  const failureState = { failed: false, primaryFailure: undefined as unknown };
  const cleanupFailures: unknown[] = [];
  try {
    const offBefore = await prepareLiveBaseline(
      () => bounded(adapter.join(), "baseline-join", evidence),
      async () => {
        await checkpoint("baseline");
        return invocations.length;
      },
    );
    // A bounded observation window proves absence while typing is disabled.
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
    controlContext = {
      evidence,
      performance,
      controlledInvocations,
      launchControl: undefined,
      signal: resources.signal,
      controlNumber: 0,
      heavy,
      slow,
      replace,
      observed,
      bounded,
    };
    const cancelControl = (
      name: LiveControlName,
      action: () => Promise<unknown>,
    ) => cancelLiveControl(name, action, controlContext!);
    const sequence = {
      small,
      heavy,
      evidence,
      controlledInvocations,
      primaryCalls,
      cancelControl,
      expected,
      replace,
      observed,
      checkpoint,
      source,
      vscode: { window: vscode.window, commands },
    };
    const supersededCloseMs = await cancelControl("superseded", async () => {
      await replace(heavy, source(90), "superseded-edit", evidence);
    });
    await observed(
      () => expected(heavy, 90),
      "superseded response cannot replace latest findings",
    );
    await checkpoint("superseded");
    // Check the small primary while heavy typing owns the lane. Confirm that
    // the manual command cancels it before editing the heavy buffer.
    const manualCloseMs = await runManualLiveControl(sequence);
    assert.ok(manualCloseMs < deadlineMs);
    // Save the small primary while typing owns the heavy active subprocess.
    await replace(small, source(91), "save-preparation-edit", evidence);
    const saveCloseMs = await runSaveLiveControl(sequence);
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
    await commands.executeCommand("saltboxLint.checkDocument");
    await commands.executeCommand("saltboxLint.checkWorkspace");
    await checkpoint("marker-restored");
    const template = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(root, "roles/readonly/templates/config.yaml"),
    );
    primaryFilenames.set(template, realpathSync.native(template.uri.fsPath));
    await vscode.window.showTextDocument(template, { preview: false });
    await commands.executeCommand("saltboxLint.checkDocument");
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
      mode: "live-performance",
      boundary: "component-cli-runner-spawn-and-close",
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
        actualInstalledBackend: true,
        latestUnicodeCRLF: true,
        burstCoalesced: true,
        manualPriority: true,
        savePriority: true,
        templateExcluded: true,
      },
    };
    finalRecord = record;
  } catch (error) {
    captureLiveFailure(
      error,
      Object.assign(failureState, {
        evidence,
        invocations,
        controlledInvocations,
        overflow: processTracker.overflow,
        primaryFilenames,
        small,
        heavy,
        fixtureRecords,
        checkpoints,
      }),
    );
  } finally {
    cleanupFailures.push(
      ...(await cleanupLiveControls({
        stopLaunch: () => {
          if (controlContext) controlContext.launchControl = undefined;
        },
        deactivate: () =>
          bounded(runtime.deactivate(), "cleanup-deactivate", evidence),
        join: async () => {
          await observed(
            () =>
              processTracker.requests.every(
                (request) => request.settled !== undefined,
              ),
            "final admitted runner operation join",
          );
          await observed(
            () => invocations.every((item) => item.closed !== undefined),
            "final installed native CLI join",
          );
          processTracker.assertJoined();
        },
        restore: () => events.dispose(),
        unsubscribe: () => changeListener.dispose(),
      })),
    );
    if (!failureState.failed && cleanupFailures.length)
      reportLiveControlFailure(evidence, {
        fixtures: fixtureRecords.length,
        checkpoints: checkpoints.length,
      });
  }
  console.log(
    "SALTBOX_LIVE_PROCESS_REQUESTS " +
      JSON.stringify({
        boundary: "actual-native-spawn-and-close-with-runner-settlement",
        requests: processTracker.accounting(),
        nativeLaunches: invocations.length,
        nativeCloses: invocations.filter(
          (invocation) => invocation.closed !== undefined,
        ).length,
        pendingRequests: processTracker.requests.flatMap((request, index) =>
          request.settled === undefined
            ? [{ ordinal: index + 1, operation: request.operation }]
            : [],
        ),
        details: processTracker.requests.map((request, index) => ({
          ordinal: index + 1,
          operation: request.operation,
          admittedMs: request.admitted,
          settledMs: request.settled,
          nativeOrdinal: request.invocation
            ? invocations.indexOf(request.invocation) + 1
            : undefined,
          stdinPrimary: request.invocation?.primary !== undefined,
        })),
      }),
  );
  finishLiveFailure(failureState, cleanupFailures);
  assert.ok(finalRecord, "complete live checking record");
  validateLiveCheckRecord(finalRecord);
  console.log("SALTBOX_LIVE_CHECK_ACCEPTANCE " + JSON.stringify(finalRecord));
  console.log(
    "PASS native component live performance: default-off save parity, current Unicode/CRLF buffers, bounded typing, cancellation joins and source preservation",
  );
}

export async function runLiveChecking(
  parentSignal?: AbortSignal,
): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    async (resources) => {
      const product = vscode.extensions.getExtension("saltyorg.saltbox-lint");
      assert.ok(
        product?.isActive,
        "functional profile exercises the installed extension",
      );
      const root = vscode.workspace.workspaceFolders![0].uri;
      const configuration = vscode.workspace.getConfiguration(
        "saltboxLint",
        root,
      );
      const previous =
        configuration.inspect<boolean>("checkOnType")?.workspaceFolderValue;
      resources.defer("functional live setting", () =>
        configuration.update(
          "checkOnType",
          previous,
          vscode.ConfigurationTarget.WorkspaceFolder,
        ),
      );
      assert.equal(configuration.get("checkOnType", false), false);
      const uri = vscode.Uri.joinPath(root, "live-functional.yml");
      await vscode.workspace.fs.writeFile(uri, Buffer.from(source(1)));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      resources.defer("functional live document", async () => {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand(
          "workbench.action.revertAndCloseActiveEditor",
        );
      });
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.ok(expected(document, 1));
      const originalDisk = hash(await vscode.workspace.fs.readFile(uri));
      await resources.operation("default-off functional edit", () =>
        replaceLiveBuffer(document, source(6), "default-off-edit", undefined),
      );
      assert.equal(configuration.get("checkOnType", false), false);
      assert.equal(hash(await vscode.workspace.fs.readFile(uri)), originalDisk);
      assert.equal(document.getText(), source(6));
      assert.equal(await document.save(), true);
      await observed(
        () => expected(document, 6),
        "the installed default-off save publishes the saved generation",
      );
      await configuration.update(
        "checkOnType",
        true,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      const afterSave = hash(await vscode.workspace.fs.readFile(uri));
      await resources.operation("installed Unicode CRLF typing", () =>
        replaceLiveBuffer(document, source(12), "small-sample-edit", undefined),
      );
      await observed(
        () => expected(document, 12),
        "the installed typing path publishes the current Unicode CRLF generation",
      );
      assert.equal(document.getText(), source(12));
      assert.equal(hash(await vscode.workspace.fs.readFile(uri)), afterSave);
      await resources.operation("installed latest typing generation", () =>
        replaceLiveBuffer(document, source(30), "sustained-edit", undefined),
      );
      await observed(
        () => expected(document, 30),
        "a later installed typing generation replaces the previous one",
      );
      await vscode.commands.executeCommand("saltboxLint.checkDocument");
      assert.ok(expected(document, 30));
      await configuration.update(
        "checkOnType",
        false,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      assert.equal(configuration.get("checkOnType", true), false);
      console.log(
        "PASS installed functional live checking preserves current Unicode/CRLF buffers, save behavior, configuration and saved bytes",
      );
    },
  );
}
