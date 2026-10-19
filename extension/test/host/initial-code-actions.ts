import * as vscode from "vscode";
import assert from "node:assert/strict";
import { initialCodeAction } from "../support/initial-code-action.ts";
import type { TestResources } from "../support/test-resources.ts";
import type {
  CodeActionEvidence,
  ActionEvidenceStage,
} from "../support/code-action-evidence.ts";

export function sdkCancellation(error: unknown): boolean {
  return (
    error instanceof vscode.CancellationError ||
    (error instanceof Error && error.name === "Canceled")
  );
}

/** Only for initial fixture acquisition, before any tested mutation. */
export async function initialCodeActions(
  resources: TestResources,
  document: vscode.TextDocument,
  range: vscode.Range,
  available: (actions: readonly vscode.CodeAction[]) => boolean,
  options: {
    evidence?: CodeActionEvidence;
    stage?: ActionEvidenceStage;
    request?: () => Thenable<vscode.CodeAction[]>;
  } = {},
) {
  const before = {
    uri: document.uri.toString(),
    version: document.version,
    language: document.languageId,
    text: document.getText(),
  };
  const result = await resources.operation(
    "initial SDK code action availability",
    () =>
      initialCodeAction({
        signal: resources.signal,
        guard() {
          assert.equal(document.isClosed, false, "initial source remains open");
          assert.equal(document.uri.toString(), before.uri);
          assert.equal(
            document.version,
            before.version,
            "initial source version remains unchanged",
          );
          assert.equal(document.languageId, before.language);
          assert.equal(
            document.getText(),
            before.text,
            "initial source bytes remain unchanged",
          );
        },
        isCancellation: sdkCancellation,
        async read() {
          const query = options.evidence?.begin(options.stage ?? "warm", range);
          const returned = await (options.request?.() ??
            vscode.commands.executeCommand<vscode.CodeAction[]>(
              "vscode.executeCodeActionProvider",
              document.uri,
              range,
            ));
          if (query)
            options.evidence!.returned(
              query,
              returned,
              returned.filter((action) => action.title.includes("this file")),
            );
          return available(returned) ? returned : undefined;
        },
      }),
  );
  resources.signal.throwIfAborted();
  console.log(
    "SALTBOX_INITIAL_ACTIONS " +
      JSON.stringify({
        uri: before.uri,
        version: before.version,
        queries: result.queries,
        cancellations: result.cancellations,
        elapsedMs: result.elapsedMs,
      }),
  );
  return { ...result, actions: result.value };
}
