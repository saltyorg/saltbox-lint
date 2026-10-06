import * as vscode from "vscode";
import { runProcess } from "./process.ts";
import { Scheduler } from "./scheduler.ts";
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
// failures are not cached. Its scheduler joins one child before admitting another.
export class RuleHelp implements vscode.Disposable {
  private readonly scheme = `saltbox-lint-help-${randomUUID()}`;
  private readonly processes = new Scheduler();
  private readonly cache = new Map<string, Promise<RuleMetadata[]>>();
  private version?: { work: Promise<string>; pending: boolean };
  private disposed = false;
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
  private async process(key: string, args: string[]): Promise<string> {
    const output = await this.processes.submit(key, 1, (signal) =>
      runProcess(
        {
          executable: this.executable,
          cwd: path.dirname(this.executable),
          args,
        },
        signal,
      ),
    );
    if (output === undefined) throw new Error("Canceled");
    return output;
  }
  async registry(refreshVersion = false): Promise<RuleMetadata[]> {
    if (this.disposed) throw new Error("Canceled");
    if (refreshVersion && !this.version?.pending) this.version = undefined;
    if (!this.version) {
      const observation = {
        work: this.process("version", ["--version"]),
        pending: true,
      };
      this.version = observation;
      observation.work = observation.work.then(
        (version) => {
          observation.pending = false;
          return version;
        },
        (error) => {
          if (this.version === observation) this.version = undefined;
          throw error;
        },
      );
    }
    const version = await this.version.work;
    if (this.disposed) throw new Error("Canceled");
    const key = `${this.executable}\0${version}`;
    let work = this.cache.get(key);
    if (!work) {
      work = this.process(key, ["rules", "--format", "json"])
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
    if (this.disposed) throw new Error("Canceled");
    const uri = vscode.Uri.from({
      scheme: this.scheme,
      path: `/${name}`,
    });
    this.documents.set(uri.toString(), markdown);
    this.changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    if (this.disposed) throw new Error("Canceled");
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
    });
    if (!this.disposed)
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
    this.disposed = true;
    this.processes.dispose();
    this.registration.dispose();
    this.changed.dispose();
    this.documents.clear();
    this.cache.clear();
  }
  async join(): Promise<void> {
    await this.processes.join();
  }
}
