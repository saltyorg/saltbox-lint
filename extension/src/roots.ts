import * as vscode from "vscode";
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { canonicalRoot, type Identity } from "./identity.ts";
import {
  combineDisposables,
  disposeResources,
  rollbackResources,
} from "./disposables.ts";

export const rootMarker = ".saltbox-lint";
export interface RootAdapters {
  lstat: typeof lstat;
  createFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher;
}
interface Root {
  source: string;
  canonical?: string;
  markerIdentity?: string;
  revision: number;
  ready: Promise<void>;
  watcher: vscode.Disposable;
}

// Access time can change when the marker is merely read. Preserve the remaining
// identity and change metadata at native precision, including replacement inodes.
function markerIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ].join(":");
}

// Marker probes run at setup, on filesystem/configuration events and manual commands.
// Invalidation is synchronous; a superseded probe cannot restore eligibility.
export class MarkedRoots implements vscode.Disposable {
  constructor(
    private readonly reportError: (error: unknown) => void = console.error,
    private readonly adapters: Partial<RootAdapters> = {},
  ) {
    this.changed = new vscode.EventEmitter<string>();
    try {
      this.fileChanged = new vscode.EventEmitter<vscode.Uri>();
    } catch (error) {
      rollbackResources(error, [this.changed]);
    }
    this.onDidChange = this.changed.event;
    this.onDidChangeFile = this.fileChanged.event;
  }
  private readonly roots = new Map<string, Root>();
  private readonly probes = new Set<Promise<void>>();
  private disposed = false;
  private readonly changed: vscode.EventEmitter<string>;
  readonly onDidChange: vscode.Event<string>;
  private readonly fileChanged: vscode.EventEmitter<vscode.Uri>;
  readonly onDidChangeFile: vscode.Event<vscode.Uri>;
  private readonly fileWatchers = new Map<string, vscode.Disposable>();

  private readonly sourceWatchers = new Map<
    string,
    { root: string; filename: string; watcher: vscode.Disposable }
  >();

