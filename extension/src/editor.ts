import {
  Navigation,
  validateNavigation,
  type NavigationAdapters,
  type NavigationAnswer,
} from "./navigation.ts";
import { parseQuery, type QueryOperation } from "./navigation-protocol.ts";
import { RuleHelp } from "./help.ts";
import * as vscode from "vscode";
import { isUtf8 } from "node:buffer";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { statSync, realpathSync, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  identify,
  resolveSource,
  templatePath,
  SourceIdentityError,
  unavailableSource,
} from "./identity.ts";
import type { Identity } from "./identity.ts";
import {
  editorText,
  hash,
  hasUTF8BOM,
  parseCheck,
  parseFormat,
  SnapshotIndex,
} from "./protocol.ts";
import type {
  CheckReport,
  EditorEdit,
  Finding,
  SharedFix,
} from "./protocol.ts";
import { runProcess } from "./process.ts";
import type { ProcessFailureObserver } from "./process-failure.ts";
import { range, renderDiagnostics } from "./diagnostics.ts";
import { Scheduler, typingPreempted } from "./scheduler.ts";
import { LiveChecks } from "./live-checks.ts";
import { MarkedRoots, type RootAdapters } from "./roots.ts";
import { Results } from "./results.ts";
import { Dependencies } from "./dependencies.ts";
import {
  combineDisposables,
  disposeResources,
  rollbackResources,
} from "./disposables.ts";
import {
  contentFingerprint,
  fileFingerprint,
  observeAnalysis,
  observationFingerprint,
  observeLogicalSource,
  logicalSourceCurrent,
  sourceOriginCurrent,
  sourceOriginCurrentNow,
  type LogicalSource,
} from "./observations.ts";
import type { WritableStage, WritableGuard } from "./writable-trace.ts";
export type { WritableStage, WritableGuard } from "./writable-trace.ts";

// Supplied only by the ownership test for its existing invocation. Normal
// extension callbacks leave this absent; no observation channel is installed.
export type WritableStageCollector = (
  stage: WritableStage,
  guard?: WritableGuard,
) => void;
function writableStage(
  collect: WritableStageCollector | undefined,
  stage: WritableStage,
  guard?: WritableGuard,
): void {
  try {
    collect?.(stage, guard);
  } catch {
    // Test evidence must not replace a product result or error.
  }
}

export interface CheckStatus {
  state:
    | "eligible"
    | "checking"
    | "current"
    | "stale"
    | "disabled"
    | "missing-marker"
    | "failed";
  reason: string;
}
export interface EditorAdapters {
  runProcess: typeof runProcess;
  readFile: typeof readFile;
  stat: typeof stat;
  schedule: (perform: () => void, milliseconds: number) => () => void;
  roots: Partial<RootAdapters>;
  navigation: Partial<NavigationAdapters>;
  createOutputChannel: (name: string) => vscode.OutputChannel;
  createStatusBarItem: (
    alignment?: vscode.StatusBarAlignment,
    priority?: number,
  ) => vscode.StatusBarItem;
  showErrorMessage: (message: string) => PromiseLike<unknown>;
  contextFiles: Partial<ContextFileSystem>;
}
// Asynchronous observations of a changed context file. realpath from
// node:fs/promises resolves through the native implementation.
export interface ContextFileSystem {
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  stat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
}
const contextFiles: ContextFileSystem = {
  lstat: (path, options) => lstat(path, options),
  stat: (path, options) => stat(path, options),
  realpath: (path) => realpath(path),
  readFile: (path) => readFile(path),
};
interface ContextTarget {
  folder: vscode.WorkspaceFolder;
  key: string;
  root: string;
  relative: string;
  known?: SourceOwner;
  kind: "read" | "metadata" | undefined;
}
interface Snapshot extends Identity {
  logical?: LogicalSource;
  sourceFilename: string;
  uri: vscode.Uri;
  version: number;
  text: string;
  hash: string;
  folder: string;
  rootRevision: number;
  documentRevision: number;
  dependencyRevision: number;
  index: SnapshotIndex;
}
interface DocumentResult {
  id: string;
  snapshot: Snapshot;
  report: CheckReport;
  diagnostics: vscode.Diagnostic[];
}
interface PendingCheck {
  typing?: boolean;
  source?: string;
  dependencyRevision: number;
  work: Promise<void>;
}
interface SourceOwner extends Identity {
  physical?: boolean;
  logical?: LogicalSource;
}
function textEdits(edits: EditorEdit[]): vscode.TextEdit[] {
  return edits.map((edit) => vscode.TextEdit.replace(range(edit), edit.text));
}

export class EditorIntegration implements vscode.Disposable {
  private physicalSources?: WeakSet<vscode.TextDocument>;
  private readonly roots: MarkedRoots;
  private readonly eligibilityChanged: vscode.EventEmitter<void>;
  readonly onDidChangeEligibility: vscode.Event<void>;
  private readonly rootListener: vscode.Disposable;
  private readonly fileListener: vscode.Disposable;
  private readonly displayListeners: vscode.Disposable;
  private activeFile = vscode.window.activeTextEditor?.document.uri;
  private activeProjectOnly = this.displayActiveProjectOnly();
  private readonly lint = new Scheduler("retain");
  private liveChecks?: LiveChecks<vscode.TextDocument>;
  private readonly formatting = new Scheduler();
  private readonly queryLanes = new Map<QueryOperation, Scheduler>([
    ["definition", new Scheduler()],
    ["completion", new Scheduler()],
    ["hover", new Scheduler()],
    ["references", new Scheduler()],
  ]);
  private queryRevision = 0;
  readonly navigation: Navigation;
  private revokeQueries(): void {
    this.queryRevision++;
    for (const lane of this.queryLanes.values()) lane.cancelAll();
  }

