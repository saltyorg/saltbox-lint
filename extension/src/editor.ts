import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { identify, resolveSource } from "./identity.ts";
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
import { MarkedRoots } from "./roots.ts";

interface Snapshot extends Identity {
  uri: vscode.Uri;
  version: number;
  text: string;
  hash: string;
  folder: string;
  rootRevision: number;
  documentRevision: number;
  index: SnapshotIndex;
}
interface DocumentResult {
  id: string;
  snapshot: Snapshot;
  report: CheckReport;
  diagnostics: vscode.Diagnostic[];
}
function textEdits(edits: EditorEdit[]): vscode.TextEdit[] {
  return edits.map((edit) => vscode.TextEdit.replace(range(edit), edit.text));
}

export class EditorIntegration implements vscode.Disposable {
  private readonly roots = new MarkedRoots();
  private readonly eligibilityChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeEligibility = this.eligibilityChanged.event;
  private readonly rootListener: vscode.Disposable;
  private readonly lint = new Scheduler();
  private readonly formatting = new Scheduler();
  private readonly collection =
    vscode.languages.createDiagnosticCollection("saltbox-lint");
  private readonly output = vscode.window.createOutputChannel("Saltbox Lint");
  private readonly documents = new Map<string, DocumentResult>();
  private readonly scans = new Map<string, Map<string, vscode.Diagnostic[]>>();
  private readonly checking = new Map<string, Promise<void>>();
  private readonly rootRevisions = new Map<string, number>();
  private readonly documentRevisions = new WeakMap<
    vscode.TextDocument,
    number
  >();
  private readonly documentFolders = new Map<string, string>();
  private readonly sourceOwners = new Map<string, Identity>();
  private readonly canonicalRoots = new Map<string, string>();
  private readonly closedTabs = new Set<string>();
  private readonly pendingRefresh = new Set<string>();
  private nextRevision = 0;
  private relatedRevision = 0;
  private disposed = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly executable: string;
  constructor(executable: string) {
    this.executable = executable;
    this.rootListener = this.roots.onDidChange((folder) => {
      for (const [uri, owner] of this.documentFolders)
        if (owner === folder) this.sourceOwners.delete(uri);
      this.refreshFolders(new Set([folder]));
      this.eligibilityChanged.fire();
    });
    this.roots.configure();
  }
  private eligible(document: vscode.TextDocument): boolean {
    return (
      !this.disposed &&
      vscode.workspace.isTrusted &&
      !document.isClosed &&
      !this.closedTabs.has(document.uri.toString()) &&
      document.uri.scheme === "file" &&
      ["yaml", "ansible"].includes(document.languageId) &&
      /\.ya?ml$/i.test(document.uri.path) &&
      !!this.roots.get(
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? "",
      )
    );
  }
  private rootRevision(folder: string): number {
    if (!this.rootRevisions.has(folder))
      this.rootRevisions.set(folder, ++this.nextRevision);
    return this.rootRevisions.get(folder)!;
  }
  private documentRevision(document: vscode.TextDocument): number {
    if (!this.documentRevisions.has(document))
      this.documentRevisions.set(document, ++this.nextRevision);
    return this.documentRevisions.get(document)!;
  }
  configureRoots(): void {
    this.roots.configure();
  }
  providerDocuments(): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter(
      (document) =>
        this.eligible(document) &&
        this.sourceOwners.has(document.uri.toString()),
    );
  }
  private async root(
    folder: vscode.WorkspaceFolder,
  ): Promise<string | undefined> {
    await this.roots.ready();
    const root = this.roots.get(folder.uri.toString());
    if (root) this.canonicalRoots.set(folder.uri.toString(), root);
    return root;
  }
  private rememberSource(
    document: vscode.TextDocument,
    identity: Identity,
  ): void {
    this.sourceOwners.set(document.uri.toString(), identity);
    this.eligibilityChanged.fire();
    const canonical = vscode.Uri.file(identity.filename);
    if (canonical.toString() !== document.uri.toString())
      this.publish(canonical);
  }
  private async synchronizeSources(): Promise<void> {
    const live = new Set(
      vscode.workspace.textDocuments
        .filter(
          (document) =>
            !document.isClosed &&
            !!vscode.workspace.getWorkspaceFolder(document.uri),
        )
        .map((document) => document.uri.toString()),
    );
    for (const uri of this.sourceOwners.keys())
      if (!live.has(uri)) this.sourceOwners.delete(uri);
    for (const document of vscode.workspace.textDocuments) {
      if (
        document.isClosed ||
        document.uri.scheme !== "file" ||
        !["yaml", "ansible"].includes(document.languageId) ||
        !/\.ya?ml$/i.test(document.uri.path)
      )
        continue;
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) continue;
      const revision = this.rootRevision(folder.uri.toString());
      try {
        const root = await this.root(folder);
        if (!root) continue;
        const identity = await identify(root, document.uri.fsPath);
        if (
          revision === this.rootRevision(folder.uri.toString()) &&
          !document.isClosed
        ) {
          this.documentFolders.set(
            document.uri.toString(),
            folder.uri.toString(),
          );
          this.rememberSource(document, identity);
        }
      } catch {
        if (revision === this.rootRevision(folder.uri.toString()))
          this.sourceOwners.delete(document.uri.toString());
      }
    }
  }
  private async snapshot(
    document: vscode.TextDocument,
  ): Promise<Snapshot | undefined> {
    await this.roots.ready();
    if (!this.eligible(document)) return;
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)!
      .uri.toString();
    const rootRevision = this.rootRevision(folder);
    const documentRevision = this.documentRevision(document);
    this.documentFolders.set(document.uri.toString(), folder);
    const version = document.version;
    const text = document.getText();
    const root = await this.root(
      vscode.workspace.getWorkspaceFolder(document.uri)!,
    );
    if (!root) return;
    const identity = await identify(root, document.uri.fsPath);
    const snapshot = {
      ...identity,
      uri: document.uri,
      version,
      text,
      hash: hash(text),
      folder,
      rootRevision,
      documentRevision,
      index: new SnapshotIndex(text),
    };
    if (!this.current(document, snapshot)) return;
    this.rememberSource(document, identity);
    return snapshot;
  }
  private current(document: vscode.TextDocument, snapshot: Snapshot): boolean {
    return (
      this.eligible(document) &&
      snapshot.rootRevision === this.rootRevision(snapshot.folder) &&
      snapshot.documentRevision === this.documentRevision(document) &&
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
    if (
      document ||
      [...this.sourceOwners.values()].some(
        (owner) => vscode.Uri.file(owner.filename).toString() === key,
      )
    ) {
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
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    if (manual) void vscode.window.showErrorMessage(`Saltbox Lint: ${message}`);
  }
  async check(document: vscode.TextDocument, manual = false): Promise<void> {
    if (manual) {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (folder) await this.roots.refresh(folder.uri.toString());
    }
    await this.roots.ready();
    if (!this.eligible(document)) return;
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)!
      .uri.toString();
    const requestKey = `${document.uri}:${document.version}:${this.documentRevision(document)}:${this.rootRevision(folder)}`;
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
    const revision = this.documentRevision(document);
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)!
      .uri.toString();
    const rootRevision = this.rootRevision(folder);
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
      const relatedRevision = this.relatedRevision;
      const diagnostics = await renderDiagnostics(
        report.diagnostics,
        snapshot.index,
        snapshot.root,
      );
      if (!this.current(document, snapshot)) return;
      if (relatedRevision !== this.relatedRevision)
        for (const diagnostic of diagnostics)
          diagnostic.relatedInformation = undefined;
      this.documents.set(key, {
        id: randomUUID(),
        snapshot,
        report,
        diagnostics,
      });
      this.publish(document.uri);
    } catch (error) {
      if (
        this.disposed ||
        revision !== this.documentRevision(document) ||
        rootRevision !== this.rootRevision(folder)
      )
        return;
      this.documents.delete(key);
      this.publish(document.uri);
      this.error(error, manual);
    }
  }
  async checkWorkspace(): Promise<void> {
    if (!vscode.workspace.isTrusted || this.disposed) return;
    await this.roots.refresh();
    await this.roots.ready();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      const folderKey = folder.uri.toString();
      const revision = this.rootRevision(folderKey);
      try {
        const root = await this.root(folder);
        if (!root || revision !== this.rootRevision(folderKey)) continue;
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
        if (wire === undefined || revision !== this.rootRevision(folderKey))
          continue;
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
          const owner = vscode.workspace.getWorkspaceFolder(uri);
          if (owner && owner.uri.toString() !== folderKey) continue;
          const index = new SnapshotIndex(await readFile(filename, "utf8"));
          for (const fix of report.fixes.values())
            if (fix.path === relative) index.edits(fix.edits);
          entries.set(
            uri.toString(),
            await renderDiagnostics(findings, index, root),
          );
        }
        if (revision !== this.rootRevision(folderKey)) continue;
        await this.synchronizeSources();
        if (revision !== this.rootRevision(folderKey)) continue;
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
        arguments: [document.uri, result.snapshot.hash, fix.id, result.id],
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
    reportId: string,
  ): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) await this.roots.refresh(folder.uri.toString());
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString(),
    );
    const result = this.documents.get(uri.toString());
    if (
      !document ||
      !result ||
      result.id !== reportId ||
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
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)
      ?.uri.toString();
    if (!folder) return;
    await this.roots.refresh(folder);
    const revision = this.rootRevision(folder);
    const documentRevision = this.documentRevision(document);
    const edits = await this.format(document, "lint-fixes");
    if (
      !edits.length ||
      !this.eligible(document) ||
      document.version !== version ||
      hash(document.getText()) !== sourceHash ||
      revision !== this.rootRevision(folder) ||
      documentRevision !== this.documentRevision(document)
    )
      return;
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, edits);
    await vscode.workspace.applyEdit(edit);
  }
  change(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    if (
      !this.documentFolders.has(key) &&
      (document.uri.scheme !== "file" ||
        !/\.ya?ml$/i.test(document.uri.path) ||
        !vscode.workspace.getWorkspaceFolder(document.uri))
    )
      return;
    this.documentRevisions.set(document, ++this.nextRevision);
    this.relatedRevision++;
    this.lint.cancel(key);
    this.formatting.cancel(key);
    this.documents.delete(key);
    this.publish(document.uri);
    const identity = this.sourceOwners.get(key);
    if (identity) this.publish(vscode.Uri.file(identity.filename));
    // Saved related coordinates may now point into a dirty buffer. Primary
    // snapshots and proposals in other documents remain valid.
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
  open(document: vscode.TextDocument): void {
    this.closedTabs.delete(document.uri.toString());
    void this.check(document);
  }
  close(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const stillOwned = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) =>
        tabDocumentUris(tab).some((uri) => uri.toString() === key),
      ),
    );
    if (!document.isClosed && stillOwned) return;
    this.closedTabs.add(key);
    this.eligibilityChanged.fire();
    this.change(document);
    this.collection.delete(document.uri);
    if (document.isClosed) {
      this.closedTabs.delete(key);
      this.sourceOwners.delete(key);
      this.documentFolders.delete(key);
    }
  }
  refresh(uris?: readonly vscode.Uri[]): void {
    if (this.disposed) return;
    const affected = new Set<string>();
    if (!uris) {
      for (const folder of vscode.workspace.workspaceFolders ?? [])
        affected.add(folder.uri.toString());
      for (const folder of this.rootRevisions.keys()) affected.add(folder);
    } else {
      for (const uri of uris) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) affected.add(folder.uri.toString());
        if (this.rootRevisions.has(uri.toString()))
          affected.add(uri.toString());
        for (const [key, root] of this.canonicalRoots) {
          const relative = path.relative(root, uri.fsPath);
          if (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          )
            affected.add(key);
        }
      }
    }
    this.refreshFolders(affected);
  }
  private refreshFolders(affected: Set<string>): void {
    for (const folder of affected) {
      this.rootRevisions.set(folder, ++this.nextRevision);
      this.pendingRefresh.add(folder);
      this.lint.cancel(`workspace:${folder}`);
      const scan = this.scans.get(folder);
      this.scans.delete(folder);
      for (const uri of scan?.keys() ?? []) this.publish(vscode.Uri.parse(uri));
      for (const [uri, ownerFolder] of this.documentFolders) {
        if (ownerFolder !== folder) continue;
        this.lint.cancel(uri);
        this.formatting.cancel(uri);
        this.documents.delete(uri);
        this.collection.delete(vscode.Uri.parse(uri));
        if (
          !vscode.workspace.workspaceFolders?.some(
            (current) => current.uri.toString() === folder,
          )
        ) {
          this.sourceOwners.delete(uri);
          this.documentFolders.delete(uri);
        }
      }
    }
    if (!affected.size) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const pending = new Set(this.pendingRefresh);
      this.pendingRefresh.clear();
      for (const document of vscode.workspace.textDocuments) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const result = this.documents.get(document.uri.toString());
        if (
          folder &&
          pending.has(folder.uri.toString()) &&
          this.eligible(document) &&
          (!result || !this.current(document, result.snapshot))
        )
          void this.check(document);
      }
    }, 100);
  }
  dispose(): void {
    this.disposed = true;
    this.rootListener.dispose();
    this.roots.dispose();
    this.eligibilityChanged.dispose();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.lint.dispose();
    this.formatting.dispose();
    this.collection.dispose();
    this.output.dispose();
  }
}

export function tabDocumentUris(tab: vscode.Tab): readonly vscode.Uri[] {
  if (tab.input instanceof vscode.TabInputText) return [tab.input.uri];
  if (tab.input instanceof vscode.TabInputTextDiff)
    return [tab.input.original, tab.input.modified];
  return [];
}
