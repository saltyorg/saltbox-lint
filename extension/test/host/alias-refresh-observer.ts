import * as vscode from "vscode";
import { relative, sep } from "node:path";
import { MarkedRoots } from "../../src/roots.ts";
import type { EditorIntegration } from "../../src/editor.ts";
import { diagnosticCode } from "./diagnostic-code.ts";

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Reflect.get(value, key);
}
function mapValue(value: unknown, key: unknown): unknown {
  if (value instanceof Map) return value.get(key);
  if (value instanceof WeakMap && key && typeof key === "object")
    return value.get(key);
  throw new Error("Expected an existing observation map and compatible key");
}
function string(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 4096) : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}
function templateDependencies(value: unknown, path: string | null) {
  if (!Array.isArray(value)) return { state: "unavailable" };
  const selected = value.filter(
    (item: unknown) => field(item, "path") === path,
  );
  return {
    state: "observed",
    count: selected.length,
    truncated: selected.length > 4,
    items: selected.slice(0, 4).map((item: unknown) => ({
      path: string(field(item, "path")),
      state: string(field(item, "state")),
      sha256: string(field(item, "sha256")),
    })),
  };
}
function diagnosticFacts(uri: vscode.Uri) {
  const diagnostics = vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.source === "saltbox-lint");
  return {
    count: diagnostics.length,
    truncated: diagnostics.length > 16,
    codes: diagnostics.slice(0, 16).map((item) => diagnosticCode(item)),
  };
}