  private readonly collection: vscode.DiagnosticCollection;
  private readonly output: vscode.OutputChannel;
  private readonly results = new Results<DocumentResult>();
  private readonly dependencies = new Dependencies();
  private readonly checking = new Map<string, PendingCheck>();
  private readonly rootRevisions = new Map<string, number>();
  private readonly documentRevisions = new WeakMap<
    vscode.TextDocument,
    number
  >();
  private readonly documentFolders = new Map<string, string>();
  private readonly sourceOwners = new Map<string, SourceOwner>();
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
  private fileTimer?: () => void;
  private backgroundWork?: Set<Promise<void>>;
  private contextQueue?: Promise<void>;
  private producerWaiters?: Set<() => void>;
  private flushingFiles = false;
  private nextRevision = 0;
  private relatedRevision = 0;
  private disposed = false;
  private refreshTimer?: () => void;
  private readonly help: RuleHelp;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly failures = new Map<
    string,
    { token: string; message: string }
  >();
  private readonly executable: string;
  private readonly initialization: Promise<void>;
  constructor(
    executable: string,
    private readonly adapters: Partial<EditorAdapters> = {},
  ) {
    this.executable = executable;
    const acquired: vscode.Disposable[] = [];
    const own = <T extends vscode.Disposable>(resource: T): T => {
      acquired.push(resource);
      return resource;
    };
    try {
      this.eligibilityChanged = own(new vscode.EventEmitter<void>());
      this.onDidChangeEligibility = this.eligibilityChanged.event;
      this.navigation = own(
        new Navigation((document, position, operation, token, manual) =>
          this.query(document, position, operation, token, manual),
        ),
      );
      this.collection = own(
        vscode.languages.createDiagnosticCollection("saltbox-lint"),
      );
      this.statusBar = own(
        (adapters.createStatusBarItem ?? vscode.window.createStatusBarItem)(
          vscode.StatusBarAlignment.Left,
          0,
        ),
      );
      this.output = own(
        (adapters.createOutputChannel ?? vscode.window.createOutputChannel)(
          "Saltbox Lint",
        ),
      );
      this.roots = own(
        new MarkedRoots((error) => this.error(error, false), adapters.roots),
      );
      this.help = own(new RuleHelp(executable, adapters.runProcess));
      this.statusBar.command = "saltboxLint.showStatus";
      this.rootListener = own(
        this.roots.onDidChange((folder) => {
          for (const [uri, owner] of this.documentFolders)
            if (owner === folder) this.sourceOwners.delete(uri);
          this.refreshFolders(new Set([folder]));
          this.repaint();
          this.eligibilityChanged.fire();
        }),
      );
      this.fileListener = own(
        this.roots.onDidChangeFile((uri) => this.contextEvent(uri)),
      );
      if (this.activeFile?.scheme !== "file") this.activeFile = undefined;
      const displayListeners: vscode.Disposable[] = [];
      displayListeners.push(
        own(
          vscode.window.onDidChangeActiveTextEditor((editor) => {
            this.updateStatus();
            if (editor?.document.uri.scheme !== "file") return;
            this.activeFile = editor.document.uri;
            this.repaint();
          }),
        ),
      );
      displayListeners.push(
        own(
          vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("saltboxLint.checkOnType"))
              this.liveChecks?.cancelWhere(
                (document) => !this.typingEligible(document),
              );
            if (!event.affectsConfiguration("saltboxLint.activeProjectOnly"))
              return;
            this.activeProjectOnly = this.displayActiveProjectOnly();
            this.repaint();
          }),
        ),
      );
      this.displayListeners = combineDisposables(displayListeners);
    } catch (error) {
      rollbackResources(error, acquired);
    }
    // Return the resource owner before configuration can admit asynchronous probes.
    this.initialization = Promise.resolve().then(() => {
      if (!this.disposed) this.roots.configure();
    });
    this.background(this.initialization);
  }
  private async documentedRules(): Promise<ReadonlySet<string>> {
    try {
      return new Set((await this.help.registry()).map((rule) => rule.id));
    } catch (error) {
      if (!this.disposed)
        this.output.appendLine(
          `Rule documentation unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      return new Set();
    }
  }
  private statusRevisionToken(document: vscode.TextDocument): string {
    const folder =
      vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? "";
    const identity = this.sourceOwners.get(document.uri.toString());
    return `${document.version}:${this.documentRevision(document)}:${this.rootRevision(folder)}:${identity ? this.dependencies.revision(folder, identity.path) : 0}`;
  }
  private statusToken(document: vscode.TextDocument): string {
    return `${this.statusRevisionToken(document)}:${hash(document.getText())}`;
  }
  private checkKey(document: vscode.TextDocument, folder: string): string {
    // These revisions identify queued and admitted work. Global event tokens
    // guard result acceptance, not ownership of an unknown source request.
    return `${document.uri}:${document.version}:${this.documentRevision(document)}:${this.rootRevision(folder)}:${this.dependencies.admissionRevision(folder)}`;
  }
  private pendingCheck(
    document: vscode.TextDocument,
    folder: string,
  ): PendingCheck | undefined {
    const pending = this.checking.get(this.checkKey(document, folder));
    if (
      pending &&
      (pending.source === undefined ||
        pending.dependencyRevision ===
          this.dependencies.revision(folder, pending.source))
    )
      return pending;
  }
  status(document = vscode.window.activeTextEditor?.document): CheckStatus {
    if (
      !document ||
      !vscode.workspace.isTrusted ||
      document.uri.scheme !== "file"
    )
      return {
        state: "disabled",
        reason: "A trusted local YAML or template document is required.",
      };
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)
      ?.uri.toString();
    if (!folder || !this.roots.get(folder))
      return {
        state: "missing-marker",
        reason:
          "Opt in by creating a regular .saltbox-lint file in the configured source root. This command does not create it.",
      };
    if (!this.eligible(document))
      return {
        state: "disabled",
        reason: "This source is not eligible for checking.",
      };
    const key = document.uri.toString();
    if (this.pendingCheck(document, folder))
      return {
        state: "checking",
        reason: "A check for this source revision is pending.",
      };
    const failure = this.failures.get(key);
    if (
      failure &&
      failure.token.startsWith(`${this.statusRevisionToken(document)}:`) &&
      failure.token === this.statusToken(document)
    )
      return { state: "failed", reason: failure.message };
    const result = this.results.document(key);
    if (result)
      return this.current(document, result.snapshot)
        ? {
            state: "current",
            reason:
              "The result matches the observed source, root and dependency revisions." +
              (this.isTemplate(document)
                ? " Template coverage is bounded and read-only; unsupported grammar is reported as partial coverage."
                : ""),
          }
        : {
            state: "stale",
            reason:
              "The source, root or dependencies changed after this result.",
          };
    return {
      state: "eligible",
      reason: "This source is eligible and has no current buffer result.",
    };
  }
  private updateStatus(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (
      !document ||
      document.uri.scheme !== "file" ||
      !(/\.ya?ml$/i.test(document.uri.path) || this.isTemplate(document))
    ) {
      this.statusBar.hide();
      return;
    }
    const status = this.status(document);
    this.statusBar.text = `Saltbox Lint: ${status.state}`;
    this.statusBar.tooltip = status.reason;
    this.statusBar.show();
  }
  async showStatus(): Promise<CheckStatus> {
    await this.ready();
    const document = vscode.window.activeTextEditor?.document;
    const folder =
      document && vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder) await this.roots.refresh(folder.uri.toString());
    await this.ready();
    const status = this.status(document);
    this.output.appendLine(
      `Status ${document?.uri.fsPath ?? "no source"}: ${status.state}. ${status.reason}`,
    );
    this.output.show(true);
    this.updateStatus();
    return status;
  }
  async explainRule(id?: string): Promise<vscode.MarkdownString | undefined> {
    try {
      return await this.help.explain(id);
    } catch (error) {
      this.error(error, true);
      return undefined;
    }
  }
  private displayActiveProjectOnly(): boolean {
    return vscode.workspace
      .getConfiguration("saltboxLint")
      .get<boolean>("activeProjectOnly", true);
  }
  private repaint(): void {
    this.updateStatus();
    const uris = this.results.uris();
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
      (this.isTemplate(document) ||
        (["yaml", "ansible"].includes(document.languageId) &&
          /\.ya?ml$/i.test(document.uri.path))) &&
      !!this.roots.get(
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? "",
      )
    );
  }
  isTemplate(document: vscode.TextDocument): boolean {
    const identity = this.sourceOwners.get(document.uri.toString());
    return (
      templatePath(document.uri.path) ||
      (identity !== undefined &&
        (templatePath(identity.path) || templatePath(identity.filename)))
    );
  }

  writable(document: vscode.TextDocument): boolean {
    return this.eligible(document) && !this.isTemplate(document);
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
    if (this.disposed) return;
    this.liveChecks?.cancelWhere(() => true);
    this.roots.configure();
    this.repaint();
  }
  async ready(): Promise<void> {
    await this.initialization;
    await this.roots.ready();
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
    await this.ready();
    const root = this.roots.get(folder.uri.toString());
    if (root) this.canonicalRoots.set(folder.uri.toString(), root);
    return root;
  }
  private rememberSource(
    document: vscode.TextDocument,
    identity: SourceOwner,
  ): void {
    if (identity.physical)
      (this.physicalSources ??= new WeakSet()).add(document);
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)!
      .uri.toString();
    const pending = this.pendingCheck(document, folder);
    if (pending && pending.source === undefined) {
      // Admission adds dependency identity to the same owned request before
      // alias publication can refresh the status bar.
      pending.source = identity.path;
      pending.dependencyRevision = this.dependencies.revision(
        folder,
        identity.path,
      );
    }
    const previous = this.sourceOwners.get(document.uri.toString());
    this.sourceOwners.set(document.uri.toString(), {
      ...identity,
      physical:
        identity.physical ??
        (previous?.filename === identity.filename
          ? previous.physical
          : undefined),
    });
    this.roots.watchSource(document.uri, identity);
    this.eligibilityChanged.fire();
    const canonical = vscode.Uri.file(identity.filename);
    if (canonical.toString() !== document.uri.toString())
      this.publish(canonical);
  }
  private withdrawSource(document: vscode.TextDocument): void {
    this.liveChecks?.cancel(document);
    const key = document.uri.toString();
    const owner = this.sourceOwners.get(key);
    if (!owner) return;
    const folder = this.documentFolders.get(key) ?? "";
    this.documentRevisions.set(document, ++this.nextRevision);
    this.relatedRevision++;
    this.revokeQueries();
    this.lint.cancel(key);
    this.formatting.cancel(key);
    this.roots.forgetSource(key);
    this.failures.delete(key);
    this.results.close(key, vscode.Uri.file(owner.filename).toString());
    this.collection.delete(document.uri);
    this.sourceOwners.delete(key);
    this.documentFolders.delete(key);
    this.fileFingerprints.delete(key);
    this.pendingDiskReload.delete(key);
    this.missingFiles.delete(key);
    this.pendingFiles.delete(key);
    if (
      ![...this.sourceOwners.values()].some(
        (other) => other.root === owner.root && other.path === owner.path,
      )
    )
      this.dependencies.remove(folder, owner.path);
    for (const uri of this.results.invalidateRelated())
      this.publish(vscode.Uri.parse(uri));
    this.publish(vscode.Uri.file(owner.filename));
    this.eligibilityChanged.fire();
    this.updateStatus();
  }
  // A local alias can hide both the template directory and the file extension.
  // Resolve its bounded identity before granting checking capabilities. Ordinary
  // plaintext files still receive no checker, provider or writable capability.
  private async admit(
    document: vscode.TextDocument,
    expectedVersion = document.version,
  ): Promise<boolean> {
    if (
      this.disposed ||
      !vscode.workspace.isTrusted ||
      document.isClosed ||
      this.closedTabs.has(document.uri.toString()) ||
      document.uri.scheme !== "file"
    )
      return false;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return false;
    const key = folder.uri.toString();
    const rootRevision = this.rootRevision(key);
    const documentRevision = this.documentRevision(document);
    const root = await this.root(folder);
    if (!root) return false;
    const current = () =>
      !this.disposed &&
      vscode.workspace.isTrusted &&
      !document.isClosed &&
      !this.closedTabs.has(document.uri.toString()) &&
      document.version === expectedVersion &&
      documentRevision === this.documentRevision(document) &&
      rootRevision === this.rootRevision(key) &&
      this.roots.get(key) === root;
    let identity: SourceOwner;
    try {
      identity = await identify(root, document.uri.fsPath);
      // An ordinary new YAML leaf may have a logical identity before it is
      // saved. Previously owned sources and all templates need a live file.
      try {
        if (
          !(await (this.adapters?.stat ?? stat)(document.uri.fsPath)).isFile()
        )
          throw new SourceIdentityError("Source is not a regular file");
        identity.physical = true;
      } catch (error) {
        const previous = this.sourceOwners.get(document.uri.toString());
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          !this.isTemplate(document) &&
          !templatePath(identity.path) &&
          !templatePath(identity.filename) &&
          ["yaml", "ansible"].includes(document.languageId) &&
          /\.ya?ml$/i.test(document.uri.path) &&
          !this.physicalSources?.has(document) &&
          (!previous ||
            (previous.physical === false &&
              previous.root === identity.root &&
              previous.path === identity.path &&
              previous.filename === identity.filename))
        ) {
          const logical =
            previous?.logical ??
            (await observeLogicalSource(identity, document.uri.fsPath));
          if (!logical || !(await logicalSourceCurrent(logical)))
            throw new SourceIdentityError("Logical source identity changed");
          identity.physical = false;
          identity.logical = logical;
        } else throw error;
      }
    } catch (error) {
      if (!current()) return false;
      if (unavailableSource(error)) {
        this.withdrawSource(document);
        return false;
      }
      // Unknown plaintext candidates outside the configured root or with no
      // accessible identity are declined quietly, like ordinary plaintext.
      if (
        !this.isTemplate(document) &&
        !(
          ["yaml", "ansible"].includes(document.languageId) &&
          /\.ya?ml$/i.test(document.uri.path)
        )
      )
        return false;
      throw error;
    }
    if (!current()) return false;
    if (
      !templatePath(identity.filename) &&
      !templatePath(identity.path) &&
      !templatePath(document.uri.path) &&
      !(
        ["yaml", "ansible"].includes(document.languageId) &&
        /\.ya?ml$/i.test(document.uri.path)
      )
    ) {
      this.withdrawSource(document);
      return false;
    }
    const previous = this.sourceOwners.get(document.uri.toString());
    if (
      previous &&
      (previous.root !== identity.root ||
        previous.filename !== identity.filename)
    )
      this.withdrawSource(document);
    this.documentFolders.set(document.uri.toString(), key);
    this.rememberSource(document, identity);
    return true;
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
      if (!live.has(uri)) {
        this.sourceOwners.delete(uri);
        this.roots.forgetSource(uri);
      }
    for (const document of vscode.workspace.textDocuments) {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) continue;
      const key = folder.uri.toString();
      const revision = this.rootRevision(key);
      const version = document.version;
      try {
        await this.admit(document, version);
      } catch {
        if (
          revision === this.rootRevision(key) &&
          document.version === version
        ) {
          this.sourceOwners.delete(document.uri.toString());
          this.roots.forgetSource(document.uri.toString());
        }
      }
    }
  }

  private async snapshot(
    document: vscode.TextDocument,
    expectedVersion?: number,
  ): Promise<Snapshot | undefined> {
    await this.ready();
    if (expectedVersion !== undefined && document.version !== expectedVersion)
      return;
    if (!(await this.admit(document, expectedVersion))) return;
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
    let identity: Identity;
    try {
      identity = await identify(root, document.uri.fsPath);
    } catch (error) {
      if (!unavailableSource(error)) throw error;
      if (
        version === document.version &&
        documentRevision === this.documentRevision(document) &&
        rootRevision === this.rootRevision(folder) &&
        this.roots.get(folder) === root
      )
        this.withdrawSource(document);
      return;
    }
    const owner = this.sourceOwners.get(document.uri.toString());
    const logical = owner?.logical;
    if (logical && !(await logicalSourceCurrent(logical))) return;
    const snapshot = {
      ...identity,
      logical,
      sourceFilename: document.uri.fsPath,
      uri: document.uri,
      version,
      text,
      hash: hash(text),
      folder,
      rootRevision,
      documentRevision,
      dependencyRevision: this.dependencies.revision(folder, identity.path),
      index: new SnapshotIndex(text),
    };
    if (!this.current(document, snapshot)) return;
    this.rememberSource(document, {
      ...identity,
      physical: owner?.physical,
      logical,
    });
    return snapshot;
  }
  private current(document: vscode.TextDocument, snapshot: Snapshot): boolean {
    return (
      this.eligible(document) &&
      this.roots.get(snapshot.folder) === snapshot.root &&
      snapshot.rootRevision === this.rootRevision(snapshot.folder) &&
      snapshot.documentRevision === this.documentRevision(document) &&
      snapshot.dependencyRevision ===
        this.dependencies.revision(snapshot.folder, snapshot.path) &&
      document.version === snapshot.version &&
      hash(document.getText()) === snapshot.hash
    );
  }
  private async writableSnapshot(
    document: vscode.TextDocument,
    snapshot: Snapshot,
  ): Promise<boolean> {
    if (!this.current(document, snapshot) || !this.writable(document))
      return false;
    await this.roots.refresh(snapshot.folder);
    try {
      // Filesystem notifications may still be queued. Resolve the original
      // spelling again rather than granting writes from its remembered owner.
      const source = snapshot.logical
        ? undefined
        : await (this.adapters?.stat ?? stat)(snapshot.sourceFilename);
      const identity = await identify(snapshot.root, snapshot.sourceFilename);
      return (
        (snapshot.logical
          ? await logicalSourceCurrent(snapshot.logical)
          : source!.isFile()) &&
        this.current(document, snapshot) &&
        this.roots.get(snapshot.folder) === snapshot.root &&
        identity.filename === snapshot.filename &&
        identity.path === snapshot.path &&
        !templatePath(identity.filename) &&
        !templatePath(identity.path) &&
        this.writableSnapshotNow(document, snapshot)
      );
    } catch {
      // A missing, escaping or inaccessible source cannot authorize an edit.
      return false;
    }
  }
  private writableSnapshotNow(
    document: vscode.TextDocument,
    snapshot: Snapshot,
  ): boolean {
    try {
      // Awaited observations do not grant writes. Check the original URI and
      // physical presence again at the return or application boundary.
      return (
        this.current(document, snapshot) &&
        this.writable(document) &&
        !templatePath(snapshot.filename) &&
        !templatePath(snapshot.path) &&
        sourceOriginCurrentNow(snapshot) &&
        realpathSync.native(snapshot.root) === snapshot.root &&
        (!!snapshot.logical || statSync(snapshot.sourceFilename).isFile())
      );
    } catch {
      return false;
    }
  }
  /**
   * `edited` publication follows a buffer change. VS Code already holds an
   * unchanged own result and moves its markers with the edit; setting it
   * again would restore the result's original ranges. Status still updates.
   */
  private publish(uri: vscode.Uri, edited = false): void {
    this.updateStatus();
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
    const own = this.results.document(key);
    if (own) {
      if (!edited) this.collection.set(uri, own.diagnostics);
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
    const diagnostics = this.results.saved(folder, key);
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
    if (manual)
      this.background(
        (
          this.adapters?.showErrorMessage ??
          ((notice: string) => vscode.window.showErrorMessage(notice))
        )(`Saltbox Lint: ${message}`),
        false,
      );
  }
  private background(operation: PromiseLike<unknown>, track = true): void {
    const handled = Promise.resolve(operation).then(
      () => undefined,
      (error: unknown) => this.error(error, false),
    );
    if (!track) {
      handled.catch(() => undefined);
      return;
    }
    const work = (this.backgroundWork ??= new Set());
    const joined = handled.finally(() => {
      work.delete(joined);
      this.producerChanged();
    });
    work.add(joined);
    joined.catch(() => undefined);
  }
  private producerChanged(): void {
    for (const resolve of this.producerWaiters ?? []) resolve();
    this.producerWaiters?.clear();
  }
  private schedule(perform: () => void, milliseconds: number): () => void {
    const schedule =
      this.adapters?.schedule ??
      ((callback: () => void, delay: number) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      });
    return schedule(() => {
      try {
        perform();
      } finally {
        this.producerChanged();
      }
    }, milliseconds);
  }
  checkBackground(document: vscode.TextDocument): void {
    if (this.disposed) return;
    this.background(this.check(document));
  }
  async check(
    document: vscode.TextDocument,
    manual = false,
    expectedVersion?: number,
    typing = false,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.disposed) return;
    if (!typing) this.liveChecks?.cancel(document);
    const version = expectedVersion ?? document.version;
    const revision = this.documentRevision(document);
    if (manual) {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (folder) await this.roots.refresh(folder.uri.toString());
    }
    await this.ready();
    if (
      signal?.aborted ||
      document.version !== version ||
      this.documentRevision(document) !== revision
    )
      return;
    const sourceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const sourceRootRevision = sourceFolder
      ? this.rootRevision(sourceFolder.uri.toString())
      : undefined;
    try {
      if (!(await this.admit(document, version))) return;
    } catch (error) {
      if (
        !signal?.aborted &&
        (!typing || this.typingEligible(document)) &&
        document.version === version &&
        this.documentRevision(document) === revision &&
        sourceFolder &&
        this.rootRevision(sourceFolder.uri.toString()) === sourceRootRevision &&
        this.eligible(document)
      ) {
        this.failures.set(document.uri.toString(), {
          token: this.statusToken(document),
          message: error instanceof Error ? error.message : String(error),
        });
        this.updateStatus();
        this.error(error, manual);
      }
      return;
    }
    if (
      !this.eligible(document) ||
      signal?.aborted ||
      (typing && !this.typingEligible(document))
    )
      return;
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)!
      .uri.toString();
    const key = this.checkKey(document, folder);
    const identity = this.sourceOwners.get(document.uri.toString());
    const existing = this.pendingCheck(document, folder);
    if (existing) {
      if (!typing && existing.typing) {
        await existing.work;
        if (document.version === version)
          return this.check(document, manual, version);
        return;
      }
      return existing.work;
    }
    const work = this.checkSnapshot(
      document,
      manual,
      version,
      typing,
      signal,
    ).then((retry) => {
      // Release deduplication before a rejected request queues its replacement.
      if (this.checking.get(key) === pending) this.checking.delete(key);
      retry?.();
    });
    const pending: PendingCheck = {
      typing,
      source: identity?.path,
      dependencyRevision: identity
        ? this.dependencies.revision(folder, identity.path)
        : 0,
      work,
    };
    this.checking.set(key, pending);
    this.updateStatus();
    try {
      await work;
    } finally {
      if (this.checking.get(key) === pending) this.checking.delete(key);
      this.updateStatus();
    }
  }
  private async checkSnapshot(
    document: vscode.TextDocument,
    manual: boolean,
    version: number,
    typing = false,
    signal?: AbortSignal,
  ): Promise<(() => void) | undefined> {
    const key = document.uri.toString();
    const revision = this.documentRevision(document);
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)!
      .uri.toString();
    const rootRevision = this.rootRevision(folder);
    const dependencyToken = this.dependencies.begin();
    const admissionRevision = this.dependencies.admissionRevision(folder);
    // Ownership must exist while the request is queued, before any source copy.
    this.documentFolders.set(key, folder);
    const current = () =>
      !signal?.aborted &&
      (!typing || this.typingEligible(document)) &&
      this.eligible(document) &&
      document.version === version &&
      revision === this.documentRevision(document) &&
      rootRevision === this.rootRevision(folder) &&
      admissionRevision === this.dependencies.admissionRevision(folder);
    const retry = () => {
      if (typing && current())
        return () => {
          if (current()) this.scheduleTyping(document);
        };
      if (current() && !document.isDirty)
        return () => {
          if (current() && !document.isDirty)
            this.queueFile(document.uri, true, version);
        };
    };
    let failureToken: string | undefined;
    let operationSignal: AbortSignal | undefined;
    try {
      const result = await this.lint.submit(
        key,
        typing ? -1 : manual ? 2 : 1,
        async (signal) => {
          operationSignal = signal;
          if (signal.aborted || !current()) return;
          failureToken = this.statusToken(document);
          const snapshot = await this.snapshot(document, version);
          if (!snapshot || signal.aborted || !current()) return;
          failureToken = this.statusToken(document);
          const bytes = !document.isDirty
            ? await (this.adapters?.readFile ?? readFile)(snapshot.filename)
            : undefined;
          if (signal.aborted || !current()) return;
          const unsupported = bytes !== undefined && !isUtf8(bytes);
          // VS Code omits a saved UTF-8 BOM from the clean model. Analyze the
          // exact saved bytes so dependency observations match the disk, and
          // map the CLI's BOM-inclusive coordinates back to the model.
          const savedBOM =
            bytes !== undefined &&
            !unsupported &&
            hasUTF8BOM(bytes) &&
            editorText(bytes) === snapshot.text;
          // Ordinary invalid YAML retains the saved-file transport. A read-only
          // template keeps its admitted spelling and exact raw bytes together.
          const savedYaml = unsupported && !this.isTemplate(document);
          const wire = await (this.adapters?.runProcess ?? runProcess)(
            {
              executable: this.executable,
              cwd: snapshot.root,
              args: savedYaml
                ? [
                    "check",
                    "--root",
                    snapshot.root,
                    "--format",
                    "json",
                    "--include-analysis",
                    "--",
                    snapshot.path,
                  ]
                : [
                    "check",
                    "--root",
                    snapshot.root,
                    "--stdin-filename",
                    snapshot.filename,
                    ...(templatePath(snapshot.sourceFilename)
                      ? ["--stdin-source-filename", snapshot.sourceFilename]
                      : []),
                    "--format",
                    "json",
                    "--include-analysis",
                    "-",
                  ],
              input: savedYaml
                ? undefined
                : unsupported || savedBOM
                  ? bytes
                  : snapshot.text,
              successCodes: [0, 1],
            },
            signal,
          );
          return {
            wire,
            snapshot: savedBOM
              ? {
                  ...snapshot,
                  index: new SnapshotIndex(bytes!.toString("utf8"), {
                    savedBytes: true,
                  }),
                }
              : snapshot,
            sourceHash: unsupported || savedBOM ? hash(bytes!) : snapshot.hash,
            unsupported,
          };
        },
        signal,
      );
      if (!current()) return;
      if (!result) {
        if (
          dependencyToken !== this.dependencies.begin() ||
          (typing && operationSignal?.reason === typingPreempted)
        )
          return retry();
        return;
      }
      const { wire, snapshot, sourceHash, unsupported } = result;
      if (!current() || !this.current(document, snapshot)) return retry();
      if (unsupported && document.isDirty) return;
      const identity = await identify(snapshot.root, snapshot.sourceFilename);
      if (
        !current() ||
        !this.current(document, snapshot) ||
        identity.filename !== snapshot.filename ||
        identity.path !== snapshot.path
      )
        return retry();
      const report = parseCheck(wire, true);
      if (
        report.analysis!.root !== snapshot.root ||
        report.analysis!.sources.length !== 1 ||
        report.analysis!.sources[0].path !== snapshot.path
      )
        throw new Error("Check returned inconsistent analysis identity");
      if (report.analysis!.sources[0].source_sha256 !== sourceHash) {
        // A raw saved-file request can observe a later disk snapshot.
        if (unsupported) return retry();
        throw new Error("Check returned inconsistent analysis identity");
      }
      if (
        report.diagnostics.some((finding) => finding.path !== snapshot.path) ||
        [...report.fixes.values()].some((fix) => fix.path !== snapshot.path)
      )
        throw new Error("Check returned an unselected source");
      if (!unsupported)
        for (const fix of report.fixes.values())
          snapshot.index.edits(fix.edits);
      const documentedRules = await this.documentedRules();
      if (!current() || !this.current(document, snapshot)) return retry();
      const relatedRevision = this.relatedRevision;
      const diagnostics = unsupported
        ? []
        : await renderDiagnostics(
            report.diagnostics,
            snapshot.index,
            snapshot.root,
            documentedRules,
            { readFile: this.adapters?.readFile },
          );
      if (!current() || !this.current(document, snapshot)) return retry();
      if (relatedRevision !== this.relatedRevision)
        for (const diagnostic of diagnostics)
          diagnostic.relatedInformation = undefined;
      const observed = await observeAnalysis(
        report.analysis!,
        document.isDirty ? new Set([snapshot.path]) : new Set(),
        undefined,
        this.isTemplate(document)
          ? { ...snapshot, sha256: sourceHash }
          : undefined,
      );
      if (!current() || !this.current(document, snapshot)) return retry();
      for (const file of observed.changed)
        this.contextEvent(
          vscode.Uri.file(path.join(snapshot.root, ...file.split("/"))),
        );
      // Results wait for admitted fingerprints instead of being accepted, or
      // retried, against a pending fence.
      if (this.contextQueue) await this.contextQueue;
      if (
        !current() ||
        !this.current(document, snapshot) ||
        observed.changed.size
      )
        return retry();
      if (unsupported && document.isDirty) return;
      if (
        !this.dependencies.accept(
          folder,
          report.analysis!,
          dependencyToken,
          false,
          [],
          observed.fingerprints,
        )
      )
        return retry();
      if (unsupported) {
        // Clean buffers may contain replacement characters for raw disk bytes.
        // Keep the raw dependency record without publishing invented positions.
        const canonical = vscode.Uri.file(snapshot.filename);
        this.results.close(key, canonical.toString());
        this.output.appendLine(
          `Skipped ${snapshot.path}: invalid UTF-8; editor diagnostics require UTF-8. Use the CLI to inspect parse findings.`,
        );
        this.publish(document.uri);
        this.publish(canonical);
        return;
      }
      this.failures.delete(key);
      this.results.storeDocument(key, {
        id: randomUUID(),
        snapshot,
        report,
        diagnostics,
      });
      this.publish(document.uri);
    } catch (error) {
      if (
        failureToken !== undefined &&
        current() &&
        failureToken === this.statusToken(document)
      ) {
        this.failures.set(key, {
          token: failureToken,
          message: error instanceof Error ? error.message : String(error),
        });
        this.updateStatus();
        this.error(error, manual);
      }
    }
  }
  async checkWorkspace(): Promise<void> {
    if (!vscode.workspace.isTrusted || this.disposed) return;
    await this.roots.refresh();
    await this.ready();
    for (const folder of vscode.workspace.workspaceFolders ?? [])
      await this.checkSaved(folder, true);
    for (const document of vscode.workspace.textDocuments)
      if (!document.isDirty && this.eligible(document))
        await this.check(document, false, document.version);
  }
  private async checkSaved(
    folder: vscode.WorkspaceFolder,
    manual: boolean,
    selected?: Map<
      string,
      { filename: string; sourceHash: string; uri: vscode.Uri }
    >,
  ): Promise<Set<string> | undefined> {
    if (folder.uri.scheme !== "file" || this.disposed) return;
    const folderKey = folder.uri.toString();
    const revision = this.rootRevision(folderKey);
    const scanRevision = this.scanRevisions.get(folderKey);
    const dependencyToken = this.dependencies.begin();
    const admissionRevision = this.dependencies.admissionRevision(folderKey);
    const current = () =>
      !this.disposed &&
      revision === this.rootRevision(folderKey) &&
      admissionRevision === this.dependencies.admissionRevision(folderKey) &&
      (selected !== undefined ||
        scanRevision === this.scanRevisions.get(folderKey));
    const retry = (root: string) => {
      if (!current()) return;
      if (selected) {
        for (const { uri } of selected.values()) this.queueFile(uri, true);
      } else if (
        vscode.workspace.isTrusted &&
        this.roots.get(folderKey) === root &&
        vscode.workspace.workspaceFolders?.some(
          (folder) => folder.uri.toString() === folderKey,
        )
      ) {
        // A newer source analysis may have consumed the changed fingerprint
        // already. Its context event is an echo, but this full scan still owes
        // complete coverage and must retain the existing queue's full retry.
        this.queueCoverage(folder);
      }
    };
    try {
      const root = await this.root(folder);
      if (!root || !current()) return;
      const wire = await this.lint.submit(
        `${selected ? "files" : "workspace"}:${folder.uri}`,
        manual ? 2 : 0,
        async (signal) => {
          if (!current() || !this.roots.get(folderKey)) return;
          return (this.adapters?.runProcess ?? runProcess)(
            {
              executable: this.executable,
              cwd: root,
              args: [
                "check",
                "--root",
                root,
                "--format",
                "json",
                "--include-analysis",
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
      const report = parseCheck(wire, true);
      if (
        report.analysis!.root !== root ||
        (selected &&
          (report.analysis!.sources.length !== selected.size ||
            report.analysis!.sources.some(
              (source) => !selected.has(source.path),
            )))
      )
        throw new Error("Check returned inconsistent analysis identity");
      if (
        selected &&
        (report.diagnostics.some((finding) => !selected.has(finding.path)) ||
          [...report.fixes.values()].some((fix) => !selected.has(fix.path)))
      )
        throw new Error("Check returned an unselected source");
      const grouped = new Map<string, Finding[]>();
      for (const source of report.analysis!.sources)
        grouped.set(source.path, []);
      for (const finding of report.diagnostics) {
        const group = grouped.get(finding.path) ?? [];
        group.push(finding);
        grouped.set(finding.path, group);
      }
      const relatedRevision = this.relatedRevision;
      const documentedRules = await this.documentedRules();
      const entries = new Map<string, vscode.Diagnostic[]>();
      const accepted = new Set<string>();
      const unsupported = new Set<string>();
      for (const [relative, findings] of grouped) {
        let filename: string;
        let bytes: Buffer;
        try {
          filename = await resolveSource(root, relative);
          bytes = await (this.adapters?.readFile ?? readFile)(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            this.confirmMissing(
              vscode.Uri.file(
                selected?.get(relative)?.filename ??
                  path.join(root, ...relative.split("/")),
              ),
            );
            continue;
          }
          throw error;
        }
        const uri = vscode.Uri.file(filename);
        const owner = this.roots.folder(uri);
        if (owner && owner.uri.toString() !== folderKey) continue;
        const sourceHash = hash(bytes);
        if (selected && sourceHash !== selected.get(relative)!.sourceHash) {
          this.queueFile(uri, true);
          continue;
        }
        if (
          sourceHash !==
          report.analysis!.sources.find((source) => source.path === relative)!
            .source_sha256
        ) {
          this.queueFile(uri, true);
          continue;
        }
        if (!isUtf8(bytes)) {
          // Retain raw-byte dependency coverage, but never map byte offsets
          // through replacement characters or retry a stable unsupported file.
          entries.set(uri.toString(), []);
          accepted.add(relative);
          unsupported.add(relative);
          continue;
        }
        const index = new SnapshotIndex(bytes.toString("utf8"), {
          savedBytes: true,
        });
        for (const fix of report.fixes.values())
          if (fix.path === relative) index.edits(fix.edits);
        entries.set(
          uri.toString(),
          await renderDiagnostics(findings, index, root, documentedRules, {
            readFile: this.adapters?.readFile,
          }),
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
      const acceptedAnalysis = {
        ...report.analysis!,
        sources: report.analysis!.sources.filter((source) =>
          accepted.has(source.path),
        ),
      };
      const observed = await observeAnalysis(acceptedAnalysis);
      for (const file of observed.changed)
        this.contextEvent(vscode.Uri.file(path.join(root, ...file.split("/"))));
      // Results wait for admitted fingerprints instead of being accepted, or
      // retried, against a pending fence.
      if (this.contextQueue) await this.contextQueue;
      if (!current()) return;
      if (observed.changed.size) {
        retry(root);
        return;
      }
      if (
        !this.dependencies.accept(
          folderKey,
          acceptedAnalysis,
          dependencyToken,
          !selected,
          [...this.sourceOwners]
            .filter(
              ([origin, owner]) =>
                owner.root === root &&
                this.documentFolders.get(origin) === folderKey,
            )
            .map(([, owner]) => owner.path),
          observed.fingerprints,
        )
      ) {
        // Freshness rejects the entire batch, including unchanged peers whose
        // disk events were already consumed by flushFiles.
        retry(root);
        return;
      }
      for (const relative of unsupported)
        this.output.appendLine(
          `Skipped ${relative}: invalid UTF-8; editor diagnostics require UTF-8. Use the CLI to inspect parse findings.`,
        );
      for (const uri of this.results.storeScan(folderKey, entries, !!selected))
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
    const result = this.results.document(document.uri.toString());
    if (!result || !this.current(document, result.snapshot)) return [];
    const actions: vscode.CodeAction[] = [];
    const explained = new Set<string>();
    for (const diagnostic of result.diagnostics) {
      if (!diagnostic.range.intersection(requested)) continue;
      const id =
        typeof diagnostic.code === "object"
          ? diagnostic.code.value
          : diagnostic.code;
      // Documentation links are assigned only for registry-backed rules.
      if (
        typeof diagnostic.code !== "object" ||
        typeof id !== "string" ||
        explained.has(id)
      )
        continue;
      explained.add(id);
      const help = new vscode.CodeAction(
        `Saltbox Lint: Explain ${id}`,
        vscode.CodeActionKind.QuickFix,
      );
      help.diagnostics = [diagnostic];
      help.command = {
        command: "saltboxLint.explainRule",
        title: help.title,
        arguments: [id],
      };
      actions.push(help);
    }
    if (!this.writable(document)) return actions;
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
    const result = this.results.document(uri.toString());
    if (
      !document ||
      !this.writable(document) ||
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
    if (
      !(await this.writableSnapshot(document, result.snapshot)) ||
      !this.writableSnapshotNow(document, result.snapshot)
    )
      return;
    await vscode.workspace.applyEdit(edit);
  }
  private async query(
    document: vscode.TextDocument,
    position: { line: number; character: number },
    operation: QueryOperation,
    token?: vscode.CancellationToken,
    manual = false,
  ): Promise<NavigationAnswer | undefined> {
    if (this.disposed || token?.isCancellationRequested) return;
    const version = document.version;
    const abort = new AbortController();
    const listener = token?.onCancellationRequested(() => abort.abort());
    let revision: number | undefined;
    let dependencyToken: number | undefined;
    let capturedSnapshot: Snapshot | undefined;
    let querySubmitted = false;
    const current = () =>
      !!capturedSnapshot &&
      !abort.signal.aborted &&
      revision === this.queryRevision &&
      this.current(document, capturedSnapshot);
    try {
      await this.ready();
      if (manual) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (folder) await this.roots.refresh(folder.uri.toString());
      }
      // Marker refresh can revoke or restore request ownership. Capture its
      // revisions only after that probe has completed.
      revision = this.queryRevision;
      dependencyToken = this.dependencies.begin();
      const snapshot = await this.snapshot(document, version);
      capturedSnapshot = snapshot;
      if (!snapshot || !current()) return;
      if (
        !document.isDirty &&
        !isUtf8(
          await (this.adapters?.readFile ?? readFile)(
            await resolveSource(snapshot.root, snapshot.path),
          ),
        )
      )
        return;
      if (!current()) return;
      const offset = snapshot.index.byteOffset(position);
      querySubmitted = true;
      const wire = await this.queryLanes.get(operation)!.submit(
        document.uri.toString(),
        1,
        (signal) =>
          (this.adapters?.runProcess ?? runProcess)(
            {
              executable: this.executable,
              cwd: snapshot.root,
              args: [
                "query",
                "--root",
                snapshot.root,
                "--stdin-filename",
                snapshot.filename,
                ...(templatePath(snapshot.sourceFilename)
                  ? ["--stdin-source-filename", snapshot.sourceFilename]
                  : []),
                "--operation",
                operation,
                "--offset",
                String(offset),
                "-",
              ],
              input: snapshot.text,
              maxBytes: 16 * 1024 * 1024,
            },
            signal,
          ),
        abort.signal,
      );
      if (wire === undefined || !current()) return;
      const report = parseQuery(
        wire,
        snapshot.root,
        snapshot.path,
        snapshot.text,
        operation,
        offset,
      );
      const dependencies = new Set(
        report.dependencies.sources[0].files.map((file) => file.path),
      );
      for (const buffer of vscode.workspace.textDocuments) {
        if (buffer.isClosed || !buffer.isDirty || buffer.uri.scheme !== "file")
          continue;
        let identity: Identity;
        try {
          identity = await identify(snapshot.root, buffer.uri.fsPath);
        } catch {
          continue;
        }
        if (
          (identity.path === snapshot.path &&
            hash(buffer.getText()) !== snapshot.hash) ||
          (identity.path !== snapshot.path && dependencies.has(identity.path))
        )
          return;
      }
      const observed = await observeAnalysis(
        report.dependencies,
        new Set([snapshot.path]),
        undefined,
        this.isTemplate(document)
          ? { ...snapshot, sha256: snapshot.hash }
          : undefined,
        true,
      );
      if (!current() || observed.changed.size) return;
      const answer = await validateNavigation(
        report,
        snapshot.text,
        snapshot.index,
        document.uri,
        observed.overlayPaths,
        observed.aliases,
        new Map([
          ...observed.targets,
          ...(snapshot.logical
            ? [
                [
                  snapshot.path,
                  {
                    filename: snapshot.filename,
                    fingerprint: "missing:" + snapshot.hash,
                    rootFingerprint: snapshot.logical.rootFingerprint,
                    logical: snapshot.logical,
                  },
                ] as const,
              ]
            : []),
        ]),
        this.adapters?.navigation,
      );
      if (!answer || !current()) return;
      if (!(await sourceOriginCurrent(snapshot)) || !current()) return;
      // Events which arrived before a previously unknown query dependency was
      // loaded still prevent late acceptance. Do not overwrite lint ownership.
      // Keep the original URI's owner in the final cohort even when that
      // spelling is absent from the report's dependencies and targets.
      if (
        !(await answer.targetsCurrent()) ||
        (snapshot.logical && !(await logicalSourceCurrent(snapshot.logical))) ||
        !answer.targetsCurrentNow() ||
        !sourceOriginCurrentNow(snapshot) ||
        !current() ||
        this.dependencies.begin() !== dependencyToken
      )
        return;
      return answer;
    } catch (error) {
      // Missing primary context is a quiet refusal. The same filesystem code
      // from spawning a missing executable is an operational failure instead.
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !querySubmitted &&
        (code === "ENOENT" ||
          code === "ENOTDIR" ||
          (error instanceof Error &&
            error.message === "Source identity changed"))
      )
        return;
      // Background providers decline silently. Manual operations report only
      // a fixed message while the captured request is still current, so child
      // responses and declaration contents never reach Output or notifications.
      if (
        manual &&
        !abort.signal.aborted &&
        revision === this.queryRevision &&
        this.dependencies.begin() === dependencyToken &&
        this.eligible(document) &&
        (!capturedSnapshot || current())
      )
        this.error(
          new Error(
            "Static role lookup impact failed. Check the bundled CLI and try again.",
          ),
          true,
        );
      return;
    } finally {
      listener?.dispose();
    }
  }
  async format(
    document: vscode.TextDocument,
    mode: "canonical" | "lint-fixes",
    token?: vscode.CancellationToken,
    collect?: WritableStageCollector,
    observeFailure?: ProcessFailureObserver,
  ): Promise<vscode.TextEdit[]> {
    const result = await this.formattingResult(
      document,
      mode,
      document.version,
      token,
      collect,
      observeFailure,
    );
    const accepted =
      result &&
      !token?.isCancellationRequested &&
      this.writableSnapshotNow(document, result.snapshot);
    writableStage(
      collect,
      accepted ? "final-authority-accepted" : "final-authority-declined",
      accepted ? undefined : "format-return-authority",
    );
    return accepted ? result.edits : [];
  }
  private async formattingResult(
    document: vscode.TextDocument,
    mode: "canonical" | "lint-fixes",
    version: number,
    token?: vscode.CancellationToken,
    collect?: WritableStageCollector,
    observeFailure?: ProcessFailureObserver,
  ): Promise<{ snapshot: Snapshot; edits: vscode.TextEdit[] } | undefined> {
    if (token?.isCancellationRequested || this.isTemplate(document)) {
      writableStage(collect, "snapshot-declined", "format-preflight");
      return;
    }
    const abort = new AbortController();
    const listener = token?.onCancellationRequested(() => abort.abort());
    let stage: "admission" | "operation" | "parser" | "authority" = "admission";
    try {
      const snapshot = await this.snapshot(document, version);
      if (!snapshot || abort.signal.aborted || !this.writable(document)) {
        writableStage(collect, "snapshot-declined", "snapshot-admission");
        return;
      }
      writableStage(collect, "snapshot-present");
      if (
        !document.isDirty &&
        !isUtf8(await (this.adapters?.readFile ?? readFile)(snapshot.filename))
      ) {
        this.output.appendLine(
          `Skipped ${snapshot.path}: invalid UTF-8; editor formatting requires UTF-8.`,
        );
        writableStage(collect, "submission-refused", "disk-utf8");
        return;
      }
      if (!this.current(document, snapshot) || abort.signal.aborted) {
        writableStage(collect, "submission-refused", "before-submission");
        return;
      }
      stage = "operation";
      writableStage(collect, "submission-entered");
      const wire = await this.formatting.submit(
        document.uri.toString(),
        mode === "canonical" ? 2 : 1,
        (signal) =>
          (this.adapters?.runProcess ?? runProcess)(
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
            observeFailure,
          ),
        abort.signal,
      );
      if (abort.signal.aborted) writableStage(collect, "operation-cancelled");
      else if (wire !== undefined) writableStage(collect, "operation-returned");
      stage = "authority";
      if (
        wire === undefined ||
        abort.signal.aborted ||
        !this.current(document, snapshot) ||
        !this.writable(document)
      ) {
        writableStage(collect, "submission-refused", "after-submission");
        return;
      }
      stage = "parser";
      const plan = parseFormat(wire, snapshot.path, snapshot.text);
      writableStage(collect, "parser-accepted");
      stage = "authority";
      if (plan.status === "skipped")
        this.output.appendLine(`Skipped ${snapshot.path}: ${plan.reason}`);
      if (
        !(await this.writableSnapshot(document, snapshot)) ||
        abort.signal.aborted
      ) {
        writableStage(
          collect,
          "final-authority-declined",
          "format-result-authority",
        );
        return;
      }
      writableStage(collect, "final-authority-accepted");
      return { snapshot, edits: textEdits(plan.edits) };
    } catch (error) {
      if (stage === "operation")
        writableStage(
          collect,
          abort.signal.aborted ? "operation-cancelled" : "operation-failed",
        );
      else if (stage === "parser") writableStage(collect, "parser-failed");
      if (!abort.signal.aborted) this.error(error, true);
      return;
    } finally {
      listener?.dispose();
    }
  }
  async fixAll(
    uri?: vscode.Uri,
    collect?: WritableStageCollector,
    observeFailure?: ProcessFailureObserver,
  ): Promise<void> {
    if (this.disposed) return;
    const document = uri
      ? vscode.workspace.textDocuments.find(
          (doc) => doc.uri.toString() === uri.toString(),
        )
      : vscode.window.activeTextEditor?.document;
    if (!document) {
      writableStage(collect, "snapshot-declined", "fixall-document");
      return;
    }
    const version = document.version;
    const sourceHash = hash(document.getText());
    const folder = vscode.workspace
      .getWorkspaceFolder(document.uri)
      ?.uri.toString();
    if (!folder) {
      writableStage(collect, "snapshot-declined", "fixall-folder");
      return;
    }
    await this.roots.refresh(folder);
    writableStage(collect, "root-refresh-returned");
    const result = await this.formattingResult(
      document,
      "lint-fixes",
      version,
      undefined,
      collect,
      observeFailure,
    );
    if (
      !result?.edits.length ||
      !this.writable(document) ||
      document.version !== version ||
      hash(document.getText()) !== sourceHash
    ) {
      writableStage(collect, "final-authority-declined", "fixall-result");
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, result.edits);
    if (
      !(await this.writableSnapshot(document, result.snapshot)) ||
      !this.writableSnapshotNow(document, result.snapshot)
    ) {
      writableStage(
        collect,
        "final-authority-declined",
        "fixall-write-authority",
      );
      return;
    }
    writableStage(collect, "final-authority-accepted");
    await vscode.workspace.applyEdit(edit);
  }
  change(document: vscode.TextDocument): void {
    if (this.disposed) return;
    const key = document.uri.toString();
    if (
      !this.documentFolders.has(key) &&
      (document.uri.scheme !== "file" ||
        !(/\.ya?ml$/i.test(document.uri.path) || this.isTemplate(document)) ||
        !vscode.workspace.getWorkspaceFolder(document.uri))
    )
      return;
    if (this.pendingDiskReload.delete(key) && !document.isDirty)
      this.queueFile(document.uri, true);
    this.documentRevisions.set(document, ++this.nextRevision);
    this.relatedRevision++;
    this.revokeQueries();
    this.lint.cancel(key);
    this.formatting.cancel(key);
    this.publish(document.uri, true);
    const identity = this.sourceOwners.get(key);
    if (identity) this.publish(vscode.Uri.file(identity.filename), true);
    // Saved related coordinates may now point into a dirty buffer. Primary
    // snapshots and proposals in other documents remain valid.
    for (const uri of this.results.invalidateRelated())
      this.publish(vscode.Uri.parse(uri));
    this.scheduleTyping(document);
  }
  private typingEligible(document: vscode.TextDocument): boolean {
    return (
      this.writable(document) &&
      vscode.workspace
        .getConfiguration("saltboxLint", document.uri)
        .get<boolean>("checkOnType", false)
    );
  }
  private scheduleTyping(document: vscode.TextDocument): void {
    if (!this.typingEligible(document)) {
      this.liveChecks?.cancel(document);
      return;
    }
    this.liveChecks ??= new LiveChecks(
      (document, signal) =>
        this.check(document, false, document.version, true, signal),
      (error) => this.error(error, false),
    );
    this.liveChecks.schedule(document);
  }
  open(document: vscode.TextDocument): void {
    if (this.disposed) return;
    this.closedTabs.delete(document.uri.toString());
    this.eligibilityChanged.fire();
    this.checkBackground(document);
  }
  close(document: vscode.TextDocument): void {
    if (this.disposed) return;
    const key = document.uri.toString();
    const stillOwned = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) =>
        tabDocumentUris(tab).some((uri) => uri.toString() === key),
      ),
    );
    if (!document.isClosed && stillOwned) return;
    this.closedTabs.add(key);
    this.liveChecks?.cancel(document);
    this.roots.forgetSource(key);
    this.failures.delete(key);
    this.eligibilityChanged.fire();
    this.change(document);
    const canonical = this.sourceOwners.get(key)?.filename;
    this.results.close(
      key,
      canonical ? vscode.Uri.file(canonical).toString() : undefined,
    );
    this.collection.delete(document.uri);
    if (document.isClosed) {
      this.closedTabs.delete(key);
      this.sourceOwners.delete(key);
      this.documentFolders.delete(key);
    }
  }
  saved(document: vscode.TextDocument): void {
    if (this.disposed) return;
    this.liveChecks?.cancel(document);
    this.contextEvent(document.uri);
    if (this.eligible(document))
      this.queueFile(document.uri, true, document.version);
  }
  // Watcher, save and observation events fence affected dependency results
  // synchronously, then observe the file off the extension host thread. One
  // FIFO preserves the original event order, including across files, so later
  // completions cannot overtake an earlier discovery-control or atomic event.
  private contextEvent(uri: vscode.Uri): void {
    if (this.disposed || uri.scheme !== "file") return;
    const targets = this.contextTargets(uri);
    if (!targets.length) return;
    const fenced = targets.map((target) => ({
      ...target,
      fence: this.dependencies.reserve(
        target.key,
        target.root,
        target.relative,
      ),
    }));
    const work = (this.contextQueue ?? Promise.resolve()).then(async () => {
      let next = 0;
      try {
        for (; next < fenced.length; next++) {
          const target = fenced[next];
          if (this.disposed || this.roots.get(target.key) !== target.root) {
            this.dependencies.release(target.fence);
            continue;
          }
          const fingerprint = await this.contextFingerprint(uri, target);
          if (this.disposed || this.roots.get(target.key) !== target.root) {
            this.dependencies.release(target.fence);
            continue;
          }
          const affected = this.dependencies.complete(
            target.fence,
            fingerprint,
          );
          if (affected) this.applyContextEvent(uri, target, affected);
        }
      } finally {
        for (; next < fenced.length; next++)
          this.dependencies.release(fenced[next].fence);
      }
    });
    // The tail never rejects; background() reports this event's failure.
    const tail: Promise<void> = work
      .catch(() => undefined)
      .then(() => {
        if (this.contextQueue === tail) this.contextQueue = undefined;
      });
    this.contextQueue = tail;
    this.background(work);
  }
  /**
   * Resolves after every context event admitted before the call has observed
   * its file and applied its dependency invalidation. Follow-up checks queued
   * by those events remain owned by join().
   */
  settleContext(): Promise<void> {
    return this.contextQueue ?? Promise.resolve();
  }
  private contextTargets(uri: vscode.Uri): ContextTarget[] {
    const owner = this.roots.folder(uri);
    const target = owner && this.contextTarget(owner, uri);
    return target ? [target] : [];
  }
  private contextTarget(
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): ContextTarget | undefined {
    const key = folder.uri.toString();
    const root = this.roots.get(key);
    if (!root) return;
    const known = this.sourceOwners.get(uri.toString());
    let relative =
      known?.root === root
        ? known.path
        : path.relative(root, uri.fsPath).split(path.sep).join("/");
    if (
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative)
    ) {
      const configured = path.resolve(
        folder.uri.fsPath,
        vscode.workspace
          .getConfiguration("saltboxLint", folder.uri)
          .get<string>("root", "") || ".",
      );
      relative = path
        .relative(configured, uri.fsPath)
        .split(path.sep)
        .join("/");
    }
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative)
    )
      return;
    return {
      folder,
      key,
      root,
      relative,
      known: known?.root === root ? known : undefined,
      kind: this.dependencies.observationKind(key, relative),
    };
  }
  private async contextFingerprint(
    uri: vscode.Uri,
    { root, relative, known, kind }: ContextTarget,
  ): Promise<string> {
    const files = { ...contextFiles, ...this.adapters?.contextFiles };
    try {
      // Known aliases share the canonical dependency key and its observation.
      // A retargeted alias must still invalidate the old owner instead of
      // borrowing an unchanged fingerprint from its previous destination.
      const filename =
        known && (await files.realpath(uri.fsPath)) === known.filename
          ? known.filename
          : uri.fsPath;
      const stat = await files.lstat(filename, { bigint: true });
      const target = stat.isSymbolicLink()
        ? await files.stat(filename, { bigint: true })
        : undefined;
      let fingerprint = observationFingerprint(stat, target);
      const marker = /^(saltbox|sandbox)\.ya?ml$/.test(relative);
      if (
        (target ?? stat).isFile() &&
        kind !== "metadata" &&
        (!marker || kind === "read")
      ) {
        const actual = path.relative(root, await files.realpath(uri.fsPath));
        if (
          actual === ".." ||
          actual.startsWith(`..${path.sep}`) ||
          path.isAbsolute(actual)
        )
          fingerprint += ":escaped";
        else
          fingerprint = contentFingerprint(
            stat,
            await files.readFile(filename),
            target,
          );
        const after = await files.lstat(filename, { bigint: true });
        const afterTarget = after.isSymbolicLink()
          ? await files.stat(filename, { bigint: true })
          : undefined;
        if (
          observationFingerprint(stat, target) !==
          observationFingerprint(after, afterTarget)
        )
          fingerprint += `:unstable:${++this.nextRevision}`;
      }
      if (
        filename !== uri.fsPath &&
        (await files.realpath(uri.fsPath)) !== filename
      )
        fingerprint += `:unstable:${++this.nextRevision}`;
      return fingerprint;
    } catch {
      return "unavailable";
    }
  }
  private applyContextEvent(
    uri: vscode.Uri,
    { folder, key, root, relative }: ContextTarget,
    affected: ReadonlySet<string>,
  ): void {
    this.revokeQueries();
    this.updateStatus();
    const discoveryControl =
      relative === ".gitignore" ||
      relative === ".git/info/exclude" ||
      relative.endsWith("/.gitignore");
    for (const source of affected) {
      const filename = path.join(root, ...source.split("/"));
      const aliases = [...this.sourceOwners]
        .filter(([, owner]) => owner.root === root && owner.path === source)
        .map(([origin]) => vscode.Uri.parse(origin));
      for (const target of aliases.length
        ? aliases
        : [vscode.Uri.file(filename)]) {
        this.lint.cancel(target.toString());
        this.formatting.cancel(target.toString());
        const document = vscode.workspace.textDocuments.find(
          (doc) => doc.uri.toString() === target.toString(),
        );
        if (document?.isDirty) {
          if (this.typingEligible(document)) {
            this.scheduleTyping(document);
            continue;
          }
          this.output.appendLine(
            `Stale ${source}: analysis context changed; save or check the document to refresh.`,
          );
          continue;
        }
        if (document || !discoveryControl) this.queueFile(target, true);
      }
    }
    if (discoveryControl) {
      this.lint.cancel(`files:${folder.uri}`);
      for (const [pendingKey, pending] of this.pendingFiles) {
        if (this.roots.folder(pending.uri)?.uri.toString() !== key) continue;
        if (
          !vscode.workspace.textDocuments.some(
            (doc) => doc.uri.toString() === pendingKey && !doc.isClosed,
          )
        )
          this.pendingFiles.delete(pendingKey);
      }
      this.scanRevisions.set(key, ++this.nextRevision);
      this.lint.cancel(`workspace:${folder.uri}`);
      this.queueCoverage(folder);
      return;
    }
    if (
      (/\.ya?ml$/i.test(uri.path) &&
        !templatePath(uri.path) &&
        !templatePath(relative)) ||
      vscode.workspace.textDocuments.some(
        (document) =>
          document.uri.toString() === uri.toString() && this.eligible(document),
      )
    )
      this.queueFile(uri);
    // No completed coverage exists during startup. Any context event retains
    // the existing queue's full scan fallback, including non-YAML templates.
    if (!this.results.hasCompleteScan(key)) {
      this.scanRevisions.set(key, ++this.nextRevision);
      this.lint.cancel(`workspace:${folder.uri}`);
      this.queueCoverage(folder);
    }
  }
  private queueCoverage(folder: vscode.WorkspaceFolder): void {
    this.results.invalidateCoverage(folder.uri.toString());
    if (!this.pendingRefresh.has(folder.uri.toString())) {
      this.pendingRefresh.add(folder.uri.toString());
      this.refreshTimer?.();
      this.refreshTimer = this.schedule(() => {
        this.refreshTimer = undefined;
        const pending = new Set(this.pendingRefresh);
        this.pendingRefresh.clear();
        for (const current of vscode.workspace.workspaceFolders ?? [])
          if (
            pending.has(current.uri.toString()) &&
            this.roots.get(current.uri.toString())
          )
            this.background(this.checkSaved(current, false));
      }, 100);
    }
  }
  private queueFile(uri: vscode.Uri, force = false, version?: number): void {
    if (
      this.disposed ||
      uri.scheme !== "file" ||
      (!/\.ya?ml$/i.test(uri.path) &&
        !vscode.workspace.textDocuments.some(
          (document) =>
            document.uri.toString() === uri.toString() &&
            this.isTemplate(document) &&
            this.eligible(document),
        ))
    )
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
    this.fileTimer?.();
    this.fileTimer = this.schedule(() => {
      this.fileTimer = undefined;
      this.background(this.flushFiles());
    }, 100);
  }
  private async flushFiles(): Promise<void> {
    if (this.disposed || this.flushingFiles) return;
    this.flushingFiles = true;
    // A batch starts after admitted context events have queued their files
    // and updated dependency revisions, as synchronous events did. The queue
    // tail never rejects; failures are reported by the event's own work.
    if (this.contextQueue) await this.contextQueue;
    if (this.disposed) {
      this.flushingFiles = false;
      return;
    }
    const pending = [...this.pendingFiles.values()];
    this.pendingFiles.clear();
    const affected = new Map<string, number>();
    const admissions = new Map<string, number>();
    const selected = new Map<
      string,
      Map<
        string,
        {
          filename: string;
          sourceHash: string;
          uri: vscode.Uri;
          fingerprint: string;
        }
      >
    >();
    try {
      for (const { uri, force, version } of pending) {
        const folder = this.roots.folder(uri);
        if (!folder) continue;
        const folderKey = folder.uri.toString();
        if (!admissions.has(folderKey))
          admissions.set(
            folderKey,
            this.dependencies.admissionRevision(folderKey),
          );
        if (!affected.has(folderKey))
          affected.set(folderKey, this.rootRevision(folderKey));
        const revision = affected.get(folderKey)!;
        const root = await this.root(folder);
        if (!root || revision !== this.rootRevision(folderKey)) continue;
        const key = uri.toString();
        let filename: string | undefined;
        try {
          const identity = await identify(root, uri.fsPath);
          if (
            (templatePath(uri.path) ||
              templatePath(identity.path) ||
              templatePath(identity.filename)) &&
            !vscode.workspace.textDocuments.some(
              (document) =>
                document.uri.toString() === key && this.eligible(document),
            )
          )
            continue;
          filename = identity.filename;
          const bytes = await (this.adapters?.readFile ?? readFile)(
            identity.filename,
          );
          const sourceHash = hash(bytes);
          this.missingFiles.delete(key);
          const document = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.toString() === key && !doc.isClosed,
          );
          const fingerprint = `${root}:${sourceHash}:${document?.version ?? 0}`;
          if (!force && this.fileFingerprints.get(key) === fingerprint)
            continue;
          if (document) {
            if (
              document.isDirty ||
              (version !== undefined && document.version !== version)
            )
              continue;
            if (!document.isDirty && document.getText() !== editorText(bytes)) {
              this.pendingDiskReload.add(key);
              continue;
            }
            if (force || !document.isDirty) {
              const previous = this.results.document(key)?.id;
              await this.check(document, false, document.version);
              const result = this.results.document(key);
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
              sourceHash,
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
        const current = () =>
          !this.disposed &&
          !!this.roots.get(key) &&
          affected.get(key) === this.rootRevision(key) &&
          admissions.get(key) === this.dependencies.admissionRevision(key);
        if (!current()) continue;
        const folder = vscode.workspace.workspaceFolders?.find(
          (folder) => folder.uri.toString() === key,
        );
        if (!folder) continue;
        // Watcher arrival order varies by platform. Canonical paths give the
        // same coalesced selection stable chunk membership and CLI ordering.
        const entries = [...files].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        for (let offset = 0; offset < entries.length; offset += 64) {
          // Closed selections retain the authority that admitted this flush.
          // A later chunk must not adopt a new root or ignore decision.
          if (!current()) break;
          const batch = new Map(entries.slice(offset, offset + 64));
          const accepted = await this.checkSaved(folder, false, batch);
          if (!current()) break;
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
          !this.results.hasCompleteScan(key) &&
          !this.pendingRefresh.has(key)
        )
          await this.checkSaved(folder, false);
      }
    } finally {
      this.flushingFiles = false;
      if (this.pendingFiles.size && !this.fileTimer)
        this.fileTimer = this.schedule(() => {
          this.fileTimer = undefined;
          this.background(this.flushFiles());
        }, 100);
    }
  }
  removeFile(uri: vscode.Uri): void {
    this.contextEvent(uri);
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
    this.results.forget(keys);
    const owner = this.sourceOwners.get(key);
    if (owner)
      this.dependencies.remove(this.documentFolders.get(key) ?? "", owner.path);
    for (const target of keys) {
      this.lint.cancel(target);
      this.formatting.cancel(target);
      this.collection.delete(vscode.Uri.parse(target));
    }
    const folder = this.roots.folder(uri);
    if (folder) {
      const root = this.roots.get(folder.uri.toString());
      if (root) {
        const relative = path
          .relative(root, canonical ?? uri.fsPath)
          .split(path.sep)
          .join("/");
        if (
          relative &&
          relative !== ".." &&
          !relative.startsWith("../") &&
          !path.isAbsolute(relative)
        )
          this.dependencies.remove(folder.uri.toString(), relative);
      }
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
      for (const uri of uris) this.contextEvent(uri);
      uris = uris.filter(
        (uri) =>
          this.rootRevisions.has(uri.toString()) ||
          [...this.canonicalRoots.values()].includes(uri.fsPath) ||
          vscode.workspace.workspaceFolders?.some(
            (folder) => folder.uri.toString() === uri.toString(),
          ),
      );
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
        let filename = uri.fsPath;
        try {
          // Workspace events retain the public spelling; cached roots use the
          // native identity. A nested owner must invalidate its canonical parent.
          filename = realpathSync.native(filename);
        } catch {
          // Removed paths still retain their known workspace and root keys.
        }
        for (const [key, root] of this.canonicalRoots) {
          const relative = path.relative(root, filename);
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
    this.liveChecks?.cancelWhere((document) =>
      affected.has(
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ??
          this.documentFolders.get(document.uri.toString()) ??
          "",
      ),
    );
    if (affected.size) this.revokeQueries();
    for (const folder of affected) {
      this.dependencies.remove(folder);
      this.rootRevisions.set(folder, ++this.nextRevision);
      this.pendingRefresh.add(folder);
      this.lint.cancel(`workspace:${folder}`);
      this.lint.cancel(`files:${folder}`);
      const owned = [...this.documentFolders]
        .filter(([, owner]) => owner === folder)
        .map(([uri]) => uri);
      for (const uri of this.results.refresh(folder, owned))
        this.publish(vscode.Uri.parse(uri));
      for (const [uri, ownerFolder] of this.documentFolders) {
        if (ownerFolder !== folder) continue;
        this.lint.cancel(uri);
        this.formatting.cancel(uri);
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
    this.refreshTimer?.();
    this.refreshTimer = this.schedule(() => {
      this.refreshTimer = undefined;
      const pending = new Set(this.pendingRefresh);
      this.pendingRefresh.clear();
      for (const folder of vscode.workspace.workspaceFolders ?? [])
        if (pending.has(folder.uri.toString()))
          this.background(this.checkSaved(folder, false));
      for (const document of vscode.workspace.textDocuments) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const result = this.results.document(document.uri.toString());
        if (
          folder &&
          pending.has(folder.uri.toString()) &&
          this.eligible(document) &&
          (!result || !this.current(document, result.snapshot))
        )
          this.background(this.check(document));
      }
    }, 100);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.liveChecks?.dispose();
    this.refreshTimer?.();
    this.fileTimer?.();
    this.refreshTimer = undefined;
    this.fileTimer = undefined;
    this.producerChanged();
    this.pendingFiles.clear();
    this.results.clear();
    this.dependencies.clear();
    this.lint.dispose();
    this.formatting.dispose();
    for (const lane of this.queryLanes.values()) lane.dispose();
    this.failures.clear();
    disposeResources([
      this.rootListener,
      this.fileListener,
      this.displayListeners,
      this.roots,
      this.eligibilityChanged,
      this.navigation,
      this.collection,
      this.output,
      this.help,
      this.statusBar,
    ]);
  }
  async join(): Promise<void> {
    await this.initialization?.catch(() => undefined);
    do {
      const producers =
        this.fileTimer || this.refreshTimer
          ? new Promise<void>((resolve) =>
              (this.producerWaiters ??= new Set()).add(resolve),
            )
          : undefined;
      await Promise.all([
        this.lint.join(),
        this.formatting.join(),
        ...[...this.queryLanes.values()].map((lane) => lane.join()),
        ...[...this.checking.values()].map((request) => request.work),
        ...(this.backgroundWork ?? []),
        this.liveChecks?.join(),
        this.help.join(),
        this.roots.join?.(),
        producers,
      ]);
    } while (
      this.fileTimer ||
      this.refreshTimer ||
      this.backgroundWork?.size ||
      this.checking.size
    );
    await this.initialization;
  }
}

export function tabDocumentUris(tab: vscode.Tab): readonly vscode.Uri[] {
  if (tab.input instanceof vscode.TabInputText) return [tab.input.uri];
  if (tab.input instanceof vscode.TabInputTextDiff)
    return [tab.input.original, tab.input.modified];
  return [];
}
