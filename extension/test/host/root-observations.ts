// Failure evidence from public editor events, without global native API patches.
import * as vscode from "vscode";

export function observeRootFormatting(document: vscode.TextDocument) {
  const started = Date.now();
  const events: unknown[] = [];
  const record = (kind: string, details: unknown) => {
    if (events.length < 256)
      events.push({ ms: Date.now() - started, kind, details });
  };
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
  const listeners = [
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("saltboxLint.root", document.uri))
        record("configuration-event", details());
    }),
    vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((uri) => uri.toString() === document.uri.toString()))
        record("diagnostics-event", details());
    }),
  ];
  record("observe-start", details());
  return {
    note(label: string, extra?: unknown) {
      record(label, { ...details(), extra });
    },
    report() {
      return JSON.stringify({ current: details(), events });
    },
    dispose() {
      listeners.forEach((listener) => listener.dispose());
    },
  };
}
