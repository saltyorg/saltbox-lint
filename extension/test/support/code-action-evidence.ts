import { createHash } from "node:crypto";
import { disposeResources, rollbackResources } from "../../src/disposables.ts";

interface Uri {
  scheme: string;
  toString(): string;
}
interface Document {
  uri: Uri;
  version: number;
  languageId: string;
  isClosed: boolean;
  isDirty: boolean;
  lineCount: number;
  getText(): string;
}
interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
interface Diagnostic {
  source?: string;
  code?: string | number | { value: string | number };
  range: Range;
}
interface Action {
  title: string;
  kind?: { value: string };
  command?: string | { command: string };
}
interface Disposable {
  dispose(): unknown;
}
type Event<T> = (listener: (event: T) => void) => Disposable;
export type ActionEvidenceStage =
  "warm" | "after-markdown" | "after-other-yaml";
export interface ActionEvidenceDocument {
  label: string;
  document: Document;
  diagnostics(): readonly Diagnostic[];
}
export interface ActionEvidenceAdapters {
  changed: Event<{ document: Document; contentChanges: readonly unknown[] }>;
  opened: Event<Document>;
  closed: Event<Document>;
  diagnosticsChanged: Event<{ uris: readonly Uri[] }>;
  write(line: string): void;
  clock?: () => number;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const text = (value: string, limit: number) =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, limit);
const rangeFacts = (range: Range) => ({
  start: { line: range.start.line, character: range.start.character },
  end: { line: range.end.line, character: range.end.character },
});

/** Silent public observations; it neither invokes providers nor judges actions. */
export class CodeActionEvidence {
  private readonly documents = new Map<string, ActionEvidenceDocument>();
  private readonly subscriptions: Disposable[] = [];
  private readonly adapters: ActionEvidenceAdapters;
  private readonly queries = new Map<
    ActionEvidenceStage,
    Record<string, unknown>
  >();
  private readonly events: Record<string, unknown>[] = [];
  private readonly eventCounts: Record<string, number> = {};
  private readonly queryCounts: Record<ActionEvidenceStage, number> = {
    warm: 0,
    "after-markdown": 0,
    "after-other-yaml": 0,
  };
  private failures: unknown[] = [];
  private droppedEvents = 0;
  private sequence = 0;
  private disposed = false;

  constructor(
    documents: readonly ActionEvidenceDocument[],
    adapters: ActionEvidenceAdapters,
  ) {
    this.adapters = adapters;
    for (const document of documents) this.track(document);
    const own = (resource: Disposable) => this.subscriptions.push(resource);
    try {
      own(
        adapters.changed((event) =>
          this.event("change", event.document, event.contentChanges.length),
        ),
      );
      own(adapters.opened((document) => this.event("open", document)));
      own(adapters.closed((document) => this.event("close", document)));
      own(
        adapters.diagnosticsChanged((event) => {
          this.observe(() => {
            for (const uri of event.uris) {
              const tracked = [...this.documents.values()].find(
                (entry) => entry.document.uri.toString() === uri.toString(),
              );
              if (tracked) this.event("diagnostics", tracked.document);
            }
          });
        }),
      );
    } catch (error) {
      rollbackResources(error, this.subscriptions);
    }
  }

  track(document: ActionEvidenceDocument): void {
    this.documents.set(document.label, document);
  }

  private observe<T>(read: () => T): T | null {
    if (this.failures.length) return null;
    try {
      return read();
    } catch (error) {
      this.failures.push(error);
      return null;
    }
  }

  private now(): number | null {
    return this.observe(() => {
      const value = (this.adapters.clock ?? (() => performance.now()))();
      if (!Number.isFinite(value))
        throw new Error("Evidence clock is not finite");
      return value;
    });
  }

  private documentFacts(document: Document) {
    return {
      uri:
        document.uri.scheme === "file"
          ? text(document.uri.toString(), 2048)
          : null,
      uriHash: digest(document.uri.toString()),
      scheme: text(document.uri.scheme, 32),
      version: document.version,
      language: text(document.languageId, 64),
      closed: document.isClosed,
      dirty: document.isDirty,
      lineCount: document.lineCount,
      textHash: document.isClosed
        ? null
        : this.observe(() => digest(document.getText())),
    };
  }

