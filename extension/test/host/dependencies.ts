import { ownJoinedResource } from "../support/host-resources.ts";
import {
  withTestResources,
  type TestResources,
} from "../support/test-resources.ts";
import { runProcess } from "../../src/process.ts";
import { hostTemporaryDirectory } from "../support/host-temporary.ts";
import { workspaceFixtureDirectory } from "../support/workspace-fixture.ts";
import { closeEditorTabs } from "../support/editor-tabs.ts";
import { cleanupDependencies } from "../support/dependency-cleanup.ts";
import { aliasFailureFacts, watchAliasTemplate } from "./alias-failure.ts";
import { observeAliasRefresh } from "./alias-refresh-observer.ts";
import {
  failureReason,
  journalFailureEvidence,
  logFailureEvidence,
  retainFailureEvidence,
  retainAfterDisposal,
  withFailureEvidence,
} from "./failure-evidence.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import { observeClosedFileDeliveries } from "../support/closed-file-controls.ts";
import { diagnosticSourceFacts } from "../support/diagnostic-source-facts.ts";
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";
import { hash, parseCheck } from "../../src/protocol.ts";
import {
  fixtureGateInstance,
  FixtureJournal,
  fixtureRunning,
  fixtureAbsent,
  type FixtureProcess,
} from "./fixture-processes.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const findings = (uri: vscode.Uri) =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.source === "saltbox-lint");
const renderer = (uri: vscode.Uri) =>
  findings(uri).some(
    (item) => diagnosticCode(item) === "traefik-renderer-contract",
  );
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 15000;
  while (!(await predicate()) && Date.now() < deadline) await pause(25);
  assert.ok(await predicate(), message);
}
async function replace(document: vscode.TextDocument, text: string) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    ),
    text,
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

function observeIgnoreDelivery(resources: TestResources) {
  const started = performance.now();
  const events: {
    ms: number;
    kind: string;
    base: string;
    pattern: string;
    uri: string;
  }[] = [];
  const delivery = observeClosedFileDeliveries((event) =>
    readFileSync(event.fsPath, "utf8"),
  );
  resources.defer("dependency ignore delivery observer", () =>
    delivery.dispose(),
  );
  const observe =
    (
      event: vscode.Event<vscode.Uri>,
      kind: "create" | "change" | "delete",
      pattern: vscode.RelativePattern,
    ): vscode.Event<vscode.Uri> =>
    (listener, receiver, subscriptions) =>
      event(
        (uri) => {
          if (events.length === 128) events.shift();
          events.push({
            ms: performance.now() - started,
            kind,
            base: pattern.baseUri.toString(),
            pattern: pattern.pattern,
            uri: uri.toString(),
          });
          const result = Reflect.apply(listener, receiver, [uri]);
          if (pattern.pattern === "**/.gitignore")
            delivery.delivered(uri, kind);
          return result;
        },
        undefined,
        subscriptions,
      );
  const createFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher =
    (...args) => {
      const watcher = vscode.workspace.createFileSystemWatcher(...args);
      const pattern = args[0];
      if (!(pattern instanceof vscode.RelativePattern)) return watcher;
      if (pattern.pattern === "**/.gitignore")
        resources.defer("dependency native ignore watcher", () =>
          watcher.dispose(),
        );
      return {
        ignoreCreateEvents: watcher.ignoreCreateEvents,
        ignoreChangeEvents: watcher.ignoreChangeEvents,
        ignoreDeleteEvents: watcher.ignoreDeleteEvents,
        onDidCreate: observe(watcher.onDidCreate, "create", pattern),
        onDidChange: observe(watcher.onDidChange, "change", pattern),
        onDidDelete: observe(watcher.onDidDelete, "delete", pattern),
        dispose: () => watcher.dispose(),
      } satisfies vscode.FileSystemWatcher;
    };
  return {
    createFileSystemWatcher,
    facts: () => events.slice(),
    // Capture before the write. Only a later production callback handling the
    // intended bytes satisfies this barrier; all duplicate events still run.
    next(uri: vscode.Uri, text: string) {
      return delivery.next(uri, text);
    },
  };
}

export async function runDependencies(
  parentSignal?: AbortSignal,
): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    (resources) => dependencies(resources),
  );
}

