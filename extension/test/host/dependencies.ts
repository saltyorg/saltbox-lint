import * as vscode from "vscode";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";
import { hash, parseCheck } from "../../src/protocol.ts";
import {
  fixtureGateInstance,
  fixtureProcesses,
  fixtureRunning,
  type FixtureProcess,
} from "./fixture-processes.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const findings = (uri: vscode.Uri) =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.source === "saltbox-lint");
const renderer = (uri: vscode.Uri) =>
  findings(uri).some((item) => item.code === "traefik-renderer-contract");
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
export async function runDependencies(): Promise<void> {
  const roots = vscode.workspace.workspaceFolders!;
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
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-dependencies-"));
  const log = join(temporary, "process.log");
  const instancesLog = join(temporary, "instances.log");
  process.env.SALTBOX_TEST_PROCESS_LOG = log;
  process.env.SALTBOX_TEST_PROCESS_INSTANCES = instancesLog;
  const invocations = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
  let cleanupStatus: { pid: number; token: string; running: boolean }[] = [];
  const good = await readFile(template.fsPath, "utf8"),
    defaultsGood = await readFile(defaults.fsPath, "utf8");
  const bad = "http:\n  routers: {}\n";
  const firstOpen = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/example/tasks/first-open/ignored.yml",
  );
  // This primary is excluded from full coverage and has no accepted graph yet.
  let editor = new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!);
  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length) editor.change(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) =>
      editor.saved(document),
    ),
    vscode.workspace.onDidCloseTextDocument((document) =>
      editor.close(document),
    ),
  ];
  const success = (name: string) => console.log(`PASS ${name}`);
  try {
    await editor.checkWorkspace();
    await pause(400);
    assert.equal(renderer(task), false);
    assert.equal(renderer(otherTask), false);
    assert.equal(findings(task).length, 0);
    const unrelatedGood = await readFile(unrelatedUri.fsPath, "utf8");
    const invalidUri = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/invalid/defaults/main.yml",
    );
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
        { encoding: "utf8", cwd: roots[0].uri.fsPath },
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
      findings(invalidUri).length,
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
    await waitFor(
      () =>
        invocations().length > quietCount &&
        findings(unrelatedUri).length === 0,
      "valid peer must publish beside unsupported UTF-8",
    );
    await pause(400);
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
    assert.equal(findings(invalidUri).length, 0);
    await writeFile(invalidUri.fsPath, unrelatedGood);
    editor.removeFile(invalidUri);
    await waitFor(
      () => findings(invalidUri).some((item) => item.code === "jinja-layout"),
      "valid UTF-8 change must recover ordinary diagnostics",
    );
    await writeFile(invalidUri.fsPath, invalidBytes);
    editor.removeFile(invalidUri);
    await waitFor(
      () => findings(invalidUri).length === 0,
      "unsupported bytes must clear prior saved coordinates",
    );
    await writeFile(unrelatedUri.fsPath, unrelatedGood);
    await waitFor(
      () => findings(unrelatedUri).some((item) => item.code === "jinja-layout"),
      "valid peer recovery",
    );
    await pause(400);
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
    await pause(400);
    const openSettled = invocations().length;
    await pause(600);
    assert.equal(
      invocations().length,
      openSettled,
      "clean open invalid UTF-8 must not repeatedly retry decoded stdin",
    );
    assert.equal(findings(invalidUri).length, 0);
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
      findings(invalidUri).some((item) => item.code === "jinja-layout"),
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
      findings(invalidUri).some((item) => item.code === "jinja-layout"),
    );
    assert.equal(await readFile(invalidUri.fsPath, "utf8"), unrelatedGood);
    await pause(400);
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
      () => findings(invalidUri).length === 0,
      "clean unsupported reload must clear prior document coordinates",
    );
    assert.deepEqual(
      editor.actions(invalidDocument, new vscode.Range(0, 0, 100, 0)),
      [],
    );
    await pause(400);
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
      findings(unrelatedUri).some((item) => item.code === "jinja-layout"),
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
    let count = invocations().length;
    await writeFile(batchGate, "");
    process.env.SALTBOX_TEST_PROCESS_GATE = batchGate;
    await Promise.all([
      writeFile(
        defaults.fsPath,
        defaultsGood + 'example_batch_value: "{{ value\n }}"\n',
      ),
      writeFile(
        unrelatedUri.fsPath,
        unrelatedGood.replace("{{ other\n }}", "{{ other }}"),
      ),
    ]);
    // Deliver both events together so the real queue forms one mixed batch.
    editor.removeFile(defaults);
    editor.removeFile(unrelatedUri);
    await waitFor(
      () => existsSync(batchGate + ".ready"),
      "mixed selected batch must hold its already-computed output",
    );
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
    delete process.env.SALTBOX_TEST_PROCESS_GATE;
    await rm(batchGate);
    await waitFor(
      () =>
        findings(defaults).some((item) => item.code === "jinja-layout") &&
        findings(unrelatedUri).length === 0 &&
        renderer(task),
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
        findings(defaults).length === 0 &&
        findings(unrelatedUri).some((item) => item.code === "jinja-layout") &&
        !renderer(task),
      "mixed-batch recovery must restore the original diagnostics",
    );
    success(
      "late context events retain every rejected selected source after full coverage",
    );
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
      admissionFiles.map((uri) =>
        writeFile(
          uri.fsPath,
          unrelatedGood.replace("{{ other\n }}", "{{ other }}"),
        ),
      ),
    );
    await editor.checkWorkspace();
    await pause(400);
    assert.ok(admissionFiles.every((uri) => findings(uri).length === 0));
    const admissionGate = join(temporary, "admission-gate");
    const admissionNonce = randomBytes(32).toString("hex");
    const admissionPrefix = "roles/admission/defaults/";
    await writeFile(admissionGate, "");
    process.env.SALTBOX_TEST_PROCESS_GATE = admissionGate;
    process.env.SALTBOX_TEST_PROCESS_GATE_PREFIX = admissionPrefix;
    process.env.SALTBOX_TEST_PROCESS_GATE_NONCE = admissionNonce;
    count = invocations().length;
    // A preceding request must not satisfy this chunk's readiness gate.
    const admissionControlDocument =
      await vscode.workspace.openTextDocument(defaults);
    void editor.check(admissionControlDocument);
    await waitFor(
      () =>
        invocations()
          .slice(count)
          .some(
            (line) =>
              line.includes("--stdin-filename") &&
              line.includes("roles/example/defaults/main.yml"),
          ),
      "unrelated document request must start under the admission gate",
    );
    await Promise.all(
      admissionFiles.map((uri) => writeFile(uri.fsPath, unrelatedGood)),
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
      admissionFiles
        .slice(0, 64)
        .map((uri) => admissionPrefix + uri.path.split("/").at(-1)),
      "the held request contains the exact first 64 admission paths",
    );
    assert.ok(
      firstAdmissionBatch.includes(`${held.pid} ${held.args.join(" ")}`),
      "readiness identifies the exact new invocation",
    );
    const heldInstance = fixtureGateInstance(held, instancesLog);
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
    delete process.env.SALTBOX_TEST_PROCESS_GATE;
    delete process.env.SALTBOX_TEST_PROCESS_GATE_PREFIX;
    delete process.env.SALTBOX_TEST_PROCESS_GATE_NONCE;
    await writeFile(
      admissionIgnore.fsPath,
      admissionIgnoreText + "roles/admission/\n",
    );
    const revokedCount = invocations().length;
    editor.removeFile(admissionIgnore);
    await rm(admissionGate);
    await waitFor(
      () =>
        invocations()
          .slice(revokedCount)
          .some((line) => line.endsWith(" .")),
      "revoked admission must schedule a fresh membership scan",
    );
    await pause(700);
    assert.ok(
      invocations()
        .slice(revokedCount)
        .every((line) => !line.includes("roles/admission/defaults/")),
      "remaining closed chunks must retain the revoked original admission",
    );
    assert.ok(
      admissionFiles.every((uri) => findings(uri).length === 0),
      "excluded closed findings must stay absent after fresh membership coverage",
    );
    await rm(vscode.Uri.joinPath(roots[0].uri, "roles/admission").fsPath, {
      recursive: true,
      force: true,
    });
    await writeFile(admissionIgnore.fsPath, admissionIgnoreText);
    await editor.checkWorkspace();
    await pause(400);
    success("admission changes revoke every remaining closed selected chunk");

    const unrelated = await vscode.workspace.openTextDocument(unrelatedUri);
    await vscode.window.showTextDocument(unrelated, { preview: false });
    await editor.check(unrelated, true);
    const unrelatedActions = editor.actions(
      unrelated,
      new vscode.Range(0, 0, unrelated.lineCount, 0),
    );
    assert.ok(unrelatedActions.length > 0);
    const otherBefore = findings(otherTask),
      unrelatedBefore = findings(unrelatedUri);
    count = invocations().length;
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => renderer(task),
      "closed clean tasks must refresh on a non-j2 template edit",
    );
    assert.deepEqual(findings(otherTask), otherBefore);
    assert.deepEqual(findings(unrelatedUri), unrelatedBefore);
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
      () => !renderer(task),
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
    await pause(250);
    await writeFile(yamlTemplate.fsPath, bad);
    await waitFor(
      () => renderer(task),
      "YAML-named templates must refresh primaries without entering selected batches",
    );
    await writeFile(yamlTemplate.fsPath, good);
    await waitFor(() => !renderer(task), "YAML-named template recovery");
    const templateDocument =
      await vscode.workspace.openTextDocument(yamlTemplate);
    const calls = invocations().length;
    await editor.check(templateDocument, true);
    assert.deepEqual(await editor.format(templateDocument, "canonical"), []);
    assert.equal(invocations().length, calls);
    assert.equal(editor.providerDocuments().includes(templateDocument), false);
    await rename(yamlTemplate.fsPath, template.fsPath);
    await writeFile(task.fsPath, taskText);
    await pause(250);
    success(
      "YAML-named templates refresh context and expose no check/fix/formatter provider",
    );

    await writeFile(template.fsPath, bad);
    await waitFor(() => renderer(task), "template bad state");
    await writeFile(
      defaults.fsPath,
      defaultsGood.replace("example_role_traefik_enabled: false\n", ""),
    );
    await waitFor(
      () => !renderer(task),
      "defaults removal must change another primary's result",
    );
    await writeFile(defaults.fsPath, defaultsGood);
    await waitFor(
      () => renderer(task),
      "defaults restoration must recheck another primary",
    );
    await writeFile(template.fsPath, good);
    await waitFor(() => !renderer(task), "defaults recovery");
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
    const dockerBad = () =>
      findings(docker).some((item) => item.code === "docker-vars-policy");
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
    await waitFor(
      () => renderer(task),
      "template deletion must refresh primaries",
    );
    await writeFile(template.fsPath, good);
    await waitFor(
      () => !renderer(task),
      "missing template creation must refresh primaries",
    );
    const moved = join(roots[0].uri.fsPath, "moved-template.txt");
    await rename(template.fsPath, moved);
    await waitFor(() => renderer(task), "rename away must refresh");
    await rename(moved, template.fsPath);
    await waitFor(() => !renderer(task), "rename back must refresh");
    const replacement = join(roots[0].uri.fsPath, "replacement.txt");
    await writeFile(replacement, bad);
    await rename(replacement, template.fsPath);
    await waitFor(() => renderer(task), "atomic replacement must refresh");
    await writeFile(replacement, good);
    await rename(replacement, template.fsPath);
    await waitFor(() => !renderer(task), "atomic recovery");
    success(
      "missing creation, deletion, rename and atomic replacement refresh dependencies",
    );

    const document = await vscode.workspace.openTextDocument(defaults);
    await vscode.window.showTextDocument(document, { preview: false });
    await replace(document, defaultsGood + 'example_value: "{{ value\n }}"\n');
    await editor.check(document, true);
    const displayed = findings(defaults);
    const action = editor
      .actions(document, new vscode.Range(0, 0, document.lineCount, 0))
      .find((item) => item.command?.command === "saltboxLint.applySharedFix")!;
    assert.ok(action);
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => renderer(task),
      "closed dependent refresh during dirty buffer",
    );
    assert.deepEqual(findings(defaults), displayed);
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
    await waitFor(() => !renderer(task), "dirty buffer recovery");
    success(
      "dirty dependent findings remain visible and stale actions cannot apply",
    );

    // An ignored explicit selection must retain its dependencies too.
    const ignored = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/example/tasks/ignored.yml",
    );
    await writeFile(
      join(roots[0].uri.fsPath, ".gitignore"),
      "ignored.yml\nroles/example/tasks/ignored.yml\n",
    );
    await writeFile(ignored.fsPath, await readFile(task.fsPath, "utf8"));
    const ignoredDocument = await vscode.workspace.openTextDocument(ignored);
    await vscode.window.showTextDocument(ignoredDocument, { preview: false });
    await editor.check(ignoredDocument, true);
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => renderer(ignored),
      "ignored explicitly checked primary must refresh on context events",
    );
    await writeFile(template.fsPath, good);
    await waitFor(() => !renderer(ignored), "ignored primary recovery");
    success("ignored explicit selections participate in dependency refresh");

    // An ignore control changes the admitted source set without any YAML edit.
    const newlyAdmitted = vscode.Uri.joinPath(
      roots[0].uri,
      "roles/example/tasks/admitted.yml",
    );
    const ignorePath = join(roots[0].uri.fsPath, ".gitignore");
    const ignoreText = await readFile(ignorePath, "utf8");
    await writeFile(
      ignorePath,
      ignoreText + "roles/example/tasks/admitted.yml\n",
    );
    await pause(350);
    await waitFor(
      () => findings(newlyAdmitted).length === 0,
      "excluded primary must leave saved coverage before admission changes",
    );
    await writeFile(ignorePath, ignoreText);
    await waitFor(
      () =>
        findings(newlyAdmitted).some((item) => item.code === "jinja-layout"),
      "ignore-control changes must discover previously excluded primaries",
    );
    await writeFile(template.fsPath, bad);
    await waitFor(
      () => renderer(ignored),
      "membership reconciliation must retain explicitly checked ignored dependencies",
    );
    await writeFile(template.fsPath, good);
    await waitFor(
      () => !renderer(ignored),
      "ignored primary recovery after membership reconciliation",
    );
    success(
      "Git ignore changes reconcile coverage and retain ignored explicit dependencies",
    );

    if (process.platform !== "win32") {
      const alias = vscode.Uri.joinPath(roots[0].uri, "task-alias.yml");
      await symlink(task.fsPath, alias.fsPath);
      const aliasDocument = await vscode.workspace.openTextDocument(alias);
      await vscode.window.showTextDocument(aliasDocument, { preview: false });
      await editor.check(aliasDocument, true);
      await writeFile(template.fsPath, bad);
      await waitFor(
        () => renderer(alias),
        "canonical template event must refresh an alias-owned primary",
      );
      await writeFile(template.fsPath, good);
      await waitFor(() => !renderer(alias), "alias recovery");
      await rm(alias.fsPath);
      success("canonical context events retain alias ownership");
    }

    await pause(500);
    count = invocations().length;
    const start = Date.now();
    for (let index = 0; index < 30; index++)
      await writeFile(template.fsPath, index % 2 === 0 ? bad : good);
    await pause(600);
    await waitFor(
      () => !renderer(task),
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

    const firstDocument = await vscode.workspace.openTextDocument(firstOpen);
    await vscode.window.showTextDocument(firstDocument, { preview: false });
    const firstFilename = await realpath(firstOpen.fsPath);
    const firstGate = join(temporary, "first-open-gate");
    await writeFile(firstGate, "");
    process.env.SALTBOX_TEST_PROCESS_GATE = firstGate;
    const firstCount = invocations().length;
    const firstCheck = editor.check(firstDocument);
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
    await writeFile(template.fsPath, bad);
    editor.removeFile(template);
    delete process.env.SALTBOX_TEST_PROCESS_GATE;
    await rm(firstGate);
    await firstCheck;
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
    await pause(400);

    // Hold an already-computed full scan, then change unknown context before its
    // first result is accepted. Cancellation must preserve eventual full coverage.
    editor.dispose();
    const gate = join(temporary, "scan-gate");
    await writeFile(gate, "");
    process.env.SALTBOX_TEST_PROCESS_GATE = gate;
    editor = new EditorIntegration(process.env.SALTBOX_TEST_FIXTURE_PATH!);
    await waitFor(
      () => existsSync(gate + ".ready"),
      "initial scan gate must receive old output",
    );
    await writeFile(template.fsPath, bad);
    await pause(150);
    await rm(gate);
    delete process.env.SALTBOX_TEST_PROCESS_GATE;
    await waitFor(
      () => renderer(task),
      "late context changes must reject the initial result and restore full coverage",
    );
    await writeFile(template.fsPath, good);
    await waitFor(() => !renderer(task), "late result recovery");
    success(
      "late context events reject in-flight scans and retain startup full coverage",
    );

    await rm(join(roots[0].uri.fsPath, ".saltbox-lint"));
    await waitFor(
      () => findings(task).length === 0 && findings(unrelatedUri).length === 0,
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
    await pause(150);
    await waitFor(async () => {
      const instances = fixtureProcesses(instancesLog);
      const pids = invocations().map((line) => Number(line.split(" ")[0]));
      if (instances.length !== pids.length) return false;
      assert.deepEqual(
        instances.map((instance) => instance.pid).sort((a, b) => a - b),
        pids.sort((a, b) => a - b),
        "every invocation must have a process lifetime identity",
      );
      const live = await Promise.all(instances.map(fixtureRunning));
      assert.equal(
        new Set(instances.map((instance) => instance.token)).size,
        instances.length,
      );
      cleanupStatus = instances.map((instance, index) => ({
        pid: instance.pid,
        token: instance.token,
        running: live[index],
      }));
      return !live.some(Boolean);
    }, "completed dependency checks must leave no fixture processes running");
    console.log(
      `MEASURE dependency cleanup observed_processes=${fixtureProcesses(instancesLog).length} surviving=0`,
    );
  } catch (error) {
    console.error("Dependency host process log:", invocations());
    console.error(
      "Dependency host process instances:",
      JSON.stringify(fixtureProcesses(instancesLog)),
    );
    console.error(
      "Dependency host cleanup status:",
      JSON.stringify(cleanupStatus),
    );
    throw error;
  } finally {
    editor.dispose();
    for (const subscription of subscriptions) subscription.dispose();
    delete process.env.SALTBOX_TEST_PROCESS_LOG;
    delete process.env.SALTBOX_TEST_PROCESS_INSTANCES;
    delete process.env.SALTBOX_TEST_PROCESS_GATE;
    delete process.env.SALTBOX_TEST_PROCESS_GATE_PREFIX;
    delete process.env.SALTBOX_TEST_PROCESS_GATE_NONCE;
    await rm(temporary, { recursive: true, force: true });
  }
}
