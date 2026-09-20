import * as vscode from "vscode";
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { canonicalRoot } from "./identity.ts";

export const rootMarker = ".saltbox-lint";
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
        new vscode.RelativePattern(
          vscode.Uri.file(root),
          "**/*.{[yY][mM][lL],[yY][aA][mM][lL]}",
        ),
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
      const refresh = () => {
        if (this.roots.get(key) !== root || this.unchangedMarker(root)) return;
        void this.probe(key, root);
      };
      root.watcher = vscode.Disposable.from(
        watcher,
        watcher.onDidCreate(refresh),
        watcher.onDidDelete(() => this.probe(key, root)),
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
        const stat = await lstat(path.join(root.source, rootMarker), {
          bigint: true,
        });
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
