import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { canonicalRoot, identify, resolveSource } from "./identity.ts";
import type { Identity } from "./identity.ts";
import { hash, parseCheck, parseFormat, SnapshotIndex } from "./protocol.ts";
import type {
  CheckReport,
  EditorEdit,
  Finding,
  SharedFix,
} from "./protocol.ts";
import { runProcess } from "./process.ts";
import { range, renderDiagnostics } from "./diagnostics.ts";
import { Scheduler } from "./scheduler.ts";

interface Snapshot extends Identity {
  uri: vscode.Uri;
  version: number;
  text: string;
  hash: string;
  generation: number;
  index: SnapshotIndex;
}
interface DocumentResult {
  snapshot: Snapshot;
  report: CheckReport;
  diagnostics: vscode.Diagnostic[];
}
function textEdits(edits: EditorEdit[]): vscode.TextEdit[] {
  return edits.map((edit) => vscode.TextEdit.replace(range(edit), edit.text));
}

export class EditorIntegration implements vscode.Disposable {
  private readonly lint = new Scheduler();
  private readonly formatting = new Scheduler();
  private readonly collection =
    vscode.languages.createDiagnosticCollection("saltbox-lint");
  private readonly output = vscode.window.createOutputChannel("Saltbox Lint");
  private readonly documents = new Map<string, DocumentResult>();
  private readonly scans = new Map<string, Map<string, vscode.Diagnostic[]>>();
  private readonly checking = new Map<string, Promise<void>>();
  private generation = 0;
  private disposed = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly executable: string;
  constructor(executable: string) {
    this.executable = executable;
  }
  private eligible(document: vscode.TextDocument): boolean {
    return (
      !this.disposed &&
      vscode.workspace.isTrusted &&
      !document.isClosed &&
      document.uri.scheme === "file" &&
      ["yaml", "ansible"].includes(document.languageId) &&
      /\.ya?ml$/i.test(document.uri.path) &&
      !!vscode.workspace.getWorkspaceFolder(document.uri)
    );
  }
  private async root(folder: vscode.WorkspaceFolder): Promise<string> {
    return canonicalRoot(
      folder.uri.fsPath,
      vscode.workspace
        .getConfiguration("saltboxLint", folder.uri)
        .get<string>("root", ""),
    );
  }
  private async snapshot(
    document: vscode.TextDocument,
  ): Promise<Snapshot | undefined> {
    if (!this.eligible(document)) return;
    const generation = this.generation;
    const version = document.version;
    const text = document.getText();
    const identity = await identify(
      await this.root(vscode.workspace.getWorkspaceFolder(document.uri)!),
      document.uri.fsPath,
    );
    const snapshot = {
      ...identity,
      uri: document.uri,
      version,
      text,
      hash: hash(text),
      generation,
      index: new SnapshotIndex(text),
    };
    return this.current(document, snapshot) ? snapshot : undefined;
  }
  private current(document: vscode.TextDocument, snapshot: Snapshot): boolean {
    return (
      this.eligible(document) &&
      snapshot.generation === this.generation &&
      document.version === snapshot.version &&
      hash(document.getText()) === snapshot.hash
    );
  }
  private publish(uri: vscode.Uri): void {
    const key = uri.toString();
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === key,
    );
    const own = this.documents.get(key);
    if (own) {
      this.collection.set(uri, own.diagnostics);
      return;
    }
    if (document) {
      this.collection.delete(uri);
      return;
    }
    for (const scan of this.scans.values()) {
      const diagnostics = scan.get(key);
      if (diagnostics) {
        this.collection.set(uri, diagnostics);
        return;
      }
    }
    this.collection.delete(uri);
  }
  private error(error: unknown, manual: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    if (manual) void vscode.window.showErrorMessage(`Saltbox Lint: ${message}`);
  }
  async check(document: vscode.TextDocument, manual = false): Promise<void> {
    if (!this.eligible(document)) return;
    const requestKey = `${document.uri}:${document.version}:${this.generation}`;
    const existing = this.checking.get(requestKey);
    if (existing) return existing;
    const work = this.checkSnapshot(document, manual);
    this.checking.set(requestKey, work);
    try {
      await work;
    } finally {
      if (this.checking.get(requestKey) === work)
        this.checking.delete(requestKey);
    }
  }
  private async checkSnapshot(
    document: vscode.TextDocument,
    manual: boolean,
  ): Promise<void> {
    const key = document.uri.toString();
    try {
      const snapshot = await this.snapshot(document);
      if (!snapshot) return;
      const wire = await this.lint.submit(key, manual ? 2 : 1, (signal) =>
        runProcess(
          {
            executable: this.executable,
            cwd: snapshot.root,
            args: [
              "check",
              "--root",
              snapshot.root,
              "--stdin-filename",
              snapshot.filename,
              "--format",
              "json",
              "-",
            ],
            input: snapshot.text,
            successCodes: [0, 1],
          },
          signal,
        ),
      );
      if (wire === undefined || !this.current(document, snapshot)) return;
      const report = parseCheck(wire);
      if (
        report.diagnostics.some((finding) => finding.path !== snapshot.path) ||
        [...report.fixes.values()].some((fix) => fix.path !== snapshot.path)
      )
        throw new Error("Check returned an unselected source");
      for (const fix of report.fixes.values()) snapshot.index.edits(fix.edits);
      const diagnostics = await renderDiagnostics(
        report.diagnostics,
        snapshot.index,
        snapshot.root,
      );
      if (!this.current(document, snapshot)) return;
      this.documents.set(key, { snapshot, report, diagnostics });
      this.publish(document.uri);
    } catch (error) {
      this.documents.delete(key);
      this.publish(document.uri);
      this.error(error, manual);
    }
  }
  async checkWorkspace(): Promise<void> {
    if (!vscode.workspace.isTrusted || this.disposed) return;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      const generation = this.generation;
      try {
        const root = await this.root(folder);
        const wire = await this.lint.submit(
          `workspace:${folder.uri}`,
          0,
          (signal) =>
            runProcess(
              {
                executable: this.executable,
                cwd: root,
                args: ["check", "--root", root, "--format", "json", "."],
                successCodes: [0, 1],
              },
              signal,
            ),
        );
        if (wire === undefined || generation !== this.generation) continue;
        const report = parseCheck(wire);
        const grouped = new Map<string, Finding[]>();
        for (const finding of report.diagnostics) {
          const group = grouped.get(finding.path) ?? [];
          group.push(finding);
          grouped.set(finding.path, group);
        }
        const entries = new Map<string, vscode.Diagnostic[]>();
        for (const [relative, findings] of grouped) {
          const filename = await resolveSource(root, relative);
          const uri = vscode.Uri.file(filename);
          const index = new SnapshotIndex(await readFile(filename, "utf8"));
          for (const fix of report.fixes.values())
            if (fix.path === relative) index.edits(fix.edits);
          entries.set(
            uri.toString(),
            await renderDiagnostics(findings, index, root),
          );
        }
        if (generation !== this.generation) continue;
        const previous = this.scans.get(folder.uri.toString());
        this.scans.set(folder.uri.toString(), entries);
        for (const uri of new Set([
          ...(previous?.keys() ?? []),
          ...entries.keys(),
        ]))
          this.publish(vscode.Uri.parse(uri));
      } catch (error) {
        this.error(error, true);
      }
    }
  }
  actions(
    document: vscode.TextDocument,
    requested: vscode.Range,
  ): vscode.CodeAction[] {
    const result = this.documents.get(document.uri.toString());
    if (!result || !this.current(document, result.snapshot)) return [];
    const actions: vscode.CodeAction[] = [];
    const seen = new Set<string>();
    result.report.diagnostics.forEach((finding, index) => {
      if (
        !finding.fix_id ||
        seen.has(finding.fix_id) ||
        !result.diagnostics[index].range.intersection(requested)
      )
        return;
      seen.add(finding.fix_id);
      const fix = result.report.fixes.get(finding.fix_id)!;
      const action = new vscode.CodeAction(
        `Saltbox Lint: ${fix.message} (this file)`,
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = result.report.diagnostics.flatMap((other, i) =>
        other.fix_id === fix.id ? [result.diagnostics[i]] : [],
      );
      action.command = {
        command: "saltboxLint.applySharedFix",
        title: action.title,
        arguments: [document.uri, result.snapshot.hash, fix.id],
      };
      actions.push(action);
    });
    const all = new vscode.CodeAction(
      "Saltbox Lint: Fix All in Document",
      vscode.CodeActionKind.SourceFixAll.append("saltboxLint"),
    );
    all.command = {
      command: "saltboxLint.fixAll",
      title: all.title,
      arguments: [document.uri],
    };
    actions.push(all);
    return actions;
  }
  async applyShared(
    uri: vscode.Uri,
    expectedHash: string,
    id: string,
  ): Promise<void> {
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString(),
    );
    const result = this.documents.get(uri.toString());
    if (
      !document ||
      !result ||
      result.snapshot.hash !== expectedHash ||
      !this.current(document, result.snapshot)
    )
      return;
    const fix: SharedFix | undefined = result.report.fixes.get(id);
    if (!fix || fix.path !== result.snapshot.path) return;
    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, textEdits(result.snapshot.index.edits(fix.edits)));
    if (!this.current(document, result.snapshot)) return;
    await vscode.workspace.applyEdit(edit);
  }
  async format(
    document: vscode.TextDocument,
    mode: "canonical" | "lint-fixes",
    token?: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    if (token?.isCancellationRequested) return [];
    const abort = new AbortController();
    const listener = token?.onCancellationRequested(() => abort.abort());
    try {
      const snapshot = await this.snapshot(document);
      if (!snapshot || abort.signal.aborted) return [];
      const wire = await this.formatting.submit(
        document.uri.toString(),
        mode === "canonical" ? 2 : 1,
        (signal) =>
          runProcess(
            {
              executable: this.executable,
              cwd: snapshot.root,
              args: [
                "format",
                "--root",
                snapshot.root,
                "--stdin-filename",
                snapshot.filename,
                "--mode",
                mode,
                "-",
              ],
              input: snapshot.text,
            },
            signal,
          ),
        abort.signal,
      );
      if (
        wire === undefined ||
        abort.signal.aborted ||
        !this.current(document, snapshot)
      )
        return [];
      const plan = parseFormat(wire, snapshot.path, snapshot.text);
      if (plan.status === "skipped")
        this.output.appendLine(`Skipped ${snapshot.path}: ${plan.reason}`);
      return this.current(document, snapshot) ? textEdits(plan.edits) : [];
    } catch (error) {
      if (!abort.signal.aborted) this.error(error, true);
      return [];
    } finally {
      listener?.dispose();
    }
  }
  async fixAll(uri?: vscode.Uri): Promise<void> {
    const document = uri
      ? vscode.workspace.textDocuments.find(
          (doc) => doc.uri.toString() === uri.toString(),
        )
      : vscode.window.activeTextEditor?.document;
    if (!document) return;
    const version = document.version;
    const sourceHash = hash(document.getText());
    const generation = this.generation;
    const edits = await this.format(document, "lint-fixes");
    if (
      !edits.length ||
      !this.eligible(document) ||
      document.version !== version ||
      hash(document.getText()) !== sourceHash ||
      generation !== this.generation
    )
      return;
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, edits);
    await vscode.workspace.applyEdit(edit);
  }
  change(document: vscode.TextDocument): void {
    this.generation++;
    const key = document.uri.toString();
    this.lint.cancel(key);
    this.formatting.cancel(key);
    this.documents.delete(key);
    this.publish(document.uri);
    // Related locations came from disk, and cannot be shown against newly dirty buffers.
    this.collection.forEach((uri, diagnostics) => {
      if (diagnostics.some((d) => d.relatedInformation?.length))
        this.collection.set(
          uri,
          diagnostics.map((d) => {
            d.relatedInformation = undefined;
            return d;
          }),
        );
    });
  }
  close(document: vscode.TextDocument): void {
    this.change(document);
    this.collection.delete(document.uri);
  }
  refresh(): void {
    this.generation++;
    this.lint.cancelAll();
    this.formatting.cancelAll();
    this.documents.clear();
    this.scans.clear();
    this.collection.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      for (const document of vscode.workspace.textDocuments)
        void this.check(document);
    }, 100);
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.lint.dispose();
    this.formatting.dispose();
    this.collection.dispose();
    this.output.dispose();
  }
}
