import * as vscode from "vscode";
import * as path from "node:path";
import type { EditorIntegration } from "./editor.ts";
import { combineDisposables, rollbackResources } from "./disposables.ts";

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
    const acquired: vscode.Disposable[] = [];
    const own = (registration: vscode.Disposable) =>
      acquired.push(registration);
    try {
      own(
        vscode.languages.registerCodeActionsProvider(
          selector,
          {
            provideCodeActions: (document, range) =>
              editor.actions(document, range),
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
