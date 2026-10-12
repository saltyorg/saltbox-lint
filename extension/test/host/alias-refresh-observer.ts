import * as vscode from "vscode";
import type { EditorIntegration } from "../../src/editor.ts";
import { diagnosticCode } from "./diagnostic-code.ts";

/** Observe public eligibility and diagnostics without wrapping product work. */
export function observeAliasRefresh(
  editor: EditorIntegration,
  document: vscode.TextDocument,
  template: vscode.Uri,
) {
  const registeredAt = new Date().toISOString();
  const alias = document.uri.toString();
  const events: unknown[] = [];
  let count = 0,
    disposed = false;
  const capture = (phase: string) => {
    if (disposed) return;
    let facts: unknown;
    try {
      const diagnostics = vscode.languages
        .getDiagnostics(document.uri)
        .filter((item) => item.source === "saltbox-lint");
      facts = {
        document: {
          uri: alias,
          version: document.version,
          isClosed: document.isClosed,
          isDirty: document.isDirty,
        },
        admittedProvider: editor.providerDocuments().includes(document),
        status: editor.status(document).state,
        diagnostics: {
          count: diagnostics.length,
          truncated: diagnostics.length > 16,
          codes: diagnostics.slice(0, 16).map(diagnosticCode),
        },
      };
    } catch (error) {
      facts = {
        state: "unavailable",
        errorName: error instanceof Error ? error.name : "unknown error",
      };
    }
    count++;
    events.push({ capturedAt: new Date().toISOString(), phase, facts });
    if (events.length > 32) events.shift();
  };
  const subscriptions = vscode.Disposable.from(
    editor.onDidChangeEligibility(() => capture("public eligibility changed")),
    vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((uri) => uri.toString() === alias))
        capture("public alias diagnostics changed");
    }),
  );
  capture("initial admitted alias before template mutation");
  return {
    snapshot: () => {
      capture("snapshot at collection");
      return {
        schemaVersion: 1,
        boundary: "public-eligibility-and-diagnostics",
        registeredAt,
        capturedAt: new Date().toISOString(),
        alias,
        template: template.toString(),
        count,
        truncated: count > events.length,
        events: [...events],
      };
    },
    dispose: () => {
      subscriptions.dispose();
      disposed = true;
    },
  };
}
