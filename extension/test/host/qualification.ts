import * as vscode from "vscode";
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  withTestResources,
  type TestResources,
} from "../support/test-resources.ts";
import { setTimeout as pause } from "node:timers/promises";
import { closeEditorTabs } from "../support/editor-tabs.ts";

export interface QualificationProcessAdapters {
  readDirectory: (directory: string) => PromiseLike<readonly string[]>;
  readCommandLine: (filename: string) => PromiseLike<string>;
}

// Linux qualification only. Scan this isolated container's processes by the
// exact installed executable, distinguishing them from Electron/SDK children.
export async function observeQualificationProcesses(
  executable: string,
  signal: AbortSignal,
  adapters: Partial<QualificationProcessAdapters> = {},
): Promise<number[]> {
  signal.throwIfAborted();
  const pids: number[] = [];
  const entries = await (adapters.readDirectory ?? readdir)("/proc");
  const commandLine =
    adapters.readCommandLine ??
    ((filename: string) => readFile(filename, "utf8"));
  for (const entry of entries) {
    signal.throwIfAborted();
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = await commandLine(`/proc/${entry}/cmdline`);
      if (command.split("\0")[0] === executable) pids.push(Number(entry));
    } catch (error) {
      // Only a disappeared process is absent. Permission/I/O errors leave its
      // ownership unknown and must not become an empty survivor set.
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ESRCH")
      ))
        throw error;
    }
  }
  return pids;
}

export async function runQualification(
  parentSignal?: AbortSignal,
  adapters: Partial<QualificationProcessAdapters> = {},
): Promise<void> {
  assert.equal(process.platform, "linux");
  await withTestResources(
    { cleanupTimeoutMs: 15000, operationSignal: parentSignal },
    (resources) => qualification(resources, adapters),
  );
  console.log(
    "PASS installed formatter: 100 requests, 20 idle checkpoints, close cleanup; raw editor latency and host resources recorded",
  );
}

async function qualification(
  resources: TestResources,
  adapters: Partial<QualificationProcessAdapters>,
): Promise<void> {
  const operation: TestResources["operation"] = (name, perform) =>
    resources.operation(name, (signal) => {
      signal.throwIfAborted();
      return perform(signal);
    });
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  await operation("qualification product activation", () => product.activate());
  const executable = join(product.extensionPath, "bin", "saltbox-lint");
  const directory = process.env.SALTBOX_QUALIFICATION_FIXTURES!;
  const destination = process.env.SALTBOX_QUALIFICATION_OUTPUT!;
  const root = vscode.workspace.workspaceFolders![0].uri;
  const uri = vscode.Uri.joinPath(root, "qualification.yml");
  await operation("qualification initial source", () =>
    vscode.workspace.fs.writeFile(uri, Buffer.from("value: initial\n")),
  );
  const document = await operation("qualification source document", () =>
    vscode.workspace.openTextDocument(uri),
  );
  await operation("qualification source editor", () =>
    vscode.window.showTextDocument(document, { preview: false }),
  );
  await operation("qualification initial check", () =>
    vscode.commands.executeCommand("saltboxLint.checkDocument"),
  );
  const settle = (milliseconds: number) =>
    operation("qualification settling", (signal) =>
      pause(milliseconds, undefined, { signal }),
    );
  const processes = () =>
    operation("qualification native process observation", (signal) =>
      observeQualificationProcesses(executable, signal, adapters),
    );
  await settle(500);
  assert.deepEqual(await processes(), [], "idle startup CLI");
  const samples: object[] = [];
  const resourceSamples: object[] = [];
  for (const name of [
    "diagnostic-heavy.yml",
    "flow-heavy.yml",
    "unicode.yml",
    "canonical.yml",
    "skipped.yml",
  ]) {
    const source = await operation("qualification fixture source", () =>
      readFile(join(directory, name), "utf8"),
    );
    const sha256 = createHash("sha256").update(source).digest("hex");
    assert.ok(Buffer.byteLength(source) <= 100 * 1024);
    for (let sample = 0; sample < 20; sample++) {
      const replacement = new vscode.WorkspaceEdit();
      replacement.replace(
        uri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        source,
      );
      assert.equal(
        await operation("qualification replace source", () =>
          vscode.workspace.applyEdit(replacement),
        ),
        true,
      );
      const started = performance.now();
      const edits = await operation("qualification installed format", () =>
        vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
          "vscode.executeFormatDocumentProvider",
          uri,
          {
            tabSize: 2,
            insertSpaces: true,
          },
        ),
      );
      const elapsed = performance.now() - started;
      if (
        ["diagnostic-heavy.yml", "flow-heavy.yml", "unicode.yml"].includes(name)
      )
        assert.ok(
          edits && edits.length > 0,
          `${name} must produce verified edits`,
        );
      else assert.equal(edits?.length ?? 0, 0);
      samples.push({
        name,
        sample,
        sha256,
        bytes: Buffer.byteLength(source),
        milliseconds: elapsed,
        edits: edits?.length ?? 0,
      });
      await operation("qualification sample output", () =>
        appendFile(
          destination + ".jsonl",
          JSON.stringify(samples.at(-1)) + "\n",
        ),
      );
      if (sample % 5 === 4) {
        await settle(100);
        const children = await processes();
        assert.deepEqual(children, [], "completed format left a CLI child");
        resourceSamples.push({
          name,
          sample,
          children,
          memory: process.memoryUsage(),
          handles: process.getActiveResourcesInfo(),
        });
      }
    }
  }
  await operation("qualification close tabs", (signal) =>
    closeEditorTabs(signal),
  );
  await settle(1000);
  assert.deepEqual(await processes(), [], "closed editor retained a CLI child");
  const finalChildren = await processes();
  await operation("qualification summary output", () =>
    writeFile(
      destination,
      JSON.stringify(
        {
          product: product.extensionPath,
          vscode: vscode.version,
          samples,
          resources: resourceSamples,
          finalMemory: process.memoryUsage(),
          finalChildren,
        },
        null,
        2,
      ) + "\n",
    ),
  );
}
