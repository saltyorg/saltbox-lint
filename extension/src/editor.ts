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
  private readonly fileListener: vscode.Disposable;
  private readonly displayListeners: vscode.Disposable;
  private activeFile = vscode.window.activeTextEditor?.document.uri;
  private activeProjectOnly = this.displayActiveProjectOnly();
  private readonly lint = new Scheduler("retain");
  private readonly formatting = new Scheduler();
  private readonly collection =
    vscode.languages.createDiagnosticCollection("saltbox-lint");
  private readonly output = vscode.window.createOutputChannel("Saltbox Lint");
  private readonly documents = new Map<string, DocumentResult>();
  private readonly scans = new Map<string, Map<string, vscode.Diagnostic[]>>();
  private readonly completeScans = new Set<string>();
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
  private readonly pendingFiles = new Map<
    string,
    { uri: vscode.Uri; force: boolean; version?: number }
  >();
  private readonly fileFingerprints = new Map<string, string>();
  private readonly pendingDiskReload = new Set<string>();
  private readonly missingFiles = new Map<string, string | undefined>();
  private readonly scanRevisions = new Map<string, number>();
  private fileTimer?: ReturnType<typeof setTimeout>;
  private flushingFiles = false;
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
      this.repaint();
      this.eligibilityChanged.fire();
    });
    this.fileListener = this.roots.onDidChangeFile((uri) =>
      this.queueFile(uri),
    );
    if (this.activeFile?.scheme !== "file") this.activeFile = undefined;
    this.displayListeners = vscode.Disposable.from(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.uri.scheme !== "file") return;
        this.activeFile = editor.document.uri;
        this.repaint();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("saltboxLint.activeProjectOnly"))
          return;
        this.activeProjectOnly = this.displayActiveProjectOnly();
        this.repaint();
      }),
    );
    this.roots.configure();
  }
  private displayActiveProjectOnly(): boolean {
    return vscode.workspace
      .getConfiguration("saltboxLint")
      .get<boolean>("activeProjectOnly", true);
  }
  private repaint(): void {
    const uris = new Set(this.documents.keys());
    for (const scan of this.scans.values())
      for (const uri of scan.keys()) uris.add(uri);
    this.collection.forEach((uri) => uris.add(uri.toString()));
    for (const uri of uris) this.publish(vscode.Uri.parse(uri));
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
    this.repaint();
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
    expectedVersion?: number,
  ): Promise<Snapshot | undefined> {
    await this.roots.ready();
    if (expectedVersion !== undefined && document.version !== expectedVersion)
      return;
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
    const folder = this.roots.folder(uri)?.uri.toString();
    const activeFolder =
      this.activeFile && this.roots.folder(this.activeFile)?.uri.toString();
    if (
      !folder ||
      !this.roots.get(folder) ||
      (this.activeProjectOnly && this.activeFile && folder !== activeFolder)
    ) {
      this.collection.delete(uri);
      return;
    }
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
    const diagnostics = this.scans.get(folder)?.get(key);
    if (diagnostics) {
      this.collection.set(uri, diagnostics);
      return;
    }
    this.collection.delete(uri);
  }
  private error(error: unknown, manual: boolean): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    if (manual) void vscode.window.showErrorMessage(`Saltbox Lint: ${message}`);
  }
  async check(
    document: vscode.TextDocument,
    manual = false,
    expectedVersion?: number,
  ): Promise<void> {
    const version = expectedVersion ?? document.version;
    const revision = this.documentRevision(document);
    if (manual) {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (folder) await this.roots.refresh(folder.uri.toString());
    }
    await this.roots.ready();
    if (
      document.version !== version ||
      this.documentRevision(document) !== revision
    )
      return;
    if (!this.eligible(document)) return;
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)!
      .uri.toString();
    const requestKey = `${document.uri}:${version}:${revision}:${this.rootRevision(folder)}`;
    const existing = this.checking.get(requestKey);
    if (existing) return existing;
    const work = this.checkSnapshot(document, manual, version);
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
    version: number,
  ): Promise<void> {
    const key = document.uri.toString();
    const revision = this.documentRevision(document);
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)!
      .uri.toString();
    const rootRevision = this.rootRevision(folder);
    // Ownership must exist while the request is queued, before any source copy.
    this.documentFolders.set(key, folder);
    const current = () =>
      this.eligible(document) &&
      document.version === version &&
      revision === this.documentRevision(document) &&
      rootRevision === this.rootRevision(folder);
    try {
      const result = await this.lint.submit(
        key,
        manual ? 2 : 1,
        async (signal) => {
          if (signal.aborted || !current()) return;
          const snapshot = await this.snapshot(document, version);
          if (!snapshot || signal.aborted || !current()) return;
          const wire = await runProcess(
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
          );
          return { wire, snapshot };
        },
      );
      if (!result || !current()) return;
      const { wire, snapshot } = result;
      if (!this.current(document, snapshot)) return;
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
      if (current()) this.error(error, manual);
    }
  }
  async checkWorkspace(): Promise<void> {
    if (!vscode.workspace.isTrusted || this.disposed) return;
    await this.roots.refresh();
    await this.roots.ready();
    for (const folder of vscode.workspace.workspaceFolders ?? [])
      await this.checkSaved(folder, true);
    for (const document of vscode.workspace.textDocuments)
      if (!document.isDirty && this.eligible(document))
        await this.check(document, false, document.version);
  }
  private async checkSaved(
    folder: vscode.WorkspaceFolder,
    manual: boolean,
    selected?: Map<string, { filename: string; text: string; uri: vscode.Uri }>,
  ): Promise<Set<string> | undefined> {
    if (folder.uri.scheme !== "file" || this.disposed) return;
    const folderKey = folder.uri.toString();
    const revision = this.rootRevision(folderKey);
    const scanRevision = this.scanRevisions.get(folderKey);
    const current = () =>
      !this.disposed &&
      revision === this.rootRevision(folderKey) &&
      (selected !== undefined ||
        scanRevision === this.scanRevisions.get(folderKey));
    try {
      const root = await this.root(folder);
      if (!root || !current()) return;
      const wire = await this.lint.submit(
        `${selected ? "files" : "workspace"}:${folder.uri}`,
        0,
        async (signal) => {
          if (!current() || !this.roots.get(folderKey)) return;
          return runProcess(
            {
              executable: this.executable,
              cwd: root,
              args: [
                "check",
                "--root",
                root,
                "--format",
                "json",
                "--",
                ...(selected ? selected.keys() : ["."]),
              ],
              successCodes: [0, 1],
            },
            signal,
          );
        },
      );
      if (wire === undefined || !current()) return;
      const report = parseCheck(wire);
      if (
        selected &&
        (report.diagnostics.some((finding) => !selected.has(finding.path)) ||
          [...report.fixes.values()].some((fix) => !selected.has(fix.path)))
      )
        throw new Error("Check returned an unselected source");
      const grouped = new Map<string, Finding[]>();
      for (const relative of selected?.keys() ?? []) grouped.set(relative, []);
      for (const finding of report.diagnostics) {
        const group = grouped.get(finding.path) ?? [];
        group.push(finding);
        grouped.set(finding.path, group);
      }
      const relatedRevision = this.relatedRevision;
      const entries = new Map<string, vscode.Diagnostic[]>();
      const accepted = new Set<string>();
      for (const [relative, findings] of grouped) {
        let filename: string;
        let text: string;
        try {
          filename = await resolveSource(root, relative);
          text = await readFile(filename, "utf8");
        } catch (error) {
          if (selected && (error as NodeJS.ErrnoException).code === "ENOENT") {
            this.confirmMissing(
              vscode.Uri.file(selected.get(relative)!.filename),
            );
            continue;
          }
          throw error;
        }
        const uri = vscode.Uri.file(filename);
        const owner = this.roots.folder(uri);
        if (owner && owner.uri.toString() !== folderKey) continue;
        if (selected && text !== selected.get(relative)!.text) continue;
        const index = new SnapshotIndex(text);
        for (const fix of report.fixes.values())
          if (fix.path === relative) index.edits(fix.edits);
        entries.set(
          uri.toString(),
          await renderDiagnostics(findings, index, root),
        );
        accepted.add(relative);
      }
      if (!current()) return;
      await this.synchronizeSources();
      if (!current()) return;
      if (relatedRevision !== this.relatedRevision)
        for (const diagnostics of entries.values())
          for (const diagnostic of diagnostics)
            diagnostic.relatedInformation = undefined;
      const previous = this.scans.get(folderKey);
      this.scans.set(
        folderKey,
        selected ? new Map([...(previous ?? []), ...entries]) : entries,
      );
      if (!selected) this.completeScans.add(folderKey);
      for (const uri of new Set([
        ...(selected ? [] : (previous?.keys() ?? [])),
        ...entries.keys(),
      ]))
        this.publish(vscode.Uri.parse(uri));
      return accepted;
    } catch (error) {
      if (current()) this.error(error, manual);
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
    if (this.pendingDiskReload.delete(key) && !document.isDirty)
      this.queueFile(document.uri, true);
    this.documentRevisions.set(document, ++this.nextRevision);
    this.relatedRevision++;
    this.lint.cancel(key);
    this.formatting.cancel(key);
    this.publish(document.uri);
    const identity = this.sourceOwners.get(key);
    if (identity) this.publish(vscode.Uri.file(identity.filename));
    // Saved related coordinates may now point into a dirty buffer. Primary
    // snapshots and proposals in other documents remain valid.
    const changed = new Set<string>();
    const invalidate = (uri: string, diagnostics: vscode.Diagnostic[]) => {
      for (const diagnostic of diagnostics) {
        if (!diagnostic.relatedInformation?.length) continue;
        diagnostic.relatedInformation = undefined;
        changed.add(uri);
      }
    };
    for (const [uri, result] of this.documents)
      invalidate(uri, result.diagnostics);
    for (const scan of this.scans.values())
      for (const [uri, diagnostics] of scan) invalidate(uri, diagnostics);
    for (const uri of changed) this.publish(vscode.Uri.parse(uri));
  }
  open(document: vscode.TextDocument): void {
    this.closedTabs.delete(document.uri.toString());
    this.eligibilityChanged.fire();
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
    this.documents.delete(key);
    // A later display repaint must not restore the saved scan behind a closed tab.
    const canonical = this.sourceOwners.get(key)?.filename;
    for (const scan of this.scans.values()) {
      scan.delete(key);
      if (canonical) scan.delete(vscode.Uri.file(canonical).toString());
    }
    this.collection.delete(document.uri);
    if (document.isClosed) {
      this.closedTabs.delete(key);
      this.sourceOwners.delete(key);
      this.documentFolders.delete(key);
    }
  }
  saved(document: vscode.TextDocument): void {
    if (/\.ya?ml$/i.test(document.uri.path))
      this.queueFile(document.uri, true, document.version);
  }
  private queueFile(uri: vscode.Uri, force = false, version?: number): void {
    if (this.disposed || uri.scheme !== "file" || !/\.ya?ml$/i.test(uri.path))
      return;
    const folder = this.roots.folder(uri);
    if (!folder || !this.roots.get(folder.uri.toString())) return;
    // Canonical watcher events share the originating open buffer's save key.
    // Keep canonical root cancellation even when that buffer uses an alias.
    if (!force && !this.sourceOwners.has(uri.toString())) {
      for (const [origin, identity] of this.sourceOwners) {
        if (vscode.Uri.file(identity.filename).toString() !== uri.toString())
          continue;
        uri = vscode.Uri.parse(origin);
        break;
      }
    }
    const key = uri.toString();
    this.scanRevisions.set(folder.uri.toString(), ++this.nextRevision);
    this.lint.cancel(`workspace:${folder.uri}`);
    this.pendingFiles.set(key, {
      uri,
      force: force || (this.pendingFiles.get(key)?.force ?? false),
      version: force ? version : this.pendingFiles.get(key)?.version,
    });
    if (this.fileTimer) clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => {
      this.fileTimer = undefined;
      void this.flushFiles();
    }, 100);
  }
  private async flushFiles(): Promise<void> {
    if (this.disposed || this.flushingFiles) return;
    this.flushingFiles = true;
    const pending = [...this.pendingFiles.values()];
    this.pendingFiles.clear();
    const affected = new Map<string, number>();
    const selected = new Map<
      string,
      Map<
        string,
        { filename: string; text: string; uri: vscode.Uri; fingerprint: string }
      >
    >();
    try {
      for (const { uri, force, version } of pending) {
        const folder = this.roots.folder(uri);
        if (!folder) continue;
        const folderKey = folder.uri.toString();
        const revision = this.rootRevision(folderKey);
        const root = await this.root(folder);
        if (!root || revision !== this.rootRevision(folderKey)) continue;
        affected.set(folderKey, revision);
        const key = uri.toString();
        let filename: string | undefined;
        try {
          const identity = await identify(root, uri.fsPath);
          filename = identity.filename;
          const text = await readFile(identity.filename, "utf8");
          this.missingFiles.delete(key);
          const document = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === key && !doc.isClosed,
          );
          const fingerprint = `${root}:${hash(text)}:${document?.version ?? 0}`;
          if (!force && this.fileFingerprints.get(key) === fingerprint)
            continue;
          if (document) {
            if (
              document.isDirty ||
              (version !== undefined && document.version !== version)
            )
              continue;
            if (!document.isDirty && document.getText() !== text) {
              this.pendingDiskReload.add(key);
              continue;
            }
            if (force || !document.isDirty) {
              const previous = this.documents.get(key)?.id;
              await this.check(document, false, document.version);
              const result = this.documents.get(key);
              if (
                result &&
                result.id !== previous &&
                this.current(document, result.snapshot)
              )
                this.fileFingerprints.set(key, fingerprint);
            }
          } else {
            const files = selected.get(folder.uri.toString()) ?? new Map();
            files.set(identity.path, {
              filename: identity.filename,
              text,
              uri,
              fingerprint,
            });
            selected.set(folder.uri.toString(), files);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            this.confirmMissing(uri, filename);
          } else this.error(error, false);
        }
      }
      for (const [key, files] of selected) {
        const folder = vscode.workspace.workspaceFolders?.find(
          (folder) => folder.uri.toString() === key,
        );
        if (!folder) continue;
        const entries = [...files];
        for (let offset = 0; offset < entries.length; offset += 64) {
          const batch = new Map(entries.slice(offset, offset + 64));
          const accepted = await this.checkSaved(folder, false, batch);
          for (const relative of accepted ?? []) {
            const source = batch.get(relative)!;
            this.fileFingerprints.set(
              source.uri.toString(),
              source.fingerprint,
            );
          }
        }
      }
      // A selected event can cancel the initial full scan before it publishes.
      // Partial results must not replace that root's outstanding full coverage.
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const key = folder.uri.toString();
        const revision = affected.get(key);
        if (
          revision !== undefined &&
          revision === this.rootRevision(key) &&
          this.roots.get(key) &&
          !this.completeScans.has(key) &&
          !this.pendingRefresh.has(key)
        )
          await this.checkSaved(folder, false);
      }
    } finally {
      this.flushingFiles = false;
      if (this.pendingFiles.size && !this.fileTimer)
        this.fileTimer = setTimeout(() => {
          this.fileTimer = undefined;
          void this.flushFiles();
        }, 100);
    }
  }
  removeFile(uri: vscode.Uri): void {
    this.queueFile(uri);
  }
  private confirmMissing(uri: vscode.Uri, filename?: string): void {
    const key = uri.toString();
    // An already-running echo may land between atomic delete/create.
    // Confirm absence once in the next event batch before clearing.
    if (this.missingFiles.has(key))
      this.forgetFile(uri, filename ?? this.missingFiles.get(key));
    else {
      this.missingFiles.set(key, filename);
      this.queueFile(uri);
    }
  }
  private forgetFile(uri: vscode.Uri, filename?: string): void {
    const key = uri.toString();
    this.fileFingerprints.delete(key);
    this.pendingDiskReload.delete(key);
    this.missingFiles.delete(key);
    this.pendingFiles.delete(key);
    const canonical = filename ?? this.sourceOwners.get(key)?.filename;
    const keys = new Set([
      key,
      ...(canonical ? [vscode.Uri.file(canonical).toString()] : []),
    ]);
    for (const target of keys) {
      this.lint.cancel(target);
      this.formatting.cancel(target);
      this.documents.delete(target);
      for (const scan of this.scans.values()) scan.delete(target);
      this.collection.delete(vscode.Uri.parse(target));
    }
    const folder = this.roots.folder(uri);
    if (folder) {
      this.scanRevisions.set(folder.uri.toString(), ++this.nextRevision);
      this.lint.cancel(`workspace:${folder.uri}`);
      this.lint.cancel(`files:${folder.uri}`);
    }
    this.sourceOwners.delete(key);
    this.eligibilityChanged.fire();
  }
  refresh(uris?: readonly vscode.Uri[]): void {
    if (this.disposed) return;
    if (uris) {
      for (const uri of uris)
        if (/\.ya?ml$/i.test(uri.path)) this.queueFile(uri);
      uris = uris.filter((uri) => !/\.ya?ml$/i.test(uri.path));
      if (!uris.length) return;
    }
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
      this.lint.cancel(`files:${folder}`);
      const scan = this.scans.get(folder);
      this.scans.delete(folder);
      this.completeScans.delete(folder);
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
      for (const folder of vscode.workspace.workspaceFolders ?? [])
        if (pending.has(folder.uri.toString()))
          void this.checkSaved(folder, false);
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
    this.fileListener.dispose();
    this.displayListeners.dispose();
    this.roots.dispose();
    this.eligibilityChanged.dispose();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.fileTimer) clearTimeout(this.fileTimer);
    this.pendingFiles.clear();
    this.completeScans.clear();
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
