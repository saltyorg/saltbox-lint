import * as vscode from "vscode";
import * as path from "node:path";
import type { EditorIntegration } from "./editor.ts";
import { combineDisposables, rollbackResources } from "./disposables.ts";

// Temporary boundary trace for the cold native SDK cancellation investigation.
const traceRecords: Record<string, unknown>[] = [];
function trace(event: Record<string, unknown>): void {
  if (process.env.SALTBOX_LINT_TRACE_CODE_ACTIONS !== "1") return;
  if (traceRecords.length === 64) traceRecords.shift();
  traceRecords.push(event);
}
export function flushProviderTrace(): void {
  for (const event of traceRecords.splice(0))
    console.error("SALTBOX_PROVIDER_TRACE " + JSON.stringify(event));
}

export interface ProviderRegistration {
  language: string;
  writable: boolean;
  disposable: vscode.Disposable;
}

export interface ProviderAdapters {
  registerDocumentFormattingEditProvider: typeof vscode.languages.registerDocumentFormattingEditProvider;
}

export function updateProviders(
  editor: Pick<
    EditorIntegration,
    "providerDocuments" | "writable" | "actions" | "navigation" | "format"
  >,
  providers: Map<string, ProviderRegistration>,
  adapters: Partial<ProviderAdapters> = {},
): void {
  const documents = new Map(
    editor
      .providerDocuments()
      .map((document) => [document.uri.toString(), document]),
  );
  for (const [key, registration] of providers) {
    const document = documents.get(key);
    if (
      document?.languageId === registration.language &&
      editor.writable(document) === registration.writable
    )
      continue;
    trace({ phase: "dispose", uri: key });
    registration.disposable.dispose();
    providers.delete(key);
  }
  for (const [key, document] of documents) {
    if (providers.has(key)) continue;
    const selector: vscode.DocumentSelector = [
      {
        scheme: "file",
        language: document.languageId,
        pattern: new vscode.RelativePattern(
          vscode.Uri.file(path.dirname(document.uri.fsPath)),
          path.basename(document.uri.fsPath).replace(/[?*{}[\]]/g, "[$&]"),
        ),
      },
    ];
    const writable = editor.writable(document);
    trace({ phase: "register", uri: key, selector, writable });
    let observations = 0;
    const acquired: vscode.Disposable[] = [];
    const own = (registration: vscode.Disposable) =>
      acquired.push(registration);
    try {
      own(
        vscode.languages.registerCodeActionsProvider(
          selector,
          {
            provideCodeActions: (document, range, context, token) => {
              const observe =
                process.env.SALTBOX_LINT_TRACE_CODE_ACTIONS === "1" &&
                context.triggerKind === vscode.CodeActionTriggerKind.Invoke &&
                observations++ < 32;
              if (observe)
                trace({
                  phase: "enter",
                  uri: document.uri.toString(),
                  version: document.version,
                  language: document.languageId,
                  range: { start: range.start, end: range.end },
                  trigger: context.triggerKind,
                  cancelled: token.isCancellationRequested,
                });
              try {
                const actions = editor.actions(document, range);
                if (observe)
                  trace({
                    phase: "return",
                    uri: document.uri.toString(),
                    range: { start: range.start, end: range.end },
                    cancelled: token.isCancellationRequested,
                    actions: actions.map((action) => ({
                      title: action.title,
                      command: action.command?.command,
                    })),
                  });
                return actions;
              } catch (error) {
                if (observe)
                  trace({
                    phase: "throw",
                    uri: document.uri.toString(),
                    error: String(error),
                  });
                throw error;
              }
            },
          },
          {
            providedCodeActionKinds: [
              vscode.CodeActionKind.QuickFix,
              ...(writable
                ? [vscode.CodeActionKind.SourceFixAll.append("saltboxLint")]
                : []),
            ],
          },
        ),
      );
      own(
        vscode.languages.registerDefinitionProvider(selector, {
          provideDefinition: (document, position, token) =>
            editor.navigation.definition(document, position, token),
        }),
      );
      own(
        vscode.languages.registerHoverProvider(selector, {
          provideHover: (document, position, token) =>
            editor.navigation.hover(document, position, token),
        }),
      );
      own(
        vscode.languages.registerReferenceProvider(selector, {
          provideReferences: (document, position, context, token) =>
            editor.navigation.references(document, position, context, token),
        }),
      );
      if (writable) {
        own(
          vscode.languages.registerCompletionItemProvider(selector, {
            provideCompletionItems: (document, position, token) =>
              editor.navigation.completion(document, position, token),
          }),
        );
        own(
          (
            adapters.registerDocumentFormattingEditProvider ??
            vscode.languages.registerDocumentFormattingEditProvider
          ).call(vscode.languages, selector, {
            provideDocumentFormattingEdits: (document, _options, token) =>
              editor.format(document, "canonical", token),
          }),
        );
      }
      providers.set(key, {
        language: document.languageId,
        writable,
        disposable: combineDisposables(acquired),
      });
    } catch (error) {
      rollbackResources(error, acquired);
    }
  }
}
