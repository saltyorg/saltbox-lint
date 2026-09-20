// Test-only observations for a failing nested-root formatter assertion.
import * as vscode from "vscode";
import { createRequire } from "node:module";
import { basename } from "node:path";

export function observeRootFormatting(document: vscode.TextDocument) {
  const require = createRequire(__filename);
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const childProcess =
    require("node:child_process") as typeof import("node:child_process");
  const started = Date.now();
  const events: unknown[] = [];
  const record = (kind: string, details: unknown) => {
    if (events.length < 256)
      events.push({ ms: Date.now() - started, kind, details });
  };
  const errorInfo = (error: unknown) =>
    error instanceof Error
      ? { message: error.message, code: (error as NodeJS.ErrnoException).code }
      : String(error);
  const details = () => ({
    uri: document.uri.toString(),
    version: document.version,
    language: document.languageId,
    closed: document.isClosed,
    dirty: document.isDirty,
    configuredRoot: vscode.workspace
      .getConfiguration("saltboxLint", document.uri)
      .get("root"),
    diagnostics: vscode.languages
      .getDiagnostics(document.uri)
      .filter((item) => item.source === "saltbox-lint")
      .map((item) => ({ code: item.code, line: item.range.start.line })),
  });
  const roots = (vscode.workspace.workspaceFolders ?? []).map(
    (folder) => folder.uri.fsPath,
  );
  const relevant = (value: unknown) => {
    const filename = String(value);
    return roots.some((root) => filename.startsWith(root));
  };
  const originalLstat = fs.lstat;
  const originalRealpath = fs.realpath;
  const originalSpawn = childProcess.spawn;
  const lstatDescriptor = Object.getOwnPropertyDescriptor(fs, "lstat")!;
  const realpathDescriptor = Object.getOwnPropertyDescriptor(fs, "realpath")!;
  const spawnDescriptor = Object.getOwnPropertyDescriptor(
    childProcess,
    "spawn",
  )!;
  const formatListeners: Array<() => void> = [];
  const listeners: vscode.Disposable[] = [];
  const dispose = () => {
    Object.defineProperty(fs, "lstat", lstatDescriptor);
    Object.defineProperty(fs, "realpath", realpathDescriptor);
    Object.defineProperty(childProcess, "spawn", spawnDescriptor);
    formatListeners.forEach((remove) => remove());
    listeners.forEach((listener) => listener.dispose());
  };
  try {
    Object.defineProperty(fs, "lstat", {
      ...lstatDescriptor,
      value: (...args: Parameters<typeof originalLstat>) => {
        const result = Reflect.apply(originalLstat, fs, args) as ReturnType<
          typeof originalLstat
        >;
        if (
          basename(String(args[0])) === ".saltbox-lint" &&
          relevant(args[0])
        ) {
          record("marker-stat-start", String(args[0]));
          void result.then(
            (stat) =>
              record("marker-stat-end", {
                path: String(args[0]),
                file: stat.isFile(),
                symlink: stat.isSymbolicLink(),
                dev: String(stat.dev),
                ino: String(stat.ino),
                mtime: String(stat.mtimeMs),
              }),
            (error: unknown) => record("marker-stat-error", errorInfo(error)),
          );
        }
        return result;
      },
    });
    Object.defineProperty(fs, "realpath", {
      ...realpathDescriptor,
      value: (...args: Parameters<typeof originalRealpath>) => {
        const result = Reflect.apply(originalRealpath, fs, args) as ReturnType<
          typeof originalRealpath
        >;
        if (relevant(args[0])) {
          record("realpath-start", String(args[0]));
          void result.then(
            (path) => record("realpath-end", { input: String(args[0]), path }),
            (error: unknown) => record("realpath-error", errorInfo(error)),
          );
        }
        return result;
      },
    });
    Object.defineProperty(childProcess, "spawn", {
      ...spawnDescriptor,
      value: (...args: Parameters<typeof originalSpawn>) => {
        const child = Reflect.apply(
          originalSpawn,
          childProcess,
          args,
        ) as ReturnType<typeof originalSpawn>;
        if (Array.isArray(args[1]) && args[1][0] === "format") {
          record("format-spawn", {
            pid: child.pid,
            executable: args[0],
            args: args[1],
          });
          const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
            record("format-exit", { pid: child.pid, code, signal });
          const onClose = (
            code: number | null,
            signal: NodeJS.Signals | null,
          ) => record("format-close", { pid: child.pid, code, signal });
          const onError = (error: Error) =>
            record("format-error", errorInfo(error));
          child.once("exit", onExit);
          child.once("close", onClose);
          child.once("error", onError);
          formatListeners.push(() => {
            child.off("exit", onExit);
            child.off("close", onClose);
            child.off("error", onError);
          });
        }
        return child;
      },
    });
    listeners.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("saltboxLint.root", document.uri))
          record("configuration-event", details());
      }),
    );
    listeners.push(
      vscode.languages.onDidChangeDiagnostics((event) => {
        if (
          event.uris.some((uri) => uri.toString() === document.uri.toString())
        )
          record("diagnostics-event", details());
      }),
    );
    record("observe-start", details());
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    note(label: string, extra?: unknown) {
      record(label, { ...details(), extra });
    },
    report() {
      return JSON.stringify({ current: details(), events });
    },
    dispose,
  };
}
