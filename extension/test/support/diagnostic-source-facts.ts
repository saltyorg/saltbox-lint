import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import type * as vscode from "vscode";

function observed<T>(read: () => T) {
  try {
    return { state: "available", value: read() };
  } catch (error) {
    return {
      state: "unavailable",
      error:
        error instanceof Error ? error.message.slice(0, 1024) : "unknown error",
    };
  }
}

/** Read failure-time locations without changing document or source identities. */
export function diagnosticSourceFacts(
  api: Pick<typeof vscode, "workspace" | "languages">,
  roots: readonly vscode.WorkspaceFolder[],
  sources: readonly vscode.Uri[],
) {
  return {
    boundary: "public SDK diagnostic keys and current native filesystem facts",
    roots: roots.slice(0, 16).map((root) => ({
      publicURI: root.uri.toString().slice(0, 2048),
      publicPath: root.uri.fsPath.slice(0, 2048),
      nativePath: observed(() =>
        realpathSync.native(root.uri.fsPath).slice(0, 2048),
      ),
    })),
    sources: sources.slice(0, 32).map((source) => ({
      publicURI: source.toString().slice(0, 2048),
      publicPath: source.fsPath.slice(0, 2048),
      nativePath: observed(() =>
        realpathSync.native(source.fsPath).slice(0, 2048),
      ),
      sha256: observed(() =>
        createHash("sha256").update(readFileSync(source.fsPath)).digest("hex"),
      ),
    })),
    diagnostics: observed(() => {
      const entries = api.languages
        .getDiagnostics()
        .filter(([, diagnostics]) =>
          diagnostics.some(
            (diagnostic) => diagnostic.source === "saltbox-lint",
          ),
        );
      return {
        truncated: entries.length > 64,
        entries: entries.slice(0, 64).map(([uri, diagnostics]) => ({
          uri: uri.toString().slice(0, 2048),
          codes: diagnostics
            .filter((diagnostic) => diagnostic.source === "saltbox-lint")
            .slice(0, 16)
            .map((diagnostic) =>
              typeof diagnostic.code === "object"
                ? diagnostic.code.value
                : diagnostic.code,
            ),
        })),
      };
    }),
    documents: observed(() => ({
      truncated: api.workspace.textDocuments.length > 64,
      entries: api.workspace.textDocuments.slice(0, 64).map((document) => ({
        uri: document.uri.toString().slice(0, 2048),
        closed: document.isClosed,
        dirty: document.isDirty,
        version: document.version,
      })),
    })),
  };
}
