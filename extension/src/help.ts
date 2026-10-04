import * as vscode from "vscode";
import { runProcess } from "./process.ts";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { parseRegistry } from "./protocol.ts";
import type { RuleMetadata } from "./protocol.ts";
// Public anchors use registry IDs; unknown diagnostics such as yaml-parse have
// no generated page and therefore retain a plain code.
export function ruleURL(id: string): vscode.Uri {
  return vscode.Uri.parse(
    `https://github.com/saltyorg/saltbox-lint/blob/main/docs/rules.md#${id}`,
  );
}
function fence(example: string): string {
  let delimiter = "```";
  while (example.includes(delimiter)) delimiter += "`";
  return `${delimiter}yaml\n${example}\n${delimiter}\n`;
}
export function ruleMarkdown(rule: RuleMetadata): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = { enabledCommands: [] };
  markdown.supportHtml = false;
  markdown.appendMarkdown(`# ${rule.id}\n\n`);
  markdown.appendText(rule.summary);
  markdown.appendMarkdown("\n\n");
  markdown.appendText(rule.explanation);
  markdown.appendMarkdown("\n\n");
  markdown.appendText(
    `Source kinds: ${rule.source_kinds.join(", ")}. Scope: ${rule.scope}. Automatic fix: ${rule.fixable}.`,
  );
  markdown.appendMarkdown(
    `\n\nExpected example:\n\n${fence(rule.good_example)}\nViolation example:\n\n${fence(rule.bad_example)}`,
  );
  return markdown;
}

// One bundled executable owns policy. Cache keys include its reported version;
// failures are not cached, and all processes share the bounded process adapter.
export class RuleHelp implements vscode.Disposable {
  private readonly scheme = `saltbox-lint-help-${randomUUID()}`;
  private readonly abort = new AbortController();
  private readonly cache = new Map<string, Promise<RuleMetadata[]>>();
  private version?: Promise<string>;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly documents = new Map<string, vscode.MarkdownString>();
  private readonly registration: vscode.Disposable;
  constructor(private readonly executable: string) {
    this.registration = vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(this.scheme, {
        onDidChange: this.changed.event,
        provideTextDocumentContent: (uri) =>
          this.documents.get(uri.toString())?.value ?? "",
      }),
      vscode.languages.registerHoverProvider(
        { scheme: this.scheme },
        {
          provideHover: (document) => {
            const markdown = this.documents.get(document.uri.toString());
            return markdown && new vscode.Hover(markdown);
          },
        },
      ),
    );
  }
  async registry(refreshVersion = false): Promise<RuleMetadata[]> {
    if (refreshVersion) this.version = undefined;
    this.version ??= runProcess(
      {
        executable: this.executable,
        cwd: path.dirname(this.executable),
        args: ["--version"],
      },
      this.abort.signal,
    ).catch((error) => {
      this.version = undefined;
      throw error;
    });
    const version = await this.version;
    const key = `${this.executable}\0${version}`;
    let work = this.cache.get(key);
    if (!work) {
      work = runProcess(
        {
          executable: this.executable,
          cwd: path.dirname(this.executable),
          args: ["rules", "--format", "json"],
        },
        this.abort.signal,
      )
        .then(parseRegistry)
        .catch((error) => {
          this.cache.delete(key);
          throw error;
        });
      this.cache.set(key, work);
    }
    return work;
  }
  async show(markdown: vscode.MarkdownString, name: string): Promise<void> {
    const uri = vscode.Uri.from({
      scheme: this.scheme,
      path: `/${name}`,
    });
    this.documents.set(uri.toString(), markdown);
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
    });
    await vscode.commands.executeCommand("editor.action.showHover");
  }
  async explain(id?: string): Promise<vscode.MarkdownString | undefined> {
    const rules = await this.registry(true);
    if (!id)
      id = (
        await vscode.window.showQuickPick(
          rules.map((rule) => ({ label: rule.id, description: rule.summary })),
          { title: "Explain this rule" },
        )
      )?.label;
    if (!id) return;
    const rule = rules.find((rule) => rule.id === id);
    if (!rule) throw new Error(`Unknown rule ${id}`);
    const markdown = ruleMarkdown(rule);
    await this.show(markdown, id);
    return markdown;
  }
  dispose(): void {
    this.abort.abort();
    this.registration.dispose();
    this.changed.dispose();
    this.documents.clear();
    this.cache.clear();
  }
}
