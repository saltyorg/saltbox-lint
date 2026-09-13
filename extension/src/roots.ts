import * as vscode from "vscode";
import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { canonicalRoot } from "./identity.ts";

export const rootMarker = ".saltbox-lint";
interface Root {
  source: string;
  canonical?: string;
  revision: number;
  ready: Promise<void>;
  watcher: vscode.Disposable;
}

// Marker probes run at setup, on filesystem/configuration events and manual commands.
// Invalidation is synchronous; a superseded probe cannot restore eligibility.
export class MarkedRoots implements vscode.Disposable {
  private readonly roots = new Map<string, Root>();
  private readonly changed = new vscode.EventEmitter<string>();
  readonly onDidChange = this.changed.event;
  private readonly fileChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeFile = this.fileChanged.event;
  private readonly fileWatchers = new Map<string, vscode.Disposable>();

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
    for (const [root, watcher] of this.fileWatchers) {
      if (active.has(root)) continue;
      watcher.dispose();
      this.fileWatchers.delete(root);
    }
    for (const root of active) {
      if (this.fileWatchers.has(root)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), "**/*.{yml,yaml}"),
      );
      const changed = (uri: vscode.Uri) => this.fileChanged.fire(uri);
      this.fileWatchers.set(
        root,
        vscode.Disposable.from(
          watcher,
          watcher.onDidCreate(changed),
          watcher.onDidChange(changed),
          watcher.onDidDelete(changed),
        ),
      );
    }
  }

  configure(): void {
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
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(source), rootMarker),
      );
      const root: Root = {
        source,
        revision: 0,
        ready: Promise.resolve(),
        watcher,
      };
      this.roots.set(key, root);
      const refresh = () => this.probe(key, root);
      root.watcher = vscode.Disposable.from(
        watcher,
        watcher.onDidCreate(refresh),
        watcher.onDidDelete(refresh),
        watcher.onDidChange(refresh),
      );
      this.probe(key, root);
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
    await Promise.all(
      [...this.roots]
        .filter(([key]) => !folder || key === folder)
        .map(([key, root]) => this.probe(key, root, false)),
    );
  }
  private probe(key: string, root: Root, invalidate = true): Promise<void> {
    const revision = ++root.revision;
    if (invalidate) {
      root.canonical = undefined;
      this.synchronizeFileWatchers();
      this.changed.fire(key);
    }
    root.ready = (async () => {
      let canonical: string | undefined;
      try {
        if ((await lstat(path.join(root.source, rootMarker))).isFile())
          canonical = await canonicalRoot(root.source, "");
      } catch {
        // Missing/inaccessible/nonregular markers do not opt a root in.
      }
      if (root.revision !== revision || this.roots.get(key) !== root) return;
      if (invalidate || root.canonical !== canonical) {
        root.canonical = canonical;
        this.synchronizeFileWatchers();
        this.changed.fire(key);
      }
    })();
    return root.ready;
  }
  get(folder: string): string | undefined {
    return this.roots.get(folder)?.canonical;
  }
  async ready(): Promise<void> {
    await Promise.all([...this.roots.values()].map((root) => root.ready));
  }
  dispose(): void {
    for (const root of this.roots.values()) {
      root.revision++;
      root.watcher.dispose();
    }
    this.roots.clear();
    this.synchronizeFileWatchers();
    this.fileChanged.dispose();
    this.changed.dispose();
  }
}