async function dependencies(resources: TestResources): Promise<void> {
  const roots = vscode.workspace.workspaceFolders!;
  const firstOpenName = "roles/example/tasks/first-open/first.yml";
  const administrativeIgnore = join(
    dirname(roots[0].uri.fsPath),
    ".git/info/exclude",
  );
  const originalAdministrativeIgnore = await readFile(administrativeIgnore);
  resources.defer("first-open administrative ignore", () =>
    writeFile(administrativeIgnore, originalAdministrativeIgnore),
  );
  const restoreFirstOpen = () =>
    writeFile(administrativeIgnore, originalAdministrativeIgnore);
  const admitFirstOpen = async (root: vscode.WorkspaceFolder) => {
    const current = await readFile(administrativeIgnore, "utf8");
    const pattern = `${basename(root.uri.fsPath)}/${firstOpenName}\n`;
    assert.ok(current.includes(pattern));
    const args = [
      "-C",
      root.uri.fsPath,
      "check-ignore",
      "--no-index",
      "--",
      firstOpenName,
    ];
    assert.equal(spawnSync("git", args, { timeout: 15000 }).status, 0);
    await writeFile(administrativeIgnore, current.replace(pattern, ""));
    assert.equal(spawnSync("git", args, { timeout: 15000 }).status, 1);
  };
  const task = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/example/tasks/main.yml",
  );
  const defaults = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/example/defaults/main.yml",
  );
  const template = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/example/templates/router.conf",
  );
  const otherTask = vscode.Uri.joinPath(
    roots[1].uri,
    "roles/example/tasks/main.yml",
  );
  const unrelatedUri = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/unrelated/defaults/main.yml",
  );
  const savedDefaults = vscode.Uri.file(await realpath(defaults.fsPath));
  const savedTask = vscode.Uri.file(await realpath(task.fsPath));
  // Directory scans and closed template events select the role template beside
  // its task. The CLI then reports the renderer violation once at the template,
  // so readiness accepts either owner of the same contract finding.
  const templateDirectory = await realpath(dirname(template.fsPath));
  const savedTemplates = ["router.conf", "router.yaml"].map((name) =>
    vscode.Uri.file(join(templateDirectory, name)),
  );
  const rendered = () =>
    [savedTask, ...savedTemplates].some((uri) => renderer(uri));
  const savedOtherTask = vscode.Uri.file(await realpath(otherTask.fsPath));
  const savedUnrelated = vscode.Uri.file(await realpath(unrelatedUri.fsPath));
  const temporary = await hostTemporaryDirectory("saltbox-dependencies-");
  resources.defer("dependency files", () =>
    rm(temporary, { recursive: true, force: true }),
  );
  const log = join(temporary, "process.log");
  const instancesLog = join(temporary, "instances.log");
  const fixtureEnvironment: NodeJS.ProcessEnv = {
    SALTBOX_TEST_PROCESS_LOG: log,
    SALTBOX_TEST_PROCESS_INSTANCES: instancesLog,
  };
  let beforeRead: ((filename: unknown) => Promise<void>) | undefined;
  const filesystem = {
    readFile: (async (...args: Parameters<typeof readFile>) => {
      await beforeRead?.(args[0]);
      return Reflect.apply(readFile, undefined, args);
    }) as typeof readFile,
  };
  const ignoreDelivery = observeIgnoreDelivery(resources);
  let statusBar!: vscode.StatusBarItem;
  const ownEditor = () => {
    const owner = ownJoinedResource(
      resources,
      "dependency editor",
      new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!, {
        readFile: filesystem.readFile,
        roots: {
          createFileSystemWatcher: ignoreDelivery.createFileSystemWatcher,
        },
        runProcess: (request, signal, observeFailure) =>
          runProcess(
            { ...request, env: { ...fixtureEnvironment } },
            signal,
            observeFailure,
          ),
        createStatusBarItem: (
          ...args: Parameters<typeof vscode.window.createStatusBarItem>
        ) => {
          statusBar = vscode.window.createStatusBarItem(...args);
          const item = statusBar;
          resources.defer("dependency status item", () => item.dispose());
          return item;
        },
      }),
    );
    return owner;
  };
  const journal = new FixtureJournal(instancesLog);
  const invocations = () => journal.invocations();
  let failed = false;
  let primaryFailure: unknown;
  let capturedFailure = false;
  let retainedFailureDirectory: string | undefined;
  let aliasTemplateEvents: ReturnType<typeof watchAliasTemplate> | undefined;
  let aliasRefresh: ReturnType<typeof observeAliasRefresh> | undefined;
  let cleanupStatus: {
    pid: number;
    token: string;
    absenceConfirmed: boolean;
  }[] = [];
  const good = await readFile(template.fsPath, "utf8"),
    defaultsGood = await readFile(defaults.fsPath, "utf8");
  const bad = "http:\n  routers: {}\n";
  const firstOpen = vscode.Uri.joinPath(roots[0].uri, firstOpenName);
  const aliasParent = await workspaceFixtureDirectory(
    roots[0].uri.fsPath,
    "saltbox-pending-status-",
  );
  const aliasDirectory = vscode.Uri.file(join(aliasParent, "alias"));
  const pendingAlias = vscode.Uri.joinPath(aliasDirectory, "first.yml");
  // Prepare the closed alias before this editor watches the fixture root.
  await symlink(
    dirname(firstOpen.fsPath),
    aliasDirectory.fsPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  const aliasUris: vscode.Uri[] = [];
  resources.defer("dependency alias tabs", (signal) =>
    closeEditorTabs(signal, aliasUris),
  );
  // This primary is excluded from full coverage and has no accepted graph yet.
  let editor = ownEditor();
  let admissionControl: Promise<PromiseSettledResult<void>[]> | undefined;
  const subscriptions: vscode.Disposable[] = [];
  const subscribe = (subscription: vscode.Disposable) => {
    resources.defer("dependency event", () => subscription.dispose());
    subscriptions.push(subscription);
  };
  subscribe(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length) editor.change(event.document);
    }),
  );
  subscribe(
    vscode.workspace.onDidSaveTextDocument((document) =>
      editor.saved(document),
    ),
  );
  subscribe(
    vscode.workspace.onDidCloseTextDocument((document) =>
      editor.close(document),
    ),
  );
  const success = (name: string) => console.log(`PASS ${name}`);
  try {
    await editor.ready();
    await editor.checkWorkspace();
    await editor.join();
    assert.equal(rendered(), false);
    assert.equal(renderer(savedOtherTask), false);
    assert.equal(findings(savedTask).length, 0);
    const unrelatedGood = await readFile(unrelatedUri.fsPath, "utf8");
    const invalidUri = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/invalid/defaults/main.yml",
    );
    const savedInvalid = vscode.Uri.file(await realpath(invalidUri.fsPath));
    const invalidFilename = await realpath(invalidUri.fsPath);
    const unrelatedFilename = await realpath(unrelatedUri.fsPath);
    const invalidBytes = await readFile(invalidUri.fsPath);
    let parseWire: string;
    try {
      parseWire = execFileSync(
        process.env.SALTBOX_TEST_REAL_CLI!,
        [
          "check",
          "--root",
          roots[0].uri.fsPath,
          "--format",
          "json",
          "--include-analysis",
          "--",
          "roles/invalid/defaults/main.yml",
        ],
        {
          encoding: "utf8",
          cwd: roots[0].uri.fsPath,
          timeout: 60000,
          env: { ...process.env, SALTBOX_LINT_EDITOR_PROCESS: "1" },
        },
      );
    } catch (error) {
      const failure = error as { status: number; stdout: string };
      assert.equal(failure.status, 1);
      parseWire = failure.stdout;
    }
    const parseReport = parseCheck(parseWire, true);
    assert.ok(
      parseReport.diagnostics.some((item) => item.rule_id === "yaml-syntax"),
    );
    assert.equal(
      parseReport.analysis!.sources[0].source_sha256,
      hash(invalidBytes),
    );
    assert.equal(
      findings(savedInvalid).length,
      0,
      "unsupported bytes have no editor coordinates",
    );
    assert.ok(
      !vscode.workspace.textDocuments.some(
        (document) => document.uri.toString() === invalidUri.toString(),
      ),
    );
    let quietCount = invocations().length;
    await pause(600);
    assert.equal(
      invocations().length,
      quietCount,
      "initial coverage must quiesce with invalid UTF-8",
    );
    const invalidChanged = Buffer.from([0xfe, 0x0a]);
    await editor.join();
    // Keep actual watchers active while the instance read boundary joins the
    // two owned writes before source snapshots are captured.
    let releaseFlush!: () => void;
    const flushBarrier = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const cancelFlush = () => releaseFlush();
    resources.signal.addEventListener("abort", cancelFlush, { once: true });
    beforeRead = async (filename) => {
      if ([invalidFilename, unrelatedFilename].includes(String(filename)))
        await flushBarrier;
    };
    try {
      await Promise.all([
        writeFile(invalidUri.fsPath, invalidChanged),
        writeFile(
          unrelatedUri.fsPath,
          unrelatedGood.replace("{{ other\n }}", "{{ other }}"),
        ),
      ]);
      quietCount = invocations().length;
      editor.removeFile(invalidUri);
      editor.removeFile(unrelatedUri);
    } finally {
      beforeRead = undefined;
      releaseFlush();
      resources.signal.removeEventListener("abort", cancelFlush);
    }
    await waitFor(
      () =>
        invocations().length > quietCount &&
        findings(savedUnrelated).length === 0,
      "valid peer must publish beside unsupported UTF-8",
    );
    await editor.join();
    const settled = invocations().length;
    await pause(600);
    assert.equal(
      invocations().length,
      settled,
      "stable invalid UTF-8 must not endlessly requeue selected checks",
    );
    assert.ok(
      invocations()
        .slice(quietCount)
        .some(
          (line) =>
            line.includes("roles/invalid/defaults/main.yml") &&
            line.includes("roles/unrelated/defaults/main.yml"),
        ),
      "unsupported source and valid peer must share a selected batch",
    );
    assert.ok(
      invocations()
        .slice(quietCount)
        .every((line) => !line.endsWith(" .")),
      "accepted parse sources must retain complete coverage",
    );
    assert.deepEqual(await readFile(invalidUri.fsPath), invalidChanged);
    assert.equal(findings(savedInvalid).length, 0);
    await writeFile(invalidUri.fsPath, unrelatedGood);
    editor.removeFile(invalidUri);
    await waitFor(
      () =>
        findings(savedInvalid).some(
          (item) => diagnosticCode(item) === "jinja-layout",
        ),
      "valid UTF-8 change must recover ordinary diagnostics",
    );
    await writeFile(invalidUri.fsPath, invalidBytes);
    editor.removeFile(invalidUri);
    await waitFor(
      () => findings(savedInvalid).length === 0,
      "unsupported bytes must clear prior saved coordinates",
    );
    await writeFile(unrelatedUri.fsPath, unrelatedGood);
    await waitFor(
      () =>
        findings(savedUnrelated).some(
          (item) => diagnosticCode(item) === "jinja-layout",
        ),
      "valid peer recovery",
    );
    await editor.join();
    quietCount = invocations().length;
    await pause(600);
    assert.equal(
      invocations().length,
      quietCount,
      "recovered unsupported source must remain quiescent",
    );
    assert.deepEqual(await readFile(invalidUri.fsPath), invalidBytes);
    success(
      "invalid UTF-8 retains parse identity and coverage, quiesces beside valid peers and recovers on valid edits",
    );
    const invalidDocument = await vscode.workspace.openTextDocument(invalidUri);
    await vscode.window.showTextDocument(invalidDocument, { preview: false });
    assert.equal(invalidDocument.isDirty, false);
    assert.notEqual(hash(invalidDocument.getText()), hash(invalidBytes));
    quietCount = invocations().length;
    assert.deepEqual(await editor.format(invalidDocument, "canonical"), []);
    assert.deepEqual(await editor.format(invalidDocument, "lint-fixes"), []);
    assert.equal(
      invocations().length,
      quietCount,
      "unsupported formatting must reject independently of checks",
    );
    await editor.check(invalidDocument, true);
    editor.saved(invalidDocument);
    await waitFor(
      () => invocations().length > quietCount + 1,
      "clean unsupported document must exercise the actual saved queue",
    );
    await editor.join();
    const openSettled = invocations().length;
    await pause(600);
    assert.equal(
      invocations().length,
      openSettled,
      "clean open invalid UTF-8 must not repeatedly retry decoded stdin",
    );
    assert.equal(findings(invalidDocument.uri).length, 0);
    assert.deepEqual(
      editor.actions(invalidDocument, new vscode.Range(0, 0, 20, 0)),
      [],
    );
    assert.ok(
      invocations()
        .slice(quietCount)
        .every((line) => !line.includes("--stdin-filename")),
      "clean unsupported checks must preserve raw saved-file identity",
    );
    assert.deepEqual(await readFile(invalidUri.fsPath), invalidBytes);
    await replace(invalidDocument, unrelatedGood);
    await editor.check(invalidDocument, true);
    assert.equal(invalidDocument.isDirty, true);
    assert.ok(
      findings(invalidDocument.uri).some(
        (item) => diagnosticCode(item) === "jinja-layout",
      ),
    );
    assert.ok(
      editor.actions(invalidDocument, new vscode.Range(0, 0, 100, 0)).length >
        0,
    );
    assert.ok(
      (await editor.format(invalidDocument, "lint-fixes")).length > 0,
      "dirty-buffer formatting must use its explicit text snapshot",
    );
    assert.deepEqual(await readFile(invalidUri.fsPath), invalidBytes);
    await invalidDocument.save();
    await editor.check(invalidDocument, true);
    assert.equal(invalidDocument.isDirty, false);
    assert.ok(
      findings(invalidDocument.uri).some(
        (item) => diagnosticCode(item) === "jinja-layout",
      ),
    );
    assert.equal(await readFile(invalidUri.fsPath, "utf8"), unrelatedGood);
    await editor.join();
    quietCount = invocations().length;
    await pause(600);
    assert.equal(
      invocations().length,
      quietCount,
      "valid clean document must recover and quiesce",
    );
    await writeFile(invalidUri.fsPath, invalidBytes);
    editor.removeFile(invalidUri);
    await waitFor(
      () => findings(invalidDocument.uri).length === 0,
      "clean unsupported reload must clear prior document coordinates",
    );
    assert.deepEqual(
      editor.actions(invalidDocument, new vscode.Range(0, 0, 100, 0)),
      [],
    );
    await editor.join();
    quietCount = invocations().length;
    await pause(600);
    assert.equal(
      invocations().length,
      quietCount,
      "clean unsupported reload must quiesce",
    );
    assert.deepEqual(await readFile(invalidUri.fsPath), invalidBytes);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    success(
      "clean open invalid UTF-8 quiesces, rejects unsafe actions and formatting, preserves dirty snapshots and recovers after valid save",
    );
    const batchGate = join(temporary, "batch-gate");
    const lateTemplate = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/example/templates/late.conf",
    );
    assert.ok(
      findings(savedUnrelated).some(
        (item) => diagnosticCode(item) === "jinja-layout",
      ),
    );
    assert.ok(
      !vscode.workspace.textDocuments.some(
        (document) =>
          !document.isClosed &&
          [defaults.toString(), unrelatedUri.toString()].includes(
            document.uri.toString(),
          ),
      ),
      "mixed selected batch must contain closed primaries",
    );
    const batchRoot = await realpath(roots[0].uri.fsPath);
    let count = invocations().length;
    await writeFile(batchGate, "");
    const batchNonce = randomBytes(32).toString("hex");
    // The role template depends on the changed defaults and is now a closed
    // primary of the same selected batch.
    const batchPaths = [
      "roles/example/defaults/main.yml",
      "roles/example/tasks/main.yml",
      "roles/example/templates/router.conf",
      "roles/unrelated/defaults/main.yml",
    ];
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = batchGate;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = batchNonce;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PATHS =
      JSON.stringify(batchPaths);
    // Actual writes and public notifications share one synchronous cohort.
    // Real watchers remain active, without snapshotting a partially joined batch.
    writeFileSync(
      defaults.fsPath,
      defaultsGood + 'example_batch_value: "{{ value\n }}"\n',
    );
    writeFileSync(
      unrelatedUri.fsPath,
      unrelatedGood.replace("{{ other\n }}", "{{ other }}"),
    );
    editor.removeFile(defaults);
    editor.removeFile(unrelatedUri);
    await waitFor(
      () => existsSync(batchGate + ".ready"),
      "mixed selected batch must hold its already-computed output",
    );
    const batchReady = JSON.parse(await readFile(batchGate + ".ready", "utf8"));
    assert.equal(batchReady.nonce, batchNonce);
    assert.deepEqual(batchReady.args, [
      "check",
      "--root",
      batchRoot,
      "--format",
      "json",
      "--include-analysis",
      "--",
      ...batchPaths,
    ]);
    const batchInstance = fixtureGateInstance(
      batchReady,
      instancesLog,
      journal,
    );
    assert.deepEqual(batchInstance.args, batchReady.args);
    assert.equal(await fixtureRunning(batchInstance), true);
    assert.equal(invocations().slice(count).length, 1);
    assert.ok(
      invocations()
        .slice(count)
        .some(
          (line) =>
            line.includes("roles/example/defaults/main.yml") &&
            line.includes("roles/unrelated/defaults/main.yml"),
        ),
      "both changed closed roles must share the held selected batch",
    );
    await writeFile(lateTemplate.fsPath, "late membership\n");
    await writeFile(template.fsPath, bad);
    editor.removeFile(lateTemplate);
    editor.removeFile(template);
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = undefined;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = undefined;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PATHS = undefined;
    await rm(batchGate);
    await waitFor(
      () => fixtureAbsent(batchInstance),
      "mixed selected batch releases its exact held child",
    );
    await waitFor(
      () =>
        findings(savedDefaults).some(
          (item) => diagnosticCode(item) === "jinja-layout",
        ) &&
        findings(savedUnrelated).length === 0 &&
        rendered(),
      "rejected mixed batch must refresh both changed primaries and context-driven peers",
    );
    assert.ok(
      invocations()
        .slice(count)
        .every((line) => !line.endsWith(" .")),
      "rejected selected batches must retain established full coverage",
    );
    await Promise.all([
      writeFile(defaults.fsPath, defaultsGood),
      writeFile(unrelatedUri.fsPath, unrelatedGood),
      writeFile(template.fsPath, good),
      rm(lateTemplate.fsPath),
    ]);
    await waitFor(
      () =>
        findings(savedDefaults).length === 0 &&
        findings(savedUnrelated).some(
          (item) => diagnosticCode(item) === "jinja-layout",
        ) &&
        !rendered(),
      "mixed-batch recovery must restore the original diagnostics",
    );
    success(
      "late context events retain every rejected selected source after full coverage",
    );
    const admissionGood = (index: number) =>
      unrelatedGood.replace("unrelated_value:", `admission_value_${index}:`);
    const admissionDirectory = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/admission/defaults",
    );
    const admissionFiles = Array.from({ length: 65 }, (_, index) =>
      vscode.Uri.joinPath(
        admissionDirectory,
        `file${String(index).padStart(3, "0")}.yml`,
      ),
    );
    const admissionIgnore = vscode.Uri.joinPath(roots[0].uri, ".gitignore");
    const admissionIgnoreText = await readFile(admissionIgnore.fsPath, "utf8");
    await mkdir(admissionDirectory.fsPath, { recursive: true });
    await Promise.all(
      admissionFiles.map((uri, index) =>
        writeFile(
          uri.fsPath,
          admissionGood(index).replace("{{ other\n }}", "{{ other }}"),
        ),
      ),
    );
    const savedAdmissionFiles = await Promise.all(
      admissionFiles.map(async (uri) =>
        vscode.Uri.file(await realpath(uri.fsPath)),
      ),
    );
    for (const uri of admissionFiles) editor.removeFile(uri);
    await editor.join();
    await editor.checkWorkspace();
    await editor.join();
    assert.ok(savedAdmissionFiles.every((uri) => findings(uri).length === 0));
    const admissionGate = join(temporary, "admission-gate");
    const admissionNonce = randomBytes(32).toString("hex");
    const admissionPrefix = "roles/admission/defaults/";
    const admissionPaths = admissionFiles
      .slice(0, 64)
      .map((uri) => admissionPrefix + uri.path.split("/").at(-1));
    await writeFile(admissionGate, "");
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = admissionGate;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PREFIX = admissionPrefix;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PATHS =
      JSON.stringify(admissionPaths);
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = admissionNonce;
    count = invocations().length;
    // A preceding request must not satisfy this chunk's readiness gate.
    const admissionControlDocument =
      await vscode.workspace.openTextDocument(defaults);
    const admissionControlFilename = await realpath(defaults.fsPath);
    admissionControl = Promise.allSettled([
      resources.operation("admission control primary", () =>
        editor.check(admissionControlDocument),
      ),
    ]);
    await waitFor(
      () =>
        invocations()
          .slice(count)
          .some((line) =>
            line.includes(
              ` --stdin-filename ${admissionControlFilename} --format `,
            ),
          ),
      "unrelated document request must start under the admission gate",
    );
    await Promise.all(
      admissionFiles.map((uri, index) =>
        writeFile(uri.fsPath, admissionGood(index)),
      ),
    );
    for (const uri of admissionFiles) editor.removeFile(uri);
    await waitFor(
      () => existsSync(admissionGate + ".ready"),
      "first selected chunk must hold output after complete coverage",
    );
    const firstAdmissionBatch = invocations().slice(count);
    const held: {
      pid: number;
      args: string[];
      nonce: string;
      instance: FixtureProcess;
    } = JSON.parse(await readFile(admissionGate + ".ready", "utf8"));
    assert.equal(held.nonce, admissionNonce, "readiness belongs to this gate");
    assert.deepEqual(
      held.args.filter((argument) => argument.startsWith(admissionPrefix)),
      admissionPaths,
      "the held request contains the exact first 64 admission paths",
    );
    assert.ok(
      firstAdmissionBatch.includes(`${held.pid} ${held.args.join(" ")}`),
      "readiness identifies the exact new invocation",
    );
    const heldInstance = fixtureGateInstance(held, instancesLog, journal);
    assert.equal(
      await fixtureRunning(heldInstance),
      true,
      "the exact 64-path request is still live before admission changes",
    );
    console.log(
      `MEASURE admission held_pid=${held.pid} paths=64 nonce=${held.nonce} endpoint_live=true`,
    );
    assert.ok(
      firstAdmissionBatch.some(
        (line) => line.split("roles/admission/defaults/").length - 1 === 64,
      ),
      "queued admission regression must exceed the 64-source chunk limit",
    );
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = undefined;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PREFIX = undefined;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PATHS = undefined;
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = undefined;
    const revokedIgnoreText = admissionIgnoreText + "roles/admission/\n";
    const revokedIgnoreDelivered = ignoreDelivery.next(
      admissionIgnore,
      revokedIgnoreText,
    );
    await writeFile(admissionIgnore.fsPath, revokedIgnoreText);
    const revokedCount = invocations().length;
    editor.removeFile(admissionIgnore);
    await waitFor(
      revokedIgnoreDelivered,
      "the real production watcher must handle the revoked ignore bytes",
    );
    await rm(admissionGate);
    const controlOutcome = (await admissionControl)[0];
    if (controlOutcome.status === "rejected") throw controlOutcome.reason;
    await waitFor(
      () =>
        invocations()
          .slice(revokedCount)
          .some((line) => line.endsWith(" .")),
      "revoked admission must schedule a fresh membership scan",
    );
    await editor.join();
    assert.ok(
      invocations()
        .slice(revokedCount)
        .every((line) => !line.includes("roles/admission/defaults/")),
      "remaining closed chunks must retain the revoked original admission",
    );
    assert.ok(
      savedAdmissionFiles.every((uri) => findings(uri).length === 0),
      "excluded closed findings must stay absent after fresh membership coverage",
    );
    await rm(vscode.Uri.joinPath(roots[0].uri, "roles/admission").fsPath, {
      recursive: true,
      force: true,
    });
    const restoredIgnoreDelivered = ignoreDelivery.next(
      admissionIgnore,
      admissionIgnoreText,
    );
    await writeFile(admissionIgnore.fsPath, admissionIgnoreText);
    await waitFor(
      restoredIgnoreDelivered,
      "the real production watcher must handle the restored ignore bytes",
    );
    await editor.join();
    await editor.checkWorkspace();
    await editor.join();
    success("admission changes revoke every remaining closed selected chunk");

    const unrelated = await vscode.workspace.openTextDocument(unrelatedUri);
    await vscode.window.showTextDocument(unrelated, { preview: false });
    await editor.check(unrelated, true);
    const unrelatedActions = editor.actions(
      unrelated,
      new vscode.Range(0, 0, unrelated.lineCount, 0),
    );
    assert.ok(unrelatedActions.length > 0);
    const otherBefore = findings(savedOtherTask),
      unrelatedBefore = findings(unrelated.uri);
    count = invocations().length;
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => rendered(),
      "closed clean tasks must refresh on a non-j2 template edit",
    );
    assert.deepEqual(findings(savedOtherTask), otherBefore);
    assert.deepEqual(findings(unrelated.uri), unrelatedBefore);
    assert.deepEqual(
      editor.actions(unrelated, new vscode.Range(0, 0, unrelated.lineCount, 0)),
      unrelatedActions,
    );
    assert.ok(
      invocations()
        .slice(count)
        .every(
          (line) =>
            !line.endsWith(" .") &&
            !line.includes("roles/unrelated") &&
            !line.includes(roots[1].uri.fsPath),
        ),
      "context edit should preserve unrelated sources and full coverage",
    );
    await writeFile(template.fsPath, good);
    await waitFor(
      () => !rendered(),
      "template recovery must clear task findings",
    );
    success(
      "good/bad/good templates refresh closed clean primaries and preserve unrelated roles and roots",
    );

    const yamlTemplate = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/example/templates/router.yaml",
    );
    const taskText = await readFile(task.fsPath, "utf8");
    await rename(template.fsPath, yamlTemplate.fsPath);
    await writeFile(
      task.fsPath,
      taskText.replace("router.conf", "router.yaml"),
    );
    editor.removeFile(task);
    await editor.join();
    await writeFile(yamlTemplate.fsPath, bad);
    await waitFor(
      () => rendered(),
      "YAML-named templates must refresh their selected primaries",
    );
    await writeFile(yamlTemplate.fsPath, good);
    await waitFor(() => !rendered(), "YAML-named template recovery");
    const templateDocument =
      await vscode.workspace.openTextDocument(yamlTemplate);
    const calls = invocations().length;
    await editor.check(templateDocument, true);
    assert.deepEqual(await editor.format(templateDocument, "canonical"), []);
    assert.ok(
      invocations().length > calls,
      "explicit template check invokes the CLI",
    );
    assert.equal(editor.providerDocuments().includes(templateDocument), true);
    assert.equal(editor.writable(templateDocument), false);
    await rename(yamlTemplate.fsPath, template.fsPath);
    await writeFile(task.fsPath, taskText);
    editor.removeFile(task);
    await editor.join();
    success(
      "YAML-named templates refresh context and expose read-only checking providers",
    );

    await writeFile(template.fsPath, bad);
    await waitFor(() => rendered(), "template bad state");
    await writeFile(
      defaults.fsPath,
      defaultsGood.replace("example_role_traefik_enabled: false\n", ""),
    );
    await waitFor(
      () => !rendered(),
      "defaults removal must change another primary's result",
    );
    await writeFile(defaults.fsPath, defaultsGood);
    await waitFor(
      () => rendered(),
      "defaults restoration must recheck another primary",
    );
    await writeFile(template.fsPath, good);
    await waitFor(() => !rendered(), "defaults recovery");
    success("defaults edits refresh dependent task diagnostics");

    const docker = vscode.Uri.joinPath(
        roots[0].uri,
        "resources/tasks/docker/read.yml",
      ),
      policy = vscode.Uri.joinPath(
        roots[0].uri,
        "resources/tasks/docker/policy.yml",
      );
    const policyGood = await readFile(policy.fsPath, "utf8");
    const savedDocker = vscode.Uri.file(await realpath(docker.fsPath));
    const dockerBad = () =>
      findings(savedDocker).some(
        (item) => diagnosticCode(item) === "docker-vars-policy",
      );
    assert.equal(dockerBad(), false);
    await writeFile(
      policy.fsPath,
      policyGood.replace("omit': true", "omit': false"),
    );
    await waitFor(
      dockerBad,
      "shared Docker context must refresh clean siblings",
    );
    await writeFile(policy.fsPath, policyGood);
    await waitFor(() => !dockerBad(), "shared Docker recovery");
    success("shared Docker context uses the same dependency invalidation");

    await rm(template.fsPath);
    await waitFor(() => rendered(), "template deletion must refresh primaries");
    await writeFile(template.fsPath, good);
    await waitFor(
      () => !rendered(),
      "missing template creation must refresh primaries",
    );
    const moved = join(roots[0].uri.fsPath, "moved-template.txt");
    await rename(template.fsPath, moved);
    await waitFor(() => rendered(), "rename away must refresh");
    await rename(moved, template.fsPath);
    await waitFor(() => !rendered(), "rename back must refresh");
    const replacement = join(roots[0].uri.fsPath, "replacement.txt");
    await writeFile(replacement, bad);
    await rename(replacement, template.fsPath);
    await waitFor(() => rendered(), "atomic replacement must refresh");
    await writeFile(replacement, good);
    await rename(replacement, template.fsPath);
    await waitFor(() => !rendered(), "atomic recovery");
    success(
      "missing creation, deletion, rename and atomic replacement refresh dependencies",
    );

    const document = await vscode.workspace.openTextDocument(defaults);
    await vscode.window.showTextDocument(document, { preview: false });
    await replace(document, defaultsGood + 'example_value: "{{ value\n }}"\n');
    await editor.check(document, true);
    const displayed = findings(document.uri);
    const action = editor
      .actions(document, new vscode.Range(0, 0, document.lineCount, 0))
      .find((item) => item.command?.command === "saltboxLint.applySharedFix")!;
    assert.ok(action);
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => rendered(),
      "closed dependent refresh during dirty buffer",
    );
    assert.deepEqual(findings(document.uri), displayed);
    assert.deepEqual(
      editor.actions(document, new vscode.Range(0, 0, document.lineCount, 0)),
      [],
    );
    const text = document.getText();
    await editor.applyShared(
      ...(action.command!.arguments as [vscode.Uri, string, string, string]),
    );
    assert.equal(document.getText(), text);
    await editor.check(document, true);
    assert.ok(
      editor.actions(document, new vscode.Range(0, 0, document.lineCount, 0))
        .length > 0,
    );
    await replace(document, defaultsGood);
    await document.save();
    await writeFile(template.fsPath, good);
    await waitFor(() => !rendered(), "dirty buffer recovery");
    success(
      "dirty dependent findings remain visible and stale actions cannot apply",
    );

    // An explicitly selected source retains its context dependencies.
    // The role contract reports its first renderer. This temporary source must
    // sort before main.yml, then leave the role before later renderer cases.
    const explicit = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/example/tasks/a_explicit.yml",
    );
    await writeFile(join(roots[0].uri.fsPath, ".gitignore"), "ignored.yml\n");
    await writeFile(explicit.fsPath, await readFile(task.fsPath, "utf8"));
    const explicitDocument = await vscode.workspace.openTextDocument(explicit);
    await vscode.window.showTextDocument(explicitDocument, { preview: false });
    await editor.check(explicitDocument, true);
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => renderer(explicit),
      "explicitly checked primary must refresh on context events",
    );
    await writeFile(template.fsPath, good);
    await waitFor(() => !renderer(explicit), "explicit primary recovery");
    success("explicit selections participate in dependency refresh");

    // An ignore control changes the admitted source set without any YAML edit.
    const newlyAdmitted = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/example/tasks/admitted.yml",
    );
    const savedAdmitted = vscode.Uri.file(await realpath(newlyAdmitted.fsPath));
    const ignorePath = join(roots[0].uri.fsPath, ".gitignore");
    const ignoreText = await readFile(ignorePath, "utf8");
    await writeFile(
      ignorePath,
      ignoreText + "roles/example/tasks/admitted.yml\n",
    );
    editor.removeFile(vscode.Uri.file(ignorePath));
    await waitFor(
      () => findings(savedAdmitted).length === 0,
      "excluded primary must leave saved coverage before admission changes",
    );
    await writeFile(ignorePath, ignoreText);
    await waitFor(
      () =>
        findings(savedAdmitted).some(
          (item) => diagnosticCode(item) === "jinja-layout",
        ),
      "ignore-control changes must discover previously excluded primaries",
    );
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => renderer(explicit),
      "membership reconciliation must retain explicitly checked dependencies",
    );
    await writeFile(template.fsPath, good);
    await waitFor(
      () => !renderer(explicit),
      "explicit primary recovery after membership reconciliation",
    );
    success(
      "Git ignore changes reconcile coverage and retain visible explicit dependencies",
    );
    await vscode.window.showTextDocument(explicitDocument, { preview: false });
    await vscode.commands.executeCommand(
      "workbench.action.revertAndCloseActiveEditor",
    );
    // Intentional source deletion verifies that renderer ownership returns to
    // the original primary, rather than retaining this case's role context.
    await rm(explicit.fsPath);
    editor.removeFile(explicit);
    await editor.join();
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => rendered(),
      "deleting the explicit first renderer restores the original primary",
    );
    await writeFile(template.fsPath, good);
    await waitFor(() => !rendered(), "original renderer recovery");
    success("deleting an explicit renderer restores original role ownership");

    if (process.platform !== "win32") {
      const alias = vscode.Uri.joinPath(roots[0].uri, "task-alias.yml");
      await symlink(task.fsPath, alias.fsPath);
      const aliasDocument = await vscode.workspace.openTextDocument(alias);
      await vscode.window.showTextDocument(aliasDocument, { preview: false });
      await editor.check(aliasDocument, true);
      aliasTemplateEvents = watchAliasTemplate(template);
      const templateObserver = aliasTemplateEvents;
      resources.defer("alias template observer", () =>
        templateObserver.dispose(),
      );
      aliasRefresh = observeAliasRefresh(editor, aliasDocument, template);
      const refreshObserver = aliasRefresh;
      resources.defer("alias refresh observer", () =>
        refreshObserver.dispose(),
      );
      logFailureEvidence("SALTBOX_INITIAL_ALIAS_FACTS", {
        schemaVersion: 1,
        phase: "initial alias admission before template mutation",
        aliasFacts: await aliasFailureFacts(
          editor,
          aliasDocument,
          alias,
          task,
          template,
          defaults,
          "public facts after initial manual alias check; before template mutation",
        ),
      });
      await writeFile(template.fsPath, bad);
      await withFailureEvidence(
        () =>
          waitFor(
            () => renderer(alias),
            "canonical template event must refresh an alias-owned primary",
          ),
        async (error) => {
          capturedFailure = true;
          const [aliasFacts, processFacts] = await Promise.all([
            aliasFailureFacts(
              editor,
              aliasDocument,
              alias,
              task,
              template,
              defaults,
            ),
            journalFailureEvidence(journal),
          ]);
          const evidence = {
            schemaVersion: 1,
            phase: "initial alias assertion rejected before disposal",
            originalError: failureReason(error),
            canonicalTemplateEvents: aliasTemplateEvents!.snapshot(),
            actualAliasRefresh: aliasRefresh!.snapshot(),
            aliasFacts,
            processFacts,
            cleanup: "not yet observed",
            processStart:
              "unavailable; journal records credentialed lifetime, not OS start identity",
          };
          const retention = await retainFailureEvidence(evidence);
          retainedFailureDirectory = retention.directory;
          return { ...evidence, retention };
        },
        (evidence) =>
          logFailureEvidence("SALTBOX_DEPENDENCY_FAILURE", evidence),
      );
      logFailureEvidence("SALTBOX_ALIAS_REFRESH_OBSERVATION", {
        phase: "ordinary initial alias assertion passed",
        actualAliasRefresh: aliasRefresh.snapshot(),
      });
      aliasRefresh.dispose();
      await writeFile(template.fsPath, good);
      await withFailureEvidence(
        () => waitFor(() => !renderer(alias), "alias recovery"),
        async (error) => {
          capturedFailure = true;
          const [aliasFacts, processFacts] = await Promise.all([
            aliasFailureFacts(
              editor,
              aliasDocument,
              alias,
              task,
              template,
              defaults,
            ),
            journalFailureEvidence(journal),
          ]);
          const evidence = {
            schemaVersion: 1,
            phase: "alias assertion rejected before disposal",
            originalError: failureReason(error),
            canonicalTemplateEvents: aliasTemplateEvents!.snapshot(),
            aliasFacts,
            processFacts,
            cleanup: "not yet observed",
            processStart:
              "unavailable; journal records credentialed lifetime, not OS start identity",
          };
          const retention = await retainFailureEvidence(evidence);
          retainedFailureDirectory = retention.directory;
          return { ...evidence, retention };
        },
        (evidence) =>
          logFailureEvidence("SALTBOX_DEPENDENCY_FAILURE", evidence),
      );
      // Retain the ordinary watcher recovery above. Separately force a raw
      // alias notification to overlap a real canonical post-CLI report. An
      // unchanged alias must preserve that child and lexical publication.
      await writeFile(template.fsPath, bad);
      await waitFor(
        () => renderer(alias),
        "alias overlap starts with a bad report",
      );
      const aliasVersion = aliasDocument.version;
      const aliasText = aliasDocument.getText();
      const canonicalTask = await realpath(task.fsPath);
      const aliasGate = join(temporary, "alias-recovery");
      const aliasNonce = randomBytes(32).toString("hex");
      const gateVariables = [
        "SALTBOX_TEST_PROCESS_GATE",
        "SALTBOX_TEST_PROCESS_GATE_NONCE",
        "SALTBOX_TEST_PROCESS_GATE_PREFIX",
      ];
      const priorGate = gateVariables.map((name) => fixtureEnvironment[name]);
      const beforeOverlap = journal.processes();
      try {
        await writeFile(aliasGate, "");
        fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = aliasGate;
        fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = aliasNonce;
        fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PREFIX = canonicalTask;
        await writeFile(template.fsPath, good);
        editor.removeFile(template);
        await waitFor(
          () => existsSync(aliasGate + ".ready"),
          "real canonical primary report reaches the alias overlap gate",
        );
        const ready = JSON.parse(await readFile(aliasGate + ".ready", "utf8"));
        assert.equal(ready.nonce, aliasNonce);
        assert.ok(ready.args.includes(canonicalTask));
        const instance = fixtureGateInstance(ready, instancesLog, journal);
        assert.equal(await fixtureRunning(instance), true);
        // Replacement requests must run normally, rather than inherit the
        // original child's gate or use its credential to claim completion.
        for (const name of gateVariables) fixtureEnvironment[name] = undefined;
        editor.removeFile(alias);
        assert.equal(
          await fixtureRunning(instance),
          true,
          "unchanged alias echo preserves the exact held canonical child",
        );
        await rm(aliasGate, { force: true });
        await waitFor(
          () => !renderer(alias),
          "overlapping alias event retains recovery",
        );
        assert.equal(await fixtureRunning(instance), false);
        assert.ok(
          journal
            .processes()
            .some(
              (process) =>
                process.token === instance.token &&
                !beforeOverlap.some(
                  (previous) => previous.token === process.token,
                ),
            ),
          "recovery retains the observed primary identity",
        );
        assert.equal(aliasDocument.version, aliasVersion);
        assert.equal(aliasDocument.getText(), aliasText);
        assert.equal(aliasDocument.isDirty, false);
        assert.ok(editor.providerDocuments().includes(aliasDocument));
      } finally {
        for (const [index, name] of gateVariables.entries()) {
          if (priorGate[index] === undefined)
            fixtureEnvironment[name] = undefined;
          else fixtureEnvironment[name] = priorGate[index];
        }
        await rm(aliasGate, { force: true });
      }
      success(
        "unchanged alias notification preserves the held canonical child and recovers lexical diagnostics",
      );
      await rm(alias.fsPath);
      success("canonical context events retain alias ownership");
    }

    await editor.join();
    count = invocations().length;
    const start = Date.now();
    for (let index = 0; index < 30; index++)
      await writeFile(template.fsPath, index % 2 === 0 ? bad : good);
    await pause(600);
    await waitFor(
      () => !rendered(),
      "event burst must retain the final template state",
    );
    const burst = invocations().slice(count);
    assert.ok(
      burst.length <= 8,
      `30 template writes should coalesce, got ${burst.length} processes`,
    );
    assert.ok(
      burst.every((line) => !line.endsWith(" .")),
      "event burst must retain full coverage",
    );
    console.log(
      `MEASURE dependency burst writes=30 processes=${burst.length} elapsed_ms=${Date.now() - start}`,
    );
    success("watcher bursts coalesce without full-root rescans");

    await admitFirstOpen(roots[1]);
    const queuedUri = vscode.Uri.joinPath(roots[1].uri, firstOpenName);
    await editor.join();
    const blockerDocument =
      await vscode.workspace.openTextDocument(unrelatedUri);
    const otherTemplate = vscode.Uri.joinPath(
      roots[1].uri,
      "roles/example/templates/router.conf",
    );
    const blockerGate = join(temporary, "queued-status-blocker");
    const queuedGate = join(temporary, "queued-status-admission");
    const blockerNonce = randomBytes(32).toString("hex");
    const queuedNonce = randomBytes(32).toString("hex");
    try {
      await writeFile(blockerGate, "");
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = blockerGate;
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = blockerNonce;
      const blocker = resources.operation("queued source blocker", () =>
        editor.check(blockerDocument),
      );
      await waitFor(
        () => existsSync(blockerGate + ".ready"),
        "unrelated primary holds the scheduler before source admission",
      );
      const blockerReady = JSON.parse(
        await readFile(blockerGate + ".ready", "utf8"),
      );
      assert.equal(blockerReady.nonce, blockerNonce);
      assert.ok(
        invocations().includes(
          `${blockerReady.pid} ${blockerReady.args.join(" ")}`,
        ),
      );
      assert.ok(
        blockerReady.args.includes(await realpath(unrelatedUri.fsPath)),
      );
      const blockerInstance = fixtureGateInstance(
        blockerReady,
        instancesLog,
        journal,
      );
      assert.equal(await fixtureRunning(blockerInstance), true);
      const queuedDocument = await vscode.workspace.openTextDocument(queuedUri);
      await vscode.window.showTextDocument(queuedDocument, { preview: false });
      await writeFile(queuedGate, "");
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = queuedGate;
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = queuedNonce;
      const queuedCount = invocations().length;
      const queuedCheck = resources.operation("queued unknown source", () =>
        editor.check(queuedDocument),
      );
      await waitFor(
        () => editor.status(queuedDocument).state === "checking",
        "the public pending status identifies the queued source",
      );
      assert.ok(editor.providerDocuments().includes(queuedDocument));
      const queuedVersion = queuedDocument.version;
      for (const [scope, changedTemplate] of [
        ["other-root", template],
        ["own-root", otherTemplate],
      ] as const) {
        await writeFile(
          changedTemplate.fsPath,
          good + "\n# queued status event\n",
        );
        editor.removeFile(changedTemplate);
        assert.equal(queuedDocument.version, queuedVersion);
        assert.ok(editor.providerDocuments().includes(queuedDocument));
        assert.equal(await fixtureRunning(blockerInstance), true);
        assert.equal(editor.status(queuedDocument).state, "checking");
        assert.equal((await editor.showStatus()).state, "checking");
        assert.equal(statusBar.text, "Saltbox Lint: checking");
        assert.equal(
          invocations().length,
          queuedCount,
          scope +
            " context cannot launch the queued source before the blocker closes",
        );
      }
      const queuedDuplicate = resources.operation(
        "duplicate queued source",
        () => editor.check(queuedDocument),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(invocations().length, queuedCount);
      await rm(blockerGate);
      await blocker;
      await waitFor(
        () => existsSync(queuedGate + ".ready"),
        "the same queued request reaches canonical admission",
      );
      const queuedReady = JSON.parse(
        await readFile(queuedGate + ".ready", "utf8"),
      );
      assert.equal(queuedReady.nonce, queuedNonce);
      assert.ok(
        invocations().includes(
          `${queuedReady.pid} ${queuedReady.args.join(" ")}`,
        ),
      );
      assert.ok(queuedReady.args.includes(await realpath(queuedUri.fsPath)));
      const queuedInstance = fixtureGateInstance(
        queuedReady,
        instancesLog,
        journal,
      );
      assert.equal(await fixtureRunning(queuedInstance), true);
      assert.equal(await fixtureRunning(blockerInstance), false);
      assert.ok(editor.providerDocuments().includes(queuedDocument));
      assert.equal(editor.status().state, "checking");
      assert.equal((await editor.showStatus()).state, "checking");
      assert.equal(statusBar.text, "Saltbox Lint: checking");
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = undefined;
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = undefined;
      await rm(queuedGate);
      await Promise.all([queuedCheck, queuedDuplicate]);
      assert.equal(await fixtureRunning(queuedInstance), false);
      await writeFile(template.fsPath, good);
      await writeFile(otherTemplate.fsPath, good);
      editor.removeFile(template);
      editor.removeFile(otherTemplate);
      await editor.join();
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
      success(
        "queued unknown source retains public pending ownership across unrelated own and other root events and deduplicates through native admission",
      );
    } finally {
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = undefined;
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = undefined;
      await rm(blockerGate, { force: true });
      await rm(queuedGate, { force: true });
    }

    await restoreFirstOpen();
    await editor.checkWorkspace();
    await editor.join();
    await admitFirstOpen(roots[0]);
    const firstDocument = await vscode.workspace.openTextDocument(firstOpen);
    await vscode.window.showTextDocument(firstDocument, { preview: false });
    assert.equal(
      editor.providerDocuments().includes(firstDocument),
      false,
      "the unknown source has not yet been admitted",
    );
    const firstFilename = await realpath(firstOpen.fsPath);
    const firstVersion = firstDocument.version;
    const firstGate = join(temporary, "first-open-gate");
    await writeFile(firstGate, "");
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = firstGate;
    const firstCount = invocations().length;
    const firstCheck = resources.operation("first open primary", () =>
      editor.check(firstDocument),
    );
    await waitFor(
      () => existsSync(firstGate + ".ready"),
      "first open primary check must hold its old context output",
    );
    assert.ok(
      invocations()
        .slice(firstCount)
        .some((line) =>
          line.includes("--stdin-filename " + firstFilename + " --format"),
        ),
      "held output must belong to the first document check",
    );
    const firstInstance = fixtureGateInstance(
      JSON.parse(await readFile(firstGate + ".ready", "utf8")),
      instancesLog,
      journal,
    );
    assert.equal(await fixtureRunning(firstInstance), true);
    assert.equal(firstDocument.version, firstVersion);
    const firstBar = statusBar;
    const firstPendingStatus = editor.status(firstDocument);
    const firstManualStatus = await editor.showStatus();
    assert.equal(firstPendingStatus.state, "checking");
    assert.equal(firstManualStatus.state, "checking");
    assert.equal(firstBar.text, "Saltbox Lint: checking");
    const duplicateCount = invocations().length;
    const duplicateCheck = resources.operation(
      "duplicate first open primary",
      () => editor.check(firstDocument),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(invocations().length, duplicateCount);
    assert.equal(await fixtureRunning(firstInstance), true);
    await writeFile(template.fsPath, bad);
    editor.removeFile(template);
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = undefined;
    await rm(firstGate);
    await Promise.all([firstCheck, duplicateCheck]);
    await waitFor(
      () => renderer(firstOpen),
      "first clean open primary must recover after unknown context rejects its result",
    );
    assert.ok(
      invocations()
        .slice(firstCount)
        .every((line) => !line.endsWith(" .")),
      "first document recovery must retain complete saved coverage",
    );
    await writeFile(template.fsPath, good);
    await waitFor(() => !renderer(firstOpen), "first open primary recovery");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    success(
      "first open primary retries rejected context before graph acceptance",
    );
    success(
      "first check after prior context events retains pending ownership through canonical admission, manual status and deduplication",
    );
    await editor.join();
    const aliasDocument = await vscode.workspace.openTextDocument(pendingAlias);
    aliasUris.push(aliasDocument.uri);
    await vscode.window.showTextDocument(aliasDocument, { preview: false });
    assert.equal(editor.providerDocuments().includes(aliasDocument), false);
    const aliasText = aliasDocument.getText();
    const aliasGate = join(temporary, "pending-alias-gate");
    try {
      await writeFile(aliasGate, "");
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = aliasGate;
      const aliasCheck = resources.operation("pending alias check", () =>
        editor.check(aliasDocument),
      );
      await waitFor(
        () => existsSync(aliasGate + ".ready"),
        "alias check admits canonical ownership and holds its actual child",
      );
      const aliasReady = JSON.parse(
        await readFile(aliasGate + ".ready", "utf8"),
      );
      assert.ok(aliasReady.args.includes(firstFilename));
      assert.ok(aliasReady.args.includes("--stdin-filename"));
      const aliasInstance = fixtureGateInstance(
        aliasReady,
        instancesLog,
        journal,
      );
      assert.equal(await fixtureRunning(aliasInstance), true);
      // Alias publication itself updates this item before manual status runs.
      assert.equal(firstBar.text, "Saltbox Lint: checking");
      assert.equal(editor.status().state, "checking");
      assert.equal((await editor.showStatus()).state, "checking");
      assert.equal(firstBar.text, "Saltbox Lint: checking");
      await rm(aliasGate + ".ready");
      await replace(aliasDocument, aliasText + "# superseded pending source\n");
      editor.change(aliasDocument);
      assert.equal(editor.status().state, "eligible");
      const replacement = resources.operation("pending alias check", () =>
        editor.check(aliasDocument),
      );
      await aliasCheck;
      assert.equal(await fixtureRunning(aliasInstance), false);
      await waitFor(
        () => existsSync(aliasGate + ".ready"),
        "replacement source revision reaches the held gate",
      );
      const replacementInstance = fixtureGateInstance(
        JSON.parse(await readFile(aliasGate + ".ready", "utf8")),
        instancesLog,
        journal,
      );
      assert.notEqual(replacementInstance.token, aliasInstance.token);
      assert.equal(await fixtureRunning(replacementInstance), true);
      assert.equal(editor.status().state, "checking");
      assert.equal((await editor.showStatus()).state, "checking");
      assert.equal(firstBar.text, "Saltbox Lint: checking");
      editor.dispose();
      await replacement;
      assert.equal(await fixtureRunning(replacementInstance), false);
      // Disposing Output can change the active editor. Keep this root-disposal
      // assertion bound to the same alias document as the held source request.
      await vscode.window.showTextDocument(aliasDocument, { preview: false });
      assert.equal(editor.status().state, "missing-marker");
      await editor.join();
    } finally {
      fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = undefined;
      await rm(aliasGate, { force: true });
      await replace(aliasDocument, aliasText);
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
    }
    success(
      "alias admission displays public pending status and supersession, cancellation and disposal release exact child ownership",
    );
    await restoreFirstOpen();

    // Hold an already-computed full scan, then change unknown context before its
    // first result is accepted. Cancellation must preserve eventual full coverage.
    editor.dispose();
    const gate = join(temporary, "scan-gate");
    await writeFile(gate, "");
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = gate;
    await editor.join();
    editor = ownEditor();
    await waitFor(
      () => existsSync(gate + ".ready"),
      "initial scan gate must receive old output",
    );
    await writeFile(template.fsPath, bad);
    editor.removeFile(template);
    await rm(gate);
    fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = undefined;
    await waitFor(
      () => rendered(),
      "late context changes must reject the initial result and restore full coverage",
    );
    await writeFile(template.fsPath, good);
    await waitFor(() => !rendered(), "late result recovery");
    success(
      "late context events reject in-flight scans and retain startup full coverage",
    );

    // This isolated role has exactly one primary dependent on its template.
    const statusTask = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/status-event/tasks/main.yml",
    );
    const statusTemplate = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/status-event/templates/router.conf",
    );
    await mkdir(join(roots[0].uri.fsPath, "roles/status-event/tasks"), {
      recursive: true,
    });
    await mkdir(join(roots[0].uri.fsPath, "roles/status-event/templates"), {
      recursive: true,
    });
    const statusSource = await readFile(task.fsPath, "utf8");
    await writeFile(statusTask.fsPath, statusSource);
    await writeFile(statusTemplate.fsPath, good);
    await editor.checkWorkspace();
    await editor.join();
    const statusDocument = await vscode.workspace.openTextDocument(statusTask);
    await vscode.window.showTextDocument(statusDocument, { preview: false });
    await replace(
      statusDocument,
      statusSource +
        '- name: Show value\n  ansible.builtin.debug:\n    msg: "{{ value\n }}"\n',
    );
    await editor.check(statusDocument, true);
    // Read the actual VS Code item without invoking showStatus/updateStatus.
    assert.equal(statusDocument.isDirty, true);
    assert.equal(statusBar.text, "Saltbox Lint: current");
    const statusFindings = findings(statusDocument.uri);
    assert.ok(
      statusFindings.length > 0,
      "retain existing dirty-source findings",
    );
    const statusQuiet = invocations().length;
    await writeFile(statusTemplate.fsPath, bad);
    editor.removeFile(statusTemplate);
    await waitFor(
      () => statusBar.text === "Saltbox Lint: stale",
      "dependency event must update the actual status bar for a dirty source",
    );
    assert.deepEqual(findings(statusDocument.uri), statusFindings);
    await pause(600);
    assert.equal(
      invocations().length,
      statusQuiet,
      "dirty dependency event must schedule no automatic check",
    );
    assert.equal(statusBar.text, "Saltbox Lint: stale");
    await writeFile(statusTemplate.fsPath, good);
    await replace(statusDocument, statusSource);
    await statusDocument.save();
    await editor.check(statusDocument, true);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    success(
      "dirty referenced-template event updates actual status bar with complete coverage and no queued check",
    );

    await rm(join(roots[0].uri.fsPath, ".saltbox-lint"));
    await waitFor(
      () =>
        findings(savedTask).length === 0 &&
        findings(unrelated.uri).length === 0,
      "marker removal clears graph and diagnostics",
    );
    count = invocations().length;
    await writeFile(template.fsPath, bad);
    await pause(350);
    assert.equal(invocations().length, count);
    await writeFile(template.fsPath, good);
    await writeFile(join(roots[0].uri.fsPath, ".saltbox-lint"), "");
    await editor.checkWorkspace();
    success(
      "marker removal releases graph state and re-enablement scans fresh context",
    );
    assert.equal(
      await readFile(template.fsPath, "utf8"),
      good,
      "template bytes remain unchanged by checks",
    );
    editor.dispose();
    await editor.join();
    await waitFor(async () => {
      const instances = journal.processes(true);
      const pids = invocations().map((line) => Number(line.split(" ")[0]));
      if (instances.length !== pids.length) return false;
      assert.deepEqual(
        instances.map((instance) => instance.pid).sort((a, b) => a - b),
        pids.sort((a, b) => a - b),
        "every invocation must have a process lifetime identity",
      );
      const absent = await Promise.all(instances.map(fixtureAbsent));
      assert.equal(
        new Set(instances.map((instance) => instance.token)).size,
        instances.length,
      );
      cleanupStatus = instances.map((instance, index) => ({
        pid: instance.pid,
        token: instance.token,
        absenceConfirmed: absent[index],
      }));
      return absent.every(Boolean);
    }, "completed dependency checks must leave no fixture processes running");
    console.log(
      `MEASURE dependency cleanup observed_processes=${journal.processes().length} surviving=0`,
    );
  } catch (error) {
    failed = true;
    primaryFailure = error;
    // The alias path already captured its public facts immediately after the
    // unchanged assertion. Other failures still refresh the journal once.
    if (!capturedFailure) {
      try {
        const evidence = {
          schemaVersion: 1,
          phase: "dependency rejection before disposal",
          originalError: failureReason(error),
          sourceFacts: diagnosticSourceFacts(vscode, roots, [
            defaults,
            task,
            otherTask,
            template,
            vscode.Uri.joinPath(
              roots[0].uri,
              "roles/example/templates/router.yaml",
            ),
            unrelatedUri,
            vscode.Uri.joinPath(
              roots[0].uri,
              "roles/invalid/defaults/main.yml",
            ),
          ]),
          watcherDeliveries: ignoreDelivery.facts(),
          processFacts: await journalFailureEvidence(journal),
          cleanup: cleanupStatus.length ? cleanupStatus : "not yet observed",
        };
        const retention = await retainFailureEvidence(evidence);
        retainedFailureDirectory = retention.directory;
        logFailureEvidence("SALTBOX_DEPENDENCY_FAILURE", {
          ...evidence,
          retention,
        });
      } catch {
        // Preserve the original test rejection even if reporting fails.
      }
    }
    throw error;
  } finally {
    const cleanupFailures = await cleanupDependencies({
      observers: [aliasRefresh, aliasTemplateEvents],
      owner: editor,
      admission: admissionControl,
      afterDisposal: async () => {
        if (failed) {
          try {
            const evidence = {
              schemaVersion: 1,
              phase: "after existing owner disposal",
              processFacts: await journalFailureEvidence(journal),
            };
            logFailureEvidence("SALTBOX_DEPENDENCY_FAILURE", evidence);
            if (retainedFailureDirectory)
              await retainAfterDisposal(retainedFailureDirectory, evidence);
          } catch {
            // Observation or logging failures cannot replace the assertion.
          }
        }
      },
      subscriptions,
      releaseAliases: async () => {
        // This declared SDK-visible junction belongs to the external host;
        // its exact document tabs are restored by the case resource owner.
      },
      restoreEnvironment: () => {
        fixtureEnvironment.SALTBOX_TEST_PROCESS_LOG = undefined;
        fixtureEnvironment.SALTBOX_TEST_PROCESS_INSTANCES = undefined;
        fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE = undefined;
        fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PREFIX = undefined;
        fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_PATHS = undefined;
        fixtureEnvironment.SALTBOX_TEST_PROCESS_GATE_NONCE = undefined;
      },
      releaseFiles: () => rm(temporary, { recursive: true, force: true }),
    });
    if (cleanupFailures.length)
      throw new AggregateError(
        [...(failed ? [primaryFailure] : []), ...cleanupFailures],
        "Dependency test and cleanup failed",
        { cause: failed ? primaryFailure : cleanupFailures[0] },
      );
  }
}
