import * as vscode from "vscode";
import assert from "node:assert/strict";
import {
  symlinkSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  rmdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EditorIntegration } from "../../src/editor.ts";
import type { QueryReport } from "../../src/navigation-protocol.ts";

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
    const references = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      document.uri,
      position,
    );
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
async function runManualImpactFailure(document: vscode.TextDocument) {
  const original = document.getText();
  const temporary = await mkdtemp(
    join(tmpdir(), "saltbox-navigation-failure-"),
  );
  const wrapper = join(temporary, "failure.cjs");
  const payload = "PRIVATE_CHILD_RESPONSE_VARIABLE_1234";
  const failureMessage =
    "Static role lookup impact failed. Check the bundled CLI and try again.";
  await writeFile(
    wrapper,
    "const {spawnSync}=require('node:child_process'); const result=spawnSync(process.argv[2],process.argv.slice(3),{stdio:'inherit',env:process.env}); if(result.error)throw result.error; process.stderr.write(" +
      JSON.stringify(payload) +
      ");process.exit(2);\n",
  );
  const childProcess = createRequire(__filename)(
    "node:child_process",
  ) as typeof import("node:child_process");
  const spawnDescriptor = Object.getOwnPropertyDescriptor(
    childProcess,
    "spawn",
  )!;
  const spawn = childProcess.spawn;
  const outputDescriptor = Object.getOwnPropertyDescriptor(
    vscode.window,
    "createOutputChannel",
  )!;
  // VS Code assigns each extension its own API object. Observe the installed
  // command through the API belonging to its real extension path as well.
  const installed = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  const installedAPI = createRequire(
    join(installed.extensionPath, "package.json"),
  )("vscode") as typeof vscode;
  const noticeDescriptors = [
    ...new Set([vscode.window, installedAPI.window]),
  ].map((window) => ({
    window,
    descriptor: Object.getOwnPropertyDescriptor(window, "showErrorMessage")!,
  }));
  const createOutput = vscode.window.createOutputChannel;
  const lines: string[] = [],
    notices: string[] = [];
  const joins: Promise<void>[] = [];
  let adapter: EditorIntegration | undefined;
  try {
    Object.defineProperty(vscode.window, "createOutputChannel", {
      ...outputDescriptor,
      value: (...args: Parameters<typeof createOutput>) => {
        const channel = Reflect.apply(
          createOutput,
          vscode.window,
          args,
        ) as vscode.OutputChannel;
        return new Proxy(channel, {
          get(target, key) {
            if (key === "appendLine")
              return (line: string) => {
                lines.push(line);
                target.appendLine(line);
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function"
              ? (value.bind(target) as unknown)
              : value;
          },
        });
      },
    });
    for (const { window, descriptor } of noticeDescriptors)
      Object.defineProperty(window, "showErrorMessage", {
        ...descriptor,
        value: (message: string) => {
          notices.push(message);
          return Promise.resolve(undefined);
        },
      });
    Object.defineProperty(childProcess, "spawn", {
      ...spawnDescriptor,
      value: function (this: unknown, ...args: Parameters<typeof spawn>) {
        const [file, argv, options] = args;
        if (Array.isArray(argv) && argv[0] === "query") {
          const child = spawn(
            process.execPath,
            [wrapper, file, ...argv],
            options,
          );
          joins.push(
            new Promise<void>((resolve) =>
              child.once("close", () => resolve()),
            ),
          );
          return child;
        }
        return Reflect.apply(spawn, this, args);
      },
    });
    adapter = new EditorIntegration(
      process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!,
    );
    const position = document.positionAt(
      document.getText().indexOf("_port") + 2,
    );
    const token = new vscode.CancellationTokenSource();
    try {
      assert.deepEqual(
        await adapter.navigation.definition(document, position, token.token),
        [],
      );
      assert.deepEqual(
        lines.filter((line) => line === failureMessage),
        [],
      );
      assert.ok(!JSON.stringify(lines).includes(payload));
      assert.deepEqual(notices, []);
      assert.equal(await adapter.navigation.impact(), undefined);
      assert.deepEqual(
        lines.filter((line) => line === failureMessage),
        [failureMessage],
      );
      assert.ok(!JSON.stringify(lines).includes(payload));
      assert.deepEqual(notices, ["Saltbox Lint: " + failureMessage]);
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(position, position);
      assert.equal(
        await vscode.commands.executeCommand("saltboxLint.showImpact"),
        undefined,
      );
      assert.deepEqual(notices, [
        "Saltbox Lint: " + failureMessage,
        "Saltbox Lint: " + failureMessage,
      ]);
      assert.ok(!JSON.stringify({ lines, notices }).includes(payload));
      Object.defineProperty(childProcess, "spawn", spawnDescriptor);
      await replace(document, original.replace("'_port'", "dynamic_suffix"));
      editor.selection = new vscode.Selection(
        document.positionAt(document.getText().indexOf("dynamic_suffix") + 2),
        document.positionAt(document.getText().indexOf("dynamic_suffix") + 2),
      );
      const dynamic = await adapter.navigation.impact();
      assert.equal(dynamic?.state, "dynamic");
      // Root refreshes can also emit legitimate stale-context status lines.
      // The query must produce no additional failure or leaked child payload.
      assert.deepEqual(
        lines.filter((line) => line === failureMessage),
        [failureMessage],
      );
      assert.ok(!JSON.stringify(lines).includes(payload));
      assert.equal(notices.length, 2);
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
      await replace(document, original);
      await vscode.window.showTextDocument(document);
      const target = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(
          vscode.workspace.workspaceFolders![0].uri,
          "roles/navtarget/defaults/main.yml",
        ),
      );
      const targetOriginal = target.getText();
      const targetIdentity = lstatSync(target.uri.fsPath, { bigint: true });
      assert.equal(target.isDirty, false);
      await vscode.window.showTextDocument(target);
      await replace(target, targetOriginal + "# dirty manual target\n");
      await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(position, position);
      assert.equal(await adapter.navigation.impact(), undefined);
      // Root refreshes can also emit legitimate stale-context status lines.
      // The query must produce no additional failure or leaked child payload.
      assert.deepEqual(
        lines.filter((line) => line === failureMessage),
        [failureMessage],
      );
      assert.ok(!JSON.stringify(lines).includes(payload));
      assert.equal(notices.length, 2);
      // Restore the dirty-buffer control through the editor's undo stack. A
      // save of unchanged bytes would generate a delayed context notification
      // that can revoke the following manual marker control's first query.
      await vscode.window.showTextDocument(target);
      await vscode.commands.executeCommand("undo");
      assert.equal(target.getText(), targetOriginal);
      assert.equal(target.isDirty, false);
      const restoredIdentity = lstatSync(target.uri.fsPath, { bigint: true });
      assert.deepEqual(
        [
          restoredIdentity.ino,
          restoredIdentity.mtimeNs,
          restoredIdentity.ctimeNs,
        ],
        [targetIdentity.ino, targetIdentity.mtimeNs, targetIdentity.ctimeNs],
        "dirty-target refusal restores the buffer without a context disk write",
      );
      await vscode.window.showTextDocument(document);
    } finally {
      token.dispose();
    }
  } finally {
    adapter?.dispose();
    Object.defineProperty(childProcess, "spawn", spawnDescriptor);
    Object.defineProperty(
      vscode.window,
      "createOutputChannel",
      outputDescriptor,
    );
    for (const { window, descriptor } of noticeDescriptors)
      Object.defineProperty(window, "showErrorMessage", descriptor);
    await Promise.all(joins);
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function runManualMarkerRefresh(document: vscode.TextDocument) {
  const workspace = createRequire(__filename)("vscode")
    .workspace as typeof vscode.workspace;
  const descriptor = Object.getOwnPropertyDescriptor(
    workspace,
    "createFileSystemWatcher",
  )!;
  const original = workspace.createFileSystemWatcher;
  const marker = join(
    vscode.workspace.getWorkspaceFolder(document.uri)!.uri.fsPath,
    ".saltbox-lint",
  );
  const removeMarker = (missingAllowed = false) => {
    try {
      const stat = lstatSync(marker);
      // The fixture owns a single file, link or empty directory. Never walk
      // the parent-target junction while restoring this entry.
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmdirSync(marker);
      else unlinkSync(marker);
    } catch (error) {
      if (!missingAllowed || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
  };
  let adapter: EditorIntegration | undefined;
  // Hold this adapter's marker notifications throughout each manual command.
  // Its real marker probes and canonical-root admission still read the disk.
  Object.defineProperty(workspace, "createFileSystemWatcher", {
    ...descriptor,
    value: (...args: Parameters<typeof original>) => {
      const watcher = original(...args);
      const pattern = args[0];
      if (typeof pattern === "string" || pattern.pattern !== ".saltbox-lint")
        return watcher;
      return new Proxy(watcher, {
        get(target, key) {
          if (
            ["onDidCreate", "onDidChange", "onDidDelete"].includes(String(key))
          )
            return () => new vscode.Disposable(() => {});
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function"
            ? (value.bind(target) as unknown)
            : value;
        },
      });
    },
  });
  try {
    adapter = new EditorIntegration(
      process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!,
    );
  } finally {
    Object.defineProperty(workspace, "createFileSystemWatcher", descriptor);
  }
  const position = document.positionAt(document.getText().indexOf("_port") + 2);
  const impact = async () => {
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(position, position);
    const answer = await adapter.navigation.impact();
    if (answer)
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
    return answer;
  };
  const failures: Error[] = [];
  let replacement = "initial";
  let step = "initial admission";
  const failure = (error: unknown): Error => {
    let kind: string;
    try {
      const stat = lstatSync(marker);
      kind = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other";
    } catch (probe) {
      const code = (probe as NodeJS.ErrnoException).code;
      kind = code === "ENOENT" ? "missing" : `unavailable(${code})`;
    }
    return new Error(
      `manual marker ${step}: replacement=${replacement} marker=${kind}`,
      { cause: error },
    );
  };
  try {
    await waitFor(
      async () => !!(await impact()),
      "manual marker control starts eligible",
    );
    for (replacement of ["removed", "symlink", "directory"]) {
      step = "remove regular marker";
      removeMarker();
      step = "install replacement";
      if (replacement === "symlink")
        symlinkSync(join(marker, ".."), marker, "junction");
      if (replacement === "directory") mkdirSync(marker);
      step = "reject replacement";
      assert.equal(
        await impact(),
        undefined,
        `manual impact refuses ${replacement} marker before watcher delivery`,
      );
      assert.equal(
        vscode.window.activeTextEditor?.document.uri.toString(),
        document.uri.toString(),
      );
      step = "remove replacement";
      removeMarker(true);
      step = "restore regular marker";
      writeFileSync(marker, "");
      step = "accept restored marker";
      assert.ok(
        await impact(),
        `first manual impact accepts restored marker after ${replacement} without watcher delivery`,
      );
    }
    // A real context event during response validation still revokes the query.
    // Keep this distinct from the marker probe's controlled lack of delivery.
    const contextPromises = createRequire(__filename)(
      "node:fs/promises",
    ) as typeof import("node:fs/promises");
    const readDescriptor = Object.getOwnPropertyDescriptor(
      contextPromises,
      "readFile",
    )!;
    const originalRead = contextPromises.readFile;
    const context = vscode.Uri.joinPath(
      vscode.workspace.getWorkspaceFolder(document.uri)!.uri,
      "roles/navtarget/defaults/main.yml",
    );
    const contextBytes = await contextPromises.readFile(context.fsPath);
    const sourceFilename = realpathSync.native(document.uri.fsPath);
    const childProcess = createRequire(__filename)(
      "node:child_process",
    ) as typeof import("node:child_process");
    const spawnDescriptor = Object.getOwnPropertyDescriptor(
      childProcess,
      "spawn",
    )!;
    const originalSpawn = childProcess.spawn;
    const contextJoins: Promise<void>[] = [];
    let responseClosed = false;
    let delivered = false;
    step = "context event during response validation";
    Object.defineProperty(childProcess, "spawn", {
      ...spawnDescriptor,
      value: (...args: Parameters<typeof originalSpawn>) => {
        const child = Reflect.apply(originalSpawn, childProcess, args);
        const [file, argv] = args;
        if (
          file === process.env.SALTBOX_TEST_INSTALLED_CLI_PATH &&
          Array.isArray(argv) &&
          argv[0] === "query" &&
          argv.includes("references") &&
          argv.includes(sourceFilename)
        )
          contextJoins.push(
            new Promise<void>((resolve) => {
              child.once("close", () => {
                responseClosed = true;
                resolve();
              });
            }),
          );
        return child;
      },
    });
    Object.defineProperty(contextPromises, "readFile", {
      ...readDescriptor,
      value: async (...args: Parameters<typeof originalRead>) => {
        const bytes = await Reflect.apply(originalRead, contextPromises, args);
        if (responseClosed && !delivered && args[0] === context.fsPath) {
          delivered = true;
          await contextPromises.writeFile(
            context.fsPath,
            Buffer.concat([
              contextBytes,
              Buffer.from("# changed query context\n"),
            ]),
          );
          adapter.refresh([context]);
        }
        return bytes;
      },
    });
    try {
      assert.equal(await impact(), undefined);
      assert.equal(
        contextJoins.length,
        1,
        "the exact query owns the response gate",
      );
      assert.equal(delivered, true, "real target validation reaches the event");
      assert.equal(
        vscode.window.activeTextEditor?.document.uri.toString(),
        document.uri.toString(),
      );
    } finally {
      Object.defineProperty(contextPromises, "readFile", readDescriptor);
      Object.defineProperty(childProcess, "spawn", spawnDescriptor);
      try {
        if (delivered)
          await contextPromises.writeFile(context.fsPath, contextBytes);
      } finally {
        await Promise.all(contextJoins);
      }
    }
    const promises = createRequire(__filename)(
      "node:fs/promises",
    ) as typeof import("node:fs/promises");
    const lstatDescriptor = Object.getOwnPropertyDescriptor(promises, "lstat")!;
    const originalLstat = promises.lstat;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalText = document.getText();
    step = "edit during marker refresh";
    Object.defineProperty(promises, "lstat", {
      ...lstatDescriptor,
      value: async (...args: Parameters<typeof originalLstat>) => {
        if (args[0] === marker) {
          entered();
          await delayed;
        }
        return Reflect.apply(originalLstat, promises, args);
      },
    });
    let pending: ReturnType<typeof impact> | undefined;
    try {
      pending = impact();
      await started;
      await replace(
        document,
        "# edit during manual marker refresh\n" + originalText,
      );
      release();
      assert.equal(
        await pending,
        undefined,
        "edit during marker refresh declines the old cursor",
      );
    } finally {
      release();
      await pending;
      Object.defineProperty(promises, "lstat", lstatDescriptor);
      await replace(document, originalText);
    }
  } catch (error) {
    failures.push(failure(error));
  } finally {
    step = "cleanup restore marker";
    try {
      removeMarker(true);
      writeFileSync(marker, "");
    } catch (error) {
      failures.push(failure(error));
    } finally {
      adapter.dispose();
      await vscode.window.showTextDocument(document);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "manual marker body and cleanup failed");
}
export async function runNavigation(): Promise<void> {
  const roots = vscode.workspace.workspaceFolders!;
  const sourceURI = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/navsource/tasks/main.yml",
  );
  const document = await vscode.workspace.openTextDocument(sourceURI);
  const editor = await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    async () => (await definitions(document)).length === 3,
    "real definitions resolve all declaration layers",
  );
  const locations = await definitions(document);
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
  await waitFor(async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
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
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    document.uri,
    position,
  );
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
  const references = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    document.uri,
    position,
  );
  assert.ok(
    references.some(
      (location) => location.uri.toString() === document.uri.toString(),
    ),
  );
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
  // Keep the manual control's context writes beside the existing target-save
  // acceptance checks, after the source-only completion and undo assertions.
  await runManualImpactFailure(document);
  await runManualMarkerRefresh(document);
  const targetURI = vscode.Uri.joinPath(
    roots[0].uri,
    "roles/navtarget/defaults/main.yml",
  );
  const targetDocument = await vscode.workspace.openTextDocument(targetURI),
    targetOriginal = targetDocument.getText();
  await replace(targetDocument, targetOriginal + "# unsaved context\n");
  assert.deepEqual(await definitions(document), []);
  await replace(targetDocument, targetOriginal);
  await targetDocument.save();
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
  await vscode.window.showTextDocument(secondDocument);
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await waitFor(
    async () => (await definitions(secondDocument)).length === 3,
    "second root accepts its own navigation snapshot",
  );
  const secondLocations = await definitions(secondDocument);
  assert.equal(secondLocations.length, 3);
  assert.ok(
    secondLocations.every((location) =>
      target(location).fsPath.startsWith(roots[1].uri.fsPath),
    ),
  );
  await vscode.window.showTextDocument(document);
  const adapter = new EditorIntegration(
    process.env.SALTBOX_TEST_INSTALLED_CLI_PATH!,
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
  await runNavigationLifecycle(document);
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
