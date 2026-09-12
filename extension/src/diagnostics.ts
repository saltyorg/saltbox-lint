import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { identify, resolveSource } from "./identity.ts";
import { SnapshotIndex } from "./protocol.ts";
import type { Finding } from "./protocol.ts";

export function range(value: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): vscode.Range {
  return new vscode.Range(
    value.start.line,
    value.start.character,
    value.end.line,
    value.end.character,
  );
}

export async function renderDiagnostics(
  findings: Finding[],
  index: SnapshotIndex,
  root: string,
): Promise<vscode.Diagnostic[]> {
  const relatedIndexes = new Map<
    string,
    Promise<{ uri: vscode.Uri; index: SnapshotIndex } | undefined>
  >();
  const loadRelated = (relative: string) => {
    let work = relatedIndexes.get(relative);
    if (!work) {
      work = (async () => {
        const filename = await resolveSource(root, relative);
        for (const doc of vscode.workspace.textDocuments) {
          if (!doc.isDirty || doc.uri.scheme !== "file") continue;
          try {
            if ((await identify(root, doc.uri.fsPath)).filename === filename)
              return;
          } catch {
            /* A buffer outside this root cannot own this location. */
          }
        }
        return {
          uri: vscode.Uri.file(filename),
          index: new SnapshotIndex(await readFile(filename, "utf8")),
        };
      })().catch(() => undefined);
      relatedIndexes.set(relative, work);
    }
    return work;
  };
  const result: vscode.Diagnostic[] = [];
  for (const finding of findings) {
    const diagnostic = new vscode.Diagnostic(
      range(index.range(finding.range, finding.span)),
      finding.message +
        (finding.expected ? `\nExpected: ${finding.expected}` : ""),
      {
        error: vscode.DiagnosticSeverity.Error,
        warning: vscode.DiagnosticSeverity.Warning,
        info: vscode.DiagnosticSeverity.Information,
      }[finding.severity],
    );
    diagnostic.source = "saltbox-lint";
    diagnostic.code = finding.rule_id;
    const related: vscode.DiagnosticRelatedInformation[] = [];
    for (const location of finding.related ?? []) {
      const source = await loadRelated(location.path);
      if (!source) continue;
      try {
        related.push(
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(
              source.uri,
              range(source.index.range(location.range, location.span)),
            ),
            location.message,
          ),
        );
      } catch {
        /* Saved related source no longer matches report coordinates. */
      }
    }
    if (related.length) diagnostic.relatedInformation = related;
    result.push(diagnostic);
  }
  return result;
}