  watchSource(uri: vscode.Uri, identity: Identity): void {
    if (this.disposed) return;
    if (
      ![...this.roots.values()].some((root) => root.canonical === identity.root)
    )
      return;
    const relative = path.relative(identity.root, identity.filename);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return;
    const key = uri.toString();
    const old = this.sourceWatchers.get(key);
    if (old?.root === identity.root && old.filename === identity.filename)
      return;
    this.forgetSource(key);
    const acquired: vscode.Disposable[] = [];
    try {
      for (const filename of new Set([uri.fsPath, identity.filename])) {
        const literal = path
          .basename(filename)
          .replace(/[\[\]*?{}]/g, (character) => `[${character}]`);
        const watcher = this.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(filename)),
            literal,
          ),
        );
        acquired.push(watcher);
        const changed = (changed: vscode.Uri) => this.fileChanged.fire(changed);
        acquired.push(watcher.onDidCreate(changed));
        acquired.push(watcher.onDidChange(changed));
        acquired.push(watcher.onDidDelete(changed));
      }
    } catch (error) {
      rollbackResources(error, acquired);
    }
    this.sourceWatchers.set(key, {
      root: identity.root,
      filename: identity.filename,
      watcher: combineDisposables(acquired),
    });
  }
  forgetSource(key: string): void {
    this.sourceWatchers.get(key)?.watcher.dispose();
    this.sourceWatchers.delete(key);
  }

  // Known workspace owners (including unmarked folders) take precedence.
  // Ownerless canonical files belong to the most specific active source root.
  folder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    const owner = vscode.workspace.getWorkspaceFolder(uri);
    if (owner) return owner;
    let selected: vscode.WorkspaceFolder | undefined;
    let length = -1;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = this.get(folder.uri.toString());
      if (!root || root.length <= length) continue;
      const relative = path.relative(root, uri.fsPath);
      if (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        selected = folder;
        length = root.length;
      }
    }
    return selected;
  }
  private synchronizeFileWatchers(): void {
    const active = new Set(
      [...this.roots.values()].flatMap((root) =>
        root.canonical ? [root.canonical] : [],
      ),
    );
    for (const [key, source] of this.sourceWatchers) {
      if (!active.has(source.root)) this.forgetSource(key);
    }
    for (const [root, watcher] of this.fileWatchers) {
      if (active.has(root)) continue;
      watcher.dispose();
      this.fileWatchers.delete(root);
    }
    for (const root of active) {
      if (this.fileWatchers.has(root)) continue;
      const changed = (uri: vscode.Uri) => this.fileChanged.fire(uri);
      const acquired: vscode.Disposable[] = [];
      try {
        for (const pattern of [
          "**/*.{[yY][mM][lL],[yY][aA][mM][lL]}",
          "**/templates/**",
          "**/*.j2",
          "**/.gitignore",
          ".git/info/exclude",
        ]) {
          const watcher = this.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(root), pattern),
          );
          acquired.push(watcher);
          acquired.push(watcher.onDidCreate(changed));
          acquired.push(watcher.onDidChange(changed));
          acquired.push(watcher.onDidDelete(changed));
        }
        this.fileWatchers.set(root, combineDisposables(acquired));
      } catch (error) {
        rollbackResources(error, acquired);
      }
    }
  }

  configure(): void {
    if (this.disposed) return;
    const folders = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      const key = folder.uri.toString();
      folders.add(key);
      const source = path.resolve(
        folder.uri.fsPath,
        vscode.workspace
          .getConfiguration("saltboxLint", folder.uri)
          .get<string>("root", "") || ".",
      );
      if (this.roots.get(key)?.source === source) continue;
      this.remove(key);
      const watcher = this.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(source), rootMarker),
      );
      const root: Root = {
        source,
        revision: 0,
        ready: Promise.resolve(),
        watcher,
      };
      const refresh = () => {
        if (this.roots.get(key) !== root || this.unchangedMarker(root)) return;
        this.startProbe(key, root);
      };
      const acquired: vscode.Disposable[] = [watcher];
      try {
        acquired.push(watcher.onDidCreate(refresh));
        acquired.push(watcher.onDidDelete(() => this.startProbe(key, root)));
        acquired.push(watcher.onDidChange(refresh));
        root.watcher = combineDisposables(acquired);
      } catch (error) {
        rollbackResources(error, acquired);
      }
      this.roots.set(key, root);
      this.startProbe(key, root);
    }
    for (const key of this.roots.keys())
      if (!folders.has(key)) this.remove(key);
  }
  private remove(key: string): void {
    const root = this.roots.get(key);
    if (!root) return;
    root.revision++;
    root.watcher.dispose();
    this.roots.delete(key);
    this.synchronizeFileWatchers();
    this.changed.fire(key);
  }
  async refresh(folder?: string): Promise<void> {
    if (this.disposed) return;
    await Promise.all(
      [...this.roots]
        .filter(([key]) => !folder || key === folder)
        .map(([key, root]) => this.probe(key, root, false)),
    );
  }
  private unchangedMarker(root: Root): boolean {
    if (!root.canonical || !root.markerIdentity) return false;
    // This synchronous check is limited to marker control events. It avoids
    // revoking verified work for duplicates while changes still revoke before
    // returning from the watcher callback, without awaiting filesystem I/O.
    try {
      const stat = lstatSync(path.join(root.source, rootMarker), {
        bigint: true,
      });
      return (
        stat.isFile() &&
        markerIdentity(stat) === root.markerIdentity &&
        realpathSync.native(root.source) === root.canonical
      );
    } catch {
      return false;
    }
  }
  private probe(key: string, root: Root, invalidate = true): Promise<void> {
    if (this.roots.get(key) !== root) return Promise.resolve();
    const revision = ++root.revision;
    if (invalidate) {
      root.canonical = undefined;
      root.markerIdentity = undefined;
      this.synchronizeFileWatchers();
      this.changed.fire(key);
    }
    root.ready = (async () => {
      let canonical: string | undefined;
      let identity: string | undefined;
      try {
        const stat = await (this.adapters.lstat ?? lstat)(
          path.join(root.source, rootMarker),
          {
            bigint: true,
          },
        );
        if (
          this.disposed ||
          root.revision !== revision ||
          this.roots.get(key) !== root
        )
          return;
        if (stat.isFile()) {
          canonical = await canonicalRoot(root.source, "");
          identity = markerIdentity(stat);
        }
      } catch {
        // Missing/inaccessible/nonregular markers do not opt a root in.
      }
      if (root.revision !== revision || this.roots.get(key) !== root) return;
      if (
        invalidate ||
        root.canonical !== canonical ||
        root.markerIdentity !== identity
      ) {
        root.canonical = canonical;
        root.markerIdentity = identity;
        this.synchronizeFileWatchers();
        this.changed.fire(key);
      }
    })();
    const work = root.ready;
    this.probes.add(work);
    work.then(
      () => {
        this.probes.delete(work);
      },
      () => {
        this.probes.delete(work);
      },
    );
    return root.ready;
  }
  private createFileSystemWatcher(
    ...args: Parameters<typeof vscode.workspace.createFileSystemWatcher>
  ): vscode.FileSystemWatcher {
    return (
      this.adapters.createFileSystemWatcher ??
      vscode.workspace.createFileSystemWatcher
    )(...args);
  }
  private startProbe(key: string, root: Root): void {
    // Keep root.ready as the actual probe. Event reporting must not turn a
    // rejected readiness check into successful eligibility for its waiters.
    this.probe(key, root).catch(this.reportError);
  }
  get(folder: string): string | undefined {
    return this.roots.get(folder)?.canonical;
  }
  async ready(): Promise<void> {
    await Promise.all([...this.roots.values()].map((root) => root.ready));
  }
  async join(): Promise<void> {
    while (this.probes.size) await Promise.allSettled(this.probes);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const acquired: vscode.Disposable[] = [];
    for (const root of this.roots.values()) {
      root.revision++;
      acquired.push(root.watcher);
    }
    this.roots.clear();
    for (const source of this.sourceWatchers.values())
      acquired.push(source.watcher);
    this.sourceWatchers.clear();
    acquired.push(...this.fileWatchers.values());
    this.fileWatchers.clear();
    acquired.push(this.fileChanged, this.changed);
    disposeResources(acquired);
  }
}
