import * as vscode from "vscode";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { identify, resolveSource, templatePath } from "./identity.ts";
import { SnapshotIndex, hash, type Position } from "./protocol.ts";
import { range } from "./diagnostics.ts";
import type {
  QueryLocation,
  QueryOperation,
  QueryReport,
} from "./navigation-protocol.ts";

export interface NavigationAnswer {
  report: QueryReport;
  locations: Map<QueryLocation, vscode.Location>;
  sourceIndex: SnapshotIndex;
}

// Source bytes and original coordinates are checked together. Dirty dependency
// buffers cannot supply a saved declaration location; the primary overlay can.
export function queryRange(
  location: QueryLocation,
  source: string,
  index: SnapshotIndex,
): vscode.Range {
  const mapped = index.span(location.span);
  const start = index.position({
    line: location.line,
    column: location.column,
  });
  if (
    start.line !== mapped.start.line ||
    start.character !== mapped.start.character ||
    Buffer.from(source)
      .subarray(location.span.start, location.span.end)
      .toString("utf8") !== location.text
  )
    throw new Error("Query location does not match its captured source");
  return range(mapped);
}

export async function validateNavigation(
  report: QueryReport,
  text: string,
  index: SnapshotIndex,
  uri: vscode.Uri,
): Promise<NavigationAnswer | undefined> {
  const snapshots = new Map<
    string,
    { text: string; index: SnapshotIndex; uri: vscode.Uri }
  >();
  snapshots.set(report.path, { text, index, uri });
  for (const [target, digest] of Object.entries(report.target_hashes)) {
    if (target === report.path) {
      if (digest !== hash(text)) return;
      continue;
    }
    let filename: string;
    try {
      filename = await resolveSource(report.root, target);
    } catch (error) {
      // A removed or retargeted source no longer belongs to this observation.
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" ||
        code === "ENOTDIR" ||
        (error instanceof Error && error.message === "Source identity changed")
      )
        return;
      throw error;
    }
    const targetURI = vscode.Uri.file(filename);
    const buffers = vscode.workspace.textDocuments.filter(
      (doc) =>
        !doc.isClosed &&
        doc.uri.scheme === "file" &&
        (doc.uri.toString() === targetURI.toString() ||
          path.resolve(doc.uri.fsPath) === filename),
    );
    let bytes: Buffer;
    try {
      bytes = await readFile(filename);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (
      !isUtf8(bytes) ||
      hash(bytes) !== digest ||
      buffers.some((doc) => doc.isDirty || hash(doc.getText()) !== digest)
    )
      return;
    // Aliases are checked by canonical identity in addition to their lexical URI.
    for (const document of vscode.workspace.textDocuments) {
      if (
        document.isClosed ||
        document.uri.scheme !== "file" ||
        !document.isDirty
      )
        continue;
      let canonical: string;
      try {
        canonical = (await identify(report.root, document.uri.fsPath)).filename;
      } catch {
        continue;
      }
      if (canonical === filename) return;
    }
    const source = bytes.toString("utf8");
    snapshots.set(target, {
      text: source,
      index: new SnapshotIndex(source),
      uri: targetURI,
    });
  }
  const locations = new Map<QueryLocation, vscode.Location>();
  for (const location of [
    ...report.locations,
    ...report.declarations.flatMap((declaration) => [
      declaration.key,
      declaration.value,
      ...declaration.comments,
    ]),
  ]) {
    const snapshot = snapshots.get(location.path);
    if (!snapshot) throw new Error("Unobserved query target");
    locations.set(
      location,
      new vscode.Location(
        snapshot.uri,
        queryRange(location, snapshot.text, snapshot.index),
      ),
    );
  }
  if (report.origin) queryRange(report.origin, text, index);
  for (const completion of report.completions) {
    queryRange(completion.location, text, index);
    const bytes = Buffer.from(text);
    if (
      ![34, 39].includes(bytes[completion.location.span.start - 1]) ||
      bytes[completion.location.span.start - 1] !==
        bytes[completion.location.span.end] ||
      /['"\\\r\n]/.test(completion.location.text)
    )
      throw new Error("Completion span does not preserve literal quoting");
  }
  return { report, locations, sourceIndex: index };
}
export class Navigation implements vscode.Disposable {
  private readonly scheme = `saltbox-lint-impact-${randomUUID()}`;
  private readonly views = new Map<string, string>();
  private referenceStatus?: vscode.Disposable;
  private readonly registration =
    vscode.workspace.registerTextDocumentContentProvider(this.scheme, {
      provideTextDocumentContent: (uri) =>
        this.views.get(uri.toString()) ?? "Impact view expired.",
    });
  constructor(
    private readonly query: (
      document: vscode.TextDocument,
      position: Position,
      operation: QueryOperation,
      token?: vscode.CancellationToken,
      manual?: boolean,
    ) => Promise<NavigationAnswer | undefined>,
  ) {}
  async definition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    const answer = await this.query(document, position, "definition", token);
    return (
      answer?.report.locations
        .filter((location) => location.kind === "declaration")
        .map((location) => answer.locations.get(location)!) ?? []
    );
  }
  async completion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    if (templatePath(document.uri.path)) return [];
    const answer = await this.query(document, position, "completion", token);
    return (
      answer?.report.completions.map((completion) => {
        const item = new vscode.CompletionItem(
          completion.label,
          vscode.CompletionItemKind.Variable,
        );
        item.detail = completion.detail;
        item.documentation =
          "Static source declaration candidate. Ansible runtime precedence is not evaluated.";
        item.textEdit = vscode.TextEdit.replace(
          queryRange(
            completion.location,
            document.getText(),
            answer.sourceIndex,
          ),
          completion.text,
        );
        return item;
      }) ?? []
    );
  }
  async hover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const answer = await this.query(document, position, "hover", token);
    if (!answer?.report.origin) return;
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    markdown.supportHtml = false;
    markdown.appendText(
      `Source declarations (${answer.report.state}). Runtime values and precedence are not evaluated.\n\n`,
    );
    for (const declaration of answer.report.declarations) {
      markdown.appendText(
        `${declaration.name}\n${declaration.key.path}:${declaration.key.line}\n`,
      );
      for (const comment of declaration.comments)
        markdown.appendText(`${comment.text}\n`);
      markdown.appendText(
        `Literal source representation: ${declaration.value.text}\n\n`,
      );
    }
    if (!answer.report.declarations.length)
      markdown.appendText(
        `No declaration location available. ${answer.report.reasons.join(", ")}`,
      );
    return new vscode.Hover(
      markdown,
      queryRange(answer.report.origin, document.getText(), answer.sourceIndex),
    );
  }
  async references(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    const answer = await this.query(document, position, "references", token);
    if (answer) {
      this.referenceStatus?.dispose();
      this.referenceStatus = vscode.window.setStatusBarMessage(
        "Saltbox Lint: static reference search is incomplete. Show Static Role Lookup Impact for coverage reasons.",
        10000,
      );
    }
    return (
      answer?.report.locations
        .filter(
          (location) => context.includeDeclaration || location.kind === "read",
        )
        .map((location) => answer.locations.get(location)!) ?? []
    );
  }
  async impact(): Promise<QueryReport | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const answer = await this.query(
      editor.document,
      editor.selection.active,
      "references",
      undefined,
      true,
    );
    if (!answer) return;
    const content = [
      "Saltbox Lint static impact",
      "",
      `Source: ${answer.report.path}`,
      `State: ${answer.report.state}`,
      `Snapshot SHA-256: ${answer.report.source_sha256}`,
      "Read-only snapshot. Request a fresh view after changes.",
      "Coverage: incomplete",
      ...answer.report.coverage.reasons.map((reason) => `  ${reason}`),
      "",
      "Statically recognized reads and declaration candidates",
      ...answer.report.locations.map(
        (location) =>
          `${location.kind}: ${location.path}:${location.line}:${location.column}`,
      ),
    ].join("\n");
    const uri = vscode.Uri.from({
      scheme: this.scheme,
      path: `/impact-${Date.now()}.txt`,
    });
    // Views contain no declaration values. Retain a bounded read-only history.
    if (this.views.size >= 16)
      this.views.delete(this.views.keys().next().value!);
    this.views.set(uri.toString(), content);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    return answer.report;
  }
  dispose(): void {
    this.registration.dispose();
    this.referenceStatus?.dispose();
    this.views.clear();
  }
}
