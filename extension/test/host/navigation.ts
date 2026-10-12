import * as vscode from "vscode";
import assert from "node:assert/strict";
import {
  symlinkSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { EditorIntegration } from "../../src/editor.ts";
import type { QueryReport } from "../../src/navigation-protocol.ts";
import {
  withTestResources,
  type TestResources,
} from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";
export function assertReferenceCanonicalOwner(
  referenceFilename: string,
  ownerFilename: string,
) {
  assert.equal(
    realpathSync.native(referenceFilename),
    realpathSync.native(ownerFilename),
  );
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
async function definitions(document: vscode.TextDocument, word = "_port") {
  return vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >(
    "vscode.executeDefinitionProvider",
    document.uri,
    document.positionAt(document.getText().indexOf(word) + 2),
  );
}
function target(location: vscode.Location | vscode.LocationLink) {
  return "uri" in location ? location.uri : location.targetUri;
}
function targetRange(location: vscode.Location | vscode.LocationLink) {
  return "range" in location ? location.range : location.targetSelectionRange;
}
async function waitFor(predicate: () => Promise<boolean>, message: string) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
async function runNestedNavigation(
  document: vscode.TextDocument,
  original: string,
) {
  for (const callee of ["lookup", "query", "q"]) {
    const nested =
      "# 😀é\r\n- debug:\r\n    msg: |\r\n      {{ " +
      callee +
      "('role_var', '_outer', role=" +
      callee +
      "('role_var', '_port', role='navtarget')) }}\r\n";
    await replace(document, nested);
    await waitFor(
      async () => (await definitions(document)).length === 3,
      "nested literal lookup resolves independently of outer dynamic call",
    );
    const start = nested.indexOf("_port"),
      position = document.positionAt(start + 2);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      position,
    );
    assert.ok(
      hovers.some((hover) =>
        hover.contents.some(
          (content) =>
            typeof content === "object" &&
            "value" in content &&
            content.value.includes("Literal&nbsp;source&nbsp;representation"),
        ),
      ),
    );
    assert.ok(
      hovers.some(
        (hover) =>
          hover.range &&
          document
            .getText(hover.range)
            .startsWith(callee + "('role_var', '_port'"),
      ),
    );
    let references: vscode.Location[] = [];
    await waitFor(async () => {
      references = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        document.uri,
        position,
      );
      return references.some(
        (location) =>
          location.uri.toString() === document.uri.toString() &&
          document
            .getText(location.range)
            .startsWith(callee + "('role_var', '_port'"),
      );
    }, "nested references accept the current inner lookup observation");
    assert.ok(
      references.some(
        (location) =>
          location.uri.toString() === document.uri.toString() &&
          document
            .getText(location.range)
            .startsWith(callee + "('role_var', '_port'"),
      ),
    );
    assert.deepEqual(await definitions(document, "_outer"), []);
    const outer = document.positionAt(nested.indexOf("_outer") + 2);
    assert.deepEqual(
      await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        document.uri,
        outer,
      ),
      [],
    );
    const outerItems =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        document.uri,
        outer,
      );
    assert.ok(
      !outerItems.items.some((item) =>
        item.detail?.includes("source declaration"),
      ),
    );
    await replace(document, nested.replace("'_port'", "'_po'"));
    const before = document.getText();
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      document.uri,
      document.positionAt(before.indexOf("_po") + 3),
    );
    const item = list.items.find(
      (item) =>
        item.label === "_port" && item.detail?.includes("source declaration"),
    );
    assert.ok(item?.textEdit);
    assert.equal(document.getText(item.textEdit.range), "_po");
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, [item.textEdit]);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.getText(), nested);
    await vscode.commands.executeCommand("undo");
    assert.equal(document.getText(), before);
    await replace(document, nested.replace("'navtarget'", "'navt'"));
    const roles = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      document.uri,
      document.positionAt(document.getText().indexOf("navt") + 4),
    );
    assert.ok(
      roles.items.some(
        (item) =>
          item.label === "navtarget" &&
          item.textEdit &&
          document.getText(item.textEdit.range) === "navt",
      ),
    );
  }
  await replace(document, original);
}
export async function runNavigation(parentSignal?: AbortSignal): Promise<void> {
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    navigation,
  );
}

