import * as vscode from "vscode";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import type { EditorIntegration } from "../../src/editor.ts";
import { hash } from "../../src/protocol.ts";
import { diagnosticCode } from "./diagnostic-code.ts";

function observed<T>(read: () => T) {
  try {
    return { state: "observed", value: read() };
  } catch (error) {
    return {
      state: "unavailable",
      error: error instanceof Error ? error.name : "unknown error",
    };
  }
}

function diagnostics(uri: vscode.Uri) {
  const items = vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.source === "saltbox-lint");
  return {
    count: items.length,
    truncated: items.length > 1024,
    items: items.slice(0, 1024).map((item) => ({
      code: diagnosticCode(item),
      range: {
        start: {
          line: item.range.start.line,
          character: item.range.start.character,
        },
        end: { line: item.range.end.line, character: item.range.end.character },
      },
    })),
  };
}

export async function aliasFailureFacts(
  editor: EditorIntegration,
  document: vscode.TextDocument,
  alias: vscode.Uri,
  canonical: vscode.Uri,
  template: vscode.Uri,
  defaults: vscode.Uri,
) {
  const capturedAt = new Date().toISOString();
  const facts = {
    capturedAt,
    timing:
      "public facts after alias assertion rejection; not exact deadline state",
    alias: alias.toString(),
    canonical: canonical.toString(),
    diagnostics: {
      alias: observed(() => diagnostics(alias)),
      canonical: observed(() => diagnostics(canonical)),
    },
    document: observed(() => ({
      uri: document.uri.toString(),
      languageId: document.languageId,
      version: document.version,
      isClosed: document.isClosed,
      isDirty: document.isDirty,
      textHash: hash(document.getText()),
    })),
    activeEditor: observed(
      () => vscode.window.activeTextEditor?.document.uri.toString() ?? null,
    ),
    status: observed(() => editor.status(document)),
    providerDocuments: observed(() => {
      const documents = editor.providerDocuments();
      return {
        count: documents.length,
        documentOwned: documents.some(
          (item) => item.uri.toString() === document.uri.toString(),
        ),
        aliasOwned: documents.some(
          (item) => item.uri.toString() === alias.toString(),
        ),
        canonicalOwned: documents.some(
          (item) => item.uri.toString() === canonical.toString(),
        ),
        uris: documents.slice(0, 1024).map((item) => item.uri.toString()),
        truncated: documents.length > 1024,
      };
    }),
    roots: observed(
      () =>
        vscode.workspace.workspaceFolders?.map((folder) => ({
          uri: folder.uri.toString(),
          name: folder.name,
        })) ?? [],
    ),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const disk = await Promise.race([
      Promise.all(
        [alias, canonical, template, defaults].map(async (uri) => {
          try {
            const [bytes, identity, stat] = await Promise.all([
              readFile(uri.fsPath),
              realpath(uri.fsPath),
              lstat(uri.fsPath),
            ]);
            return {
              uri: uri.toString(),
              state: "observed",
              realpath: identity,
              symlink: stat.isSymbolicLink(),
              link: stat.isSymbolicLink() ? await readlink(uri.fsPath) : null,
              bytes: bytes.length,
              sha256: hash(bytes),
            };
          } catch (error) {
            return {
              uri: uri.toString(),
              state: "unavailable",
              error: error instanceof Error ? error.name : "unknown error",
            };
          }
        }),
      ),
      new Promise<{ state: string; error: string }>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              state: "unavailable",
              error: "disk facts exceeded one-second capture window",
            }),
          1000,
        );
      }),
    ]);
    return { ...facts, disk, completedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}