  private snapshot() {
    return this.observe(() =>
      [...this.documents.values()].map((entry) => {
        const diagnostics = entry.diagnostics();
        return {
          label: text(entry.label, 32),
          document: this.documentFacts(entry.document),
          diagnosticCount: diagnostics.length,
          diagnostics: diagnostics.slice(0, 32).map((diagnostic) => ({
            source: diagnostic.source ? text(diagnostic.source, 64) : null,
            code:
              typeof diagnostic.code === "object"
                ? typeof diagnostic.code.value === "string"
                  ? text(diagnostic.code.value, 96)
                  : diagnostic.code.value
                : typeof diagnostic.code === "string"
                  ? text(diagnostic.code, 96)
                  : (diagnostic.code ?? null),
            range: rangeFacts(diagnostic.range),
          })),
          diagnosticsTruncated: diagnostics.length > 32,
        };
      }),
    );
  }

  private event(
    kind: string,
    document: Document,
    contentChanges?: number,
  ): void {
    if (this.disposed) return;
    const record = this.observe(() => {
      const tracked = [...this.documents.values()].find(
        (entry) => entry.document.uri.toString() === document.uri.toString(),
      );
      if (!tracked) return undefined;
      return {
        kind,
        label: tracked.label,
        sameModel: tracked.document === document,
        contentChanges: contentChanges ?? null,
        document: this.documentFacts(document),
      };
    });
    if (!record) return;
    this.eventCounts[kind] = (this.eventCounts[kind] ?? 0) + 1;
    this.events.push({ sequence: ++this.sequence, ...record });
    if (this.events.length > 32) {
      this.events.shift();
      this.droppedEvents++;
    }
  }

  begin(stage: ActionEvidenceStage, range: Range): Record<string, unknown> {
    this.queryCounts[stage]++;
    const query = {
      stage,
      sequence: ++this.sequence,
      range: this.observe(() => rangeFacts(range)),
      startedMs: this.now(),
      before: this.snapshot(),
    };
    this.queries.set(stage, query);
    return query;
  }

  returned(
    query: Record<string, unknown>,
    raw: readonly Action[],
    filtered: readonly Action[],
  ): void {
    const summarize = (actions: readonly Action[]) => ({
      count: actions.length,
      actions: actions.slice(0, 32).map((action) => ({
        title: text(action.title, 160),
        kind: action.kind ? text(action.kind.value, 96) : null,
        command:
          typeof action.command === "string"
            ? text(action.command, 96)
            : action.command
              ? text(action.command.command, 96)
              : null,
      })),
      truncated: actions.length > 32,
    });
    query.raw = this.observe(() => summarize(raw));
    query.filtered = this.observe(() => summarize(filtered));
    query.after = this.snapshot();
    query.endSequence = ++this.sequence;
    const ended = this.now();
    query.elapsedMs =
      typeof query.startedMs === "number" && ended !== null
        ? ended - query.startedMs
        : null;
  }

  /** Preserve the exact original failure; report failures are separate causes. */
  failure(stage: ActionEvidenceStage, original: unknown): never {
    try {
      this.adapters.write(
        "SALTBOX_I1_ACTION_FAILURE " +
          JSON.stringify({
            schemaVersion: 1,
            stage,
            queries: [...this.queries.values()],
            queryCounts: this.queryCounts,
            queryRetention: "Latest query for each phase",
            events: this.events,
            eventCounts: this.eventCounts,
            droppedEvents: this.droppedEvents,
            observationFailures: this.failures.length,
            unavailable: [
              "provider invocations",
              "provider registry",
              "request cancellation token",
              "extension report/root/document/dependency revisions",
            ],
          }),
      );
    } catch (error) {
      this.failures.push(error);
    }
    if (this.failures.length) {
      const failures = this.failures;
      this.failures = [];
      throw new AggregateError(
        [original, ...failures],
        "I1 action failure and evidence failed",
        { cause: original },
      );
    }
    throw original;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures = this.failures;
    this.failures = [];
    try {
      disposeResources(this.subscriptions);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "I1 evidence cleanup failed", {
        cause: failures[0],
      });
  }
}