async function navigation(resources: TestResources): Promise<void> {
  const roots = vscode.workspace.workspaceFolders!;
  const sourceURI = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/navsource/tasks/main.yml",
  );
  const document = await vscode.workspace.openTextDocument(sourceURI);
  const editor = await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  let locations: Awaited<ReturnType<typeof definitions>> = [];
  await waitFor(async () => {
    locations = await definitions(document);
    return locations.length === 3;
  }, "real definitions resolve all declaration layers");
  assert.equal(locations.length, 3);
  for (const location of locations) {
    const declaration = await vscode.workspace.openTextDocument(
      target(location),
    );
    assert.match(
      declaration.getText(targetRange(location)),
      /^(navtarget_role_port|navalias_port)$/,
    );
  }
  console.log(
    "PASS real packaged CLI definition includes cross-role alias and all declaration candidates with Unicode CRLF coordinates",
  );
  const position = document.positionAt(document.getText().indexOf("_port") + 2);
  // Opening declaration documents starts their real background checks. Wait
  // for navigation to accept a stable observation after those visible events.
  let hovers: vscode.Hover[] = [];
  await waitFor(async () => {
    hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      position,
    );
    return hovers.some((hover) =>
      hover.contents.some(
        (content) =>
          typeof content === "object" &&
          "value" in content &&
          content.value.includes("Literal&nbsp;source&nbsp;representation"),
      ),
    );
  }, "real hover accepts a stable source and target observation");
  const contents = hovers
    .flatMap((hover) => hover.contents)
    .filter(
      (content): content is vscode.MarkdownString =>
        typeof content === "object" && "value" in content,
    );
  assert.ok(
    contents.some(
      (content) =>
        content.value.includes("Literal&nbsp;source&nbsp;representation") &&
        content.value.includes("1234"),
    ),
  );
  assert.ok(
    contents.every(
      (content) => content.isTrusted !== true && !content.supportHtml,
    ),
  );
  assert.ok(
    contents.some(
      (content) =>
        content.value.includes("\\[untrusted\\]") &&
        content.value.includes("\\*\\*comment\\*\\*"),
    ),
  );
  console.log(
    "PASS real hover presents escaped comments and literal declarations with commands disabled",
  );
  // A visible source or context event can revoke an in-flight query.
  // Capture the accepted reference answer, as for definitions and hover above.
  let references: vscode.Location[] = [];
  await waitFor(async () => {
    references = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      document.uri,
      position,
    );
    return references.some(
      (location) => location.uri.toString() === document.uri.toString(),
    );
  }, "real references accept a current-document read observation");
  assert.ok(
    references.some(
      (location) => location.uri.toString() === document.uri.toString(),
    ),
  );
  const referenceAlias = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/readonly/templates/reverse.yaml",
  );
  const aliasLocation = references.find(
    (location) => location.uri.toString() === referenceAlias.toString(),
  );
  assert.ok(
    aliasLocation,
    "actual references retain the admitted template alias URI",
  );
  const canonicalAliasOwner = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/readonly/defaults/reverse.yml",
  );
  assertReferenceCanonicalOwner(
    aliasLocation.uri.fsPath,
    canonicalAliasOwner.fsPath,
  );
  assert.deepEqual(
    readFileSync(aliasLocation.uri.fsPath),
    readFileSync(canonicalAliasOwner.fsPath),
  );
  assert.equal(aliasLocation.range.start.line, 2);
  assert.equal(aliasLocation.range.start.character, 12);
  assert.equal(aliasLocation.range.end.line, 2);
  assert.equal(aliasLocation.range.end.character, 57);
  editor.selection = new vscode.Selection(position, position);
  const impact = await vscode.commands.executeCommand<QueryReport>(
    "saltboxLint.showImpact",
  );
  assert.equal(impact.coverage.complete, false);
  assert.ok(
    vscode.window.activeTextEditor?.document.uri.scheme.startsWith(
      "saltbox-lint-impact-",
    ),
  );
  assert.match(
    vscode.window.activeTextEditor!.document.getText(),
    /Coverage: incomplete/,
  );
  assert.ok(
    !vscode.window.activeTextEditor!.document.getText().includes("1234"),
  );
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.window.showTextDocument(document);
  const original = document.getText();
  await runNestedNavigation(document, original);
  await replace(document, original.replace("'_port'", "'_po'"));
  const before = document.getText();
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    document.uri,
    document.positionAt(before.indexOf("_po") + 3),
  );
  const item = list.items.find(
    (item) =>
      item.label === "_port" && item.detail?.includes("source declaration"),
  );
  assert.ok(item?.textEdit);
  const apply = new vscode.WorkspaceEdit();
  apply.set(document.uri, [item.textEdit]);
  await vscode.workspace.applyEdit(apply);
  assert.equal(document.getText(), before.replace("'_po'", "'_port'"));
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), before);
  await replace(document, original.replace("'navtarget'", "'navt'"));
  const roles = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    document.uri,
    document.positionAt(document.getText().indexOf("navt") + 4),
  );
  assert.ok(
    roles.items.some((item) => item.label === "navtarget" && item.textEdit),
  );
  await replace(document, original.replace("'navtarget'", "'navsource'"));
  assert.equal((await definitions(document)).length, 1);
  await replace(document, original.replace("'navtarget'", "'missing'"));
  assert.deepEqual(await definitions(document), []);
  await replace(document, original.replace("'_port'", "dynamic_suffix"));
  assert.deepEqual(await definitions(document, "dynamic_suffix"), []);
  await replace(document, original);
  console.log(
    "PASS real completion edits only active quoted literal with undo; same-role, dynamic and missing context stay explicit",
  );
  const targetURI = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/navtarget/defaults/main.yml",
  );
  const targetBytes = readFileSync(targetURI.fsPath);
  const openedTarget = await vscode.workspace.openTextDocument(targetURI);
  assert.equal(openedTarget.isDirty, false);
  assert.equal(readFileSync(targetURI.fsPath).equals(targetBytes), true);
  await vscode.window.showTextDocument(openedTarget, { preview: false });
  assert.equal(
    vscode.window.activeTextEditor?.document.uri.toString(),
    targetURI.toString(),
  );
  await vscode.commands.executeCommand("workbench.action.files.revert");
  assert.equal(openedTarget.isDirty, false);
  assert.equal(Buffer.from(openedTarget.getText()).equals(targetBytes), true);
  assert.equal(readFileSync(targetURI.fsPath).equals(targetBytes), true);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  const targetDocument = await vscode.workspace.openTextDocument(targetURI);
  assert.equal(targetDocument.isDirty, false);
  assert.equal(Buffer.from(targetDocument.getText()).equals(targetBytes), true);
  assert.equal(readFileSync(targetURI.fsPath).equals(targetBytes), true);
  await vscode.window.showTextDocument(document);
  const targetOriginal = targetDocument.getText();
  await replace(targetDocument, targetOriginal + "# unsaved context\n");
  assert.equal(targetDocument.isDirty, true);
  assert.deepEqual(await definitions(document), []);
  await replace(targetDocument, targetOriginal);
  assert.equal(await targetDocument.save(), true);
  assert.equal(targetDocument.isDirty, false);
  assert.equal(Buffer.from(targetDocument.getText()).equals(targetBytes), true);
  assert.equal(readFileSync(targetURI.fsPath).equals(targetBytes), true);
  await waitFor(
    async () => (await definitions(document)).length === 3,
    "saved target restores declarations",
  );
  const varsURI = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/navtarget/vars/main.yml",
  );
  await vscode.workspace.fs.delete(varsURI);
  await waitFor(
    async () => (await definitions(document)).length === 2,
    "deleted target declines location",
  );
  await vscode.workspace.fs.writeFile(
    varsURI,
    Buffer.from("navtarget_role_port: 5678\n"),
  );
  await waitFor(
    async () => (await definitions(document)).length === 3,
    "recreated target refreshes query",
  );
  const alias = join(roots[0].uri.fsPath, "navalias");
  symlinkSync(join(roots[0].uri.fsPath, "roles/navsource"), alias, "junction");
  const aliasDocument = await vscode.workspace.openTextDocument(
    vscode.Uri.file(join(alias, "tasks/main.yml")),
  );
  await vscode.window.showTextDocument(aliasDocument);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    async () => (await definitions(aliasDocument)).length === 3,
    "alias creation events settle before accepted canonical navigation",
  );
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  unlinkSync(alias);
  console.log(
    "PASS real queries reject dirty targets, refresh deletion and preserve source aliases",
  );
  const secondDocument = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(roots[1].uri, "roles/navsource/tasks/main.yml"),
  );
  await vscode.window.showTextDocument(secondDocument, { preview: false });
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  const secondTargetURI = vscode.Uri.joinPath(
    roots[1].uri,
    "roles/navtarget/defaults/main.yml",
  );
  const secondTarget = await vscode.workspace.openTextDocument(secondTargetURI);
  const secondTargetText = secondTarget.getText();
  assert.equal(secondTarget.isDirty, false);
  const secondTargetStat = lstatSync(secondTargetURI.fsPath, { bigint: true });
  let edited = false;
  try {
    let secondLocations: Awaited<ReturnType<typeof definitions>> = [];
    await waitFor(async () => {
      secondLocations = await definitions(secondDocument);
      return secondLocations.length === 3;
    }, "second root accepts its own navigation snapshot");
    assert.equal(secondLocations.length, 3);
    assert.ok(
      secondLocations.every((location) =>
        target(location).fsPath.startsWith(roots[1].uri.fsPath),
      ),
    );
    let observed = false;
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === secondTarget && event.contentChanges.length)
        observed = true;
    });
    try {
      edited = true;
      await replace(secondTarget, secondTargetText + "# later context edit\n");
      assert.equal(observed, true);
      assert.equal(secondTarget.isDirty, true);
    } finally {
      listener.dispose();
    }
    assert.deepEqual(await definitions(secondDocument), []);
  } finally {
    try {
      if (edited) {
        await vscode.window.showTextDocument(secondTarget);
        await vscode.commands.executeCommand("undo");
        assert.equal(secondTarget.getText(), secondTargetText);
        assert.equal(secondTarget.isDirty, false);
        const restored = lstatSync(secondTargetURI.fsPath, { bigint: true });
        assert.deepEqual(
          [restored.ino, restored.mtimeNs, restored.ctimeNs],
          [
            secondTargetStat.ino,
            secondTargetStat.mtimeNs,
            secondTargetStat.ctimeNs,
          ],
        );
        console.log(
          "SALTBOX_NAVIGATION_CONTROL undo restored exact clean target",
        );
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor",
        );
      }
    } finally {
      await vscode.window.showTextDocument(secondDocument);
    }
  }
  await waitFor(
    async () => (await definitions(secondDocument)).length === 3,
    "undo restores fresh second-root navigation acceptance",
  );
  await vscode.window.showTextDocument(document);
  const adapter = ownJoinedResource(
    resources,
    "navigation control adapter",
    new EditorIntegration(process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!),
  );
  try {
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    assert.deepEqual(
      await adapter.navigation.definition(
        document,
        position,
        cancellation.token,
      ),
      [],
    );
    cancellation.dispose();
    const staleToken = new vscode.CancellationTokenSource();
    const stale = adapter.navigation.definition(
      document,
      position,
      staleToken.token,
    );
    await replace(document, original + "# changed during request\r\n");
    adapter.change(document);
    assert.deepEqual(await stale, []);
    staleToken.dispose();
  } finally {
    adapter.dispose();
    await adapter.join();
  }
  await replace(document, original);
  const marker = vscode.Uri.joinPath(roots[0].uri, ".saltbox-lint");
  await vscode.workspace.fs.delete(marker);
  await waitFor(
    async () => (await definitions(document)).length === 0,
    "marker revokes navigation",
  );
  await vscode.workspace.fs.writeFile(marker, Buffer.alloc(0));
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    async () => (await definitions(document)).length === 3,
    "marker restores providers",
  );
  console.log(
    "PASS actual providers isolate roots and reject cancellation, stale source and removed marker",
  );
  const { runNavigationLifecycle } = await import("./navigation-lifecycle.ts");
  await runNavigationLifecycle(document, resources.signal);
  const reopened = await vscode.workspace.openTextDocument(sourceURI);
  await vscode.window.showTextDocument(reopened);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  const nested = join(roots[0].uri.fsPath, "navigation-nested");
  mkdirSync(join(nested, "roles/navsource/tasks"), { recursive: true });
  mkdirSync(join(nested, "roles/navtarget/defaults"), { recursive: true });
  writeFileSync(join(nested, ".saltbox-lint"), "");
  writeFileSync(join(nested, "roles/navsource/tasks/main.yml"), original);
  writeFileSync(
    join(nested, "roles/navtarget/defaults/main.yml"),
    "navtarget_role_port: 99\n",
  );
  await vscode.workspace
    .getConfiguration("saltboxLint", roots[0].uri)
    .update(
      "root",
      "navigation-nested",
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  const nestedDocument = await vscode.workspace.openTextDocument(
    vscode.Uri.file(join(nested, "roles/navsource/tasks/main.yml")),
  );
  await vscode.window.showTextDocument(nestedDocument);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    async () => (await definitions(nestedDocument)).length === 1,
    "nested root owns target",
  );
  assert.ok(
    (await definitions(nestedDocument)).every((location) =>
      target(location).fsPath.startsWith(nested),
    ),
  );
  assert.deepEqual(await definitions(document), []);
  await vscode.workspace
    .getConfiguration("saltboxLint", roots[0].uri)
    .update("root", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.window.showTextDocument(reopened);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    async () => (await definitions(reopened)).length === 3,
    "original root restored",
  );
  console.log("PASS real navigation respects configured nested source root");
}