// Observe the existing component seam. No subscription, generation, queue or
// result is changed; check wrappers return the original operation promise.
export function observeAliasRefresh(
  editor: EditorIntegration,
  document: vscode.TextDocument,
  template: vscode.Uri,
) {
  const registeredAt = new Date().toISOString();
  const alias = document.uri.toString();
  const folder = vscode.workspace
    .getWorkspaceFolder(document.uri)!
    .uri.toString();
  const roots: unknown = Reflect.get(editor, "roots");
  if (!(roots instanceof MarkedRoots))
    throw new Error("Actual component root event source is unavailable");
  const events: unknown[] = [];
  let count = 0;
  let disposed = false;
  let pending = 0;
  const facts = () => {
    const owner = mapValue(Reflect.get(editor, "sourceOwners"), alias);
    const root = string(field(owner, "root"));
    const source = string(field(owner, "path"));
    const templatePath = root
      ? relative(root, template.fsPath).split(sep).join("/")
      : null;
    const state = mapValue(
      field(Reflect.get(editor, "dependencies"), "states"),
      folder,
    );
    const entry = source
      ? mapValue(field(state, "sources"), source)
      : undefined;
    const dependencyRecord = field(entry, "record");
    const result = mapValue(
      field(Reflect.get(editor, "results"), "documents"),
      alias,
    );
    const snapshot = field(result, "snapshot");
    const analysis = field(field(result, "report"), "analysis");
    const sources = field(analysis, "sources");
    const selected = Array.isArray(sources)
      ? sources.find((item: unknown) => field(item, "path") === source)
      : undefined;
    const documentRevision = number(
      mapValue(Reflect.get(editor, "documentRevisions"), document),
    );
    const rootRevision = number(
      mapValue(Reflect.get(editor, "rootRevisions"), folder),
    );
    const admissionRevision = number(field(state, "admission"));
    const pendingKey = `${alias}:${document.version}:${documentRevision}:${rootRevision}:${admissionRevision}`;
    const admitted = mapValue(Reflect.get(editor, "checking"), pendingKey);
    const queued = mapValue(Reflect.get(editor, "pendingFiles"), alias);
    return {
      state: "observed",
      document: {
        uri: alias,
        version: document.version,
        isClosed: document.isClosed,
        isDirty: document.isDirty,
      },
      owner: { root, path: source },
      revisions: {
        document: documentRevision,
        root: rootRevision,
        admission: admissionRevision,
        dependency: number(field(entry, "revision")),
      },
      dependency: {
        sourceHash: string(field(dependencyRecord, "source_sha256")),
        files: templateDependencies(
          field(dependencyRecord, "files"),
          templatePath,
        ),
        discovery: templateDependencies(
          field(dependencyRecord, "discovery"),
          templatePath,
        ),
      },
      acceptedResult: {
        present: result !== undefined,
        sourceHash: string(field(snapshot, "hash")),
        dependencyRevision: number(field(snapshot, "dependencyRevision")),
        analysisRoot: string(field(analysis, "root")),
        sourceHashInAnalysis: string(field(selected, "source_sha256")),
        files: templateDependencies(field(selected, "files"), templatePath),
        discovery: templateDependencies(
          field(selected, "discovery"),
          templatePath,
        ),
      },
      request: {
        queued: queued !== undefined,
        forced: field(queued, "force") === true,
        queuedVersion: number(field(queued, "version")),
        admitted: admitted !== undefined,
        admittedSource: string(field(admitted, "source")),
        admittedDependencyRevision: number(
          field(admitted, "dependencyRevision"),
        ),
      },
      status: editor.status(document).state,
      diagnostics: diagnosticFacts(document.uri),
    };
  };
  const capture = (
    phase: string,
    operation?: {
      manual: boolean;
      expectedVersion: number | null;
      outcome?: string;
      errorName?: string;
    },
  ) => {
    if (disposed) return;
    let observation: unknown;
    try {
      observation = facts();
    } catch (error) {
      observation = {
        state: "unavailable",
        errorName: error instanceof Error ? error.name : "unknown error",
      };
    }
    count++;
    events.push({
      capturedAt: new Date().toISOString(),
      phase,
      operation,
      facts: observation,
    });
    if (events.length > 32) events.shift();
  };
  const subscription = roots.onDidChangeFile((uri) => {
    if (uri.toString() === template.toString())
      capture("actual root template event after product listener");
  });
  const previous = Object.getOwnPropertyDescriptor(editor, "check");
  const original = editor.check;
  const wrapped: EditorIntegration["check"] = function (
    this: EditorIntegration,
    target,
    manual = false,
    expectedVersion,
  ) {
    const relevant = target.uri.toString() === alias;
    const operation = { manual, expectedVersion: expectedVersion ?? null };
    if (relevant) capture("alias check start", operation);
    let result: Promise<void>;
    try {
      result = Reflect.apply(original, this, [target, manual, expectedVersion]);
    } catch (error) {
      if (relevant)
        capture("alias check threw", {
          ...operation,
          outcome: "threw",
          errorName: error instanceof Error ? error.name : "unknown error",
        });
      throw error;
    }
    if (relevant) {
      pending++;
      result
        .then(
          () => {
            pending--;
            capture("alias check settled", {
              ...operation,
              outcome: "resolved",
            });
          },
          (error: unknown) => {
            pending--;
            capture("alias check rejected", {
              ...operation,
              outcome: "rejected",
              errorName: error instanceof Error ? error.name : "unknown error",
            });
          },
        )
        .catch((error: unknown) => {
          capture("observation continuation rejected", {
            ...operation,
            errorName: error instanceof Error ? error.name : "unknown error",
          });
        });
    }
    return result;
  };
  Object.defineProperty(editor, "check", {
    configurable: true,
    writable: true,
    value: wrapped,
  });
  capture("initial admitted alias before template mutation");
  return {
    snapshot: () => {
      capture("snapshot at collection");
      return {
        schemaVersion: 1,
        registeredAt,
        capturedAt: new Date().toISOString(),
        alias,
        template: template.toString(),
        count,
        truncated: count > events.length,
        pendingObservers: pending,
        events: events.map((event) => event),
      };
    },
    dispose: () => {
      if (disposed) return;
      if (editor.check !== wrapped)
        capture("check wrapper ownership changed before disposal");
      else if (previous) Object.defineProperty(editor, "check", previous);
      else Reflect.deleteProperty(editor, "check");
      subscription.dispose();
      disposed = true;
    },
  };
}
