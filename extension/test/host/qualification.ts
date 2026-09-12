import * as vscode from "vscode";
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Linux qualification only. Scan this isolated container's processes by the
// exact installed executable, distinguishing them from Electron/SDK children.
async function ownedProcesses(executable: string): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (command.split("\0")[0] === executable) pids.push(Number(entry));
    } catch {
      // A process may exit between listing and reading its command line.
    }
  }
  return pids;
}

export async function runQualification(): Promise<void> {
  assert.equal(process.platform, "linux");
  const product = vscode.extensions.getExtension("saltyorg.saltbox-lint")!;
  await product.activate();
  const executable = join(product.extensionPath, "bin", "saltbox-lint");
  const directory = process.env.SALTBOX_QUALIFICATION_FIXTURES!;
  const destination = process.env.SALTBOX_QUALIFICATION_OUTPUT!;
  const root = vscode.workspace.workspaceFolders![0].uri;
  const uri = vscode.Uri.joinPath(root, "qualification.yml");
  await vscode.workspace.fs.writeFile(uri, Buffer.from("value: initial\n"));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand("saltboxLint.checkDocument");
  await pause(500);
  assert.deepEqual(await ownedProcesses(executable), [], "idle startup CLI");
  const samples: object[] = [];
  const resources: object[] = [];
  for (const name of [
    "diagnostic-heavy.yml",
    "flow-heavy.yml",
    "unicode.yml",
    "canonical.yml",
    "skipped.yml",
  ]) {
    const source = await readFile(join(directory, name), "utf8");
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
      assert.equal(await vscode.workspace.applyEdit(replacement), true);
      const started = performance.now();
      const edits = await vscode.commands.executeCommand<
        vscode.TextEdit[] | undefined
      >("vscode.executeFormatDocumentProvider", uri, {
        tabSize: 2,
        insertSpaces: true,
      });
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
      await appendFile(
        destination + ".jsonl",
        JSON.stringify(samples.at(-1)) + "\n",
      );
      if (sample % 5 === 4) {
        await pause(100);
        const children = await ownedProcesses(executable);
        assert.deepEqual(children, [], "completed format left a CLI child");
        resources.push({
          name,
          sample,
          children,
          memory: process.memoryUsage(),
          handles: process.getActiveResourcesInfo(),
        });
      }
    }
  }
  await vscode.window.tabGroups.close(
    vscode.window.tabGroups.all.flatMap((group) => group.tabs),
    true,
  );
  await pause(1000);
  assert.deepEqual(
    await ownedProcesses(executable),
    [],
    "closed editor retained a CLI child",
  );
  await writeFile(
    destination,
    JSON.stringify(
      {
        product: product.extensionPath,
        vscode: vscode.version,
        samples,
        resources,
        finalMemory: process.memoryUsage(),
        finalChildren: await ownedProcesses(executable),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PASS installed formatter: 100 requests, 20 idle checkpoints, close cleanup; raw editor latency and host resources recorded",
  );
}
