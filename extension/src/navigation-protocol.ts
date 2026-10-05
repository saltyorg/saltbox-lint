import {
  analysisRecord,
  hash,
  sourcePath,
  type AnalysisRecord,
} from "./protocol.ts";

export type QueryOperation =
  "definition" | "completion" | "hover" | "references";
export interface QueryLocation {
  path: string;
  span: { start: number; end: number };
  line: number;
  column: number;
  text: string;
}
export interface QueryDeclaration {
  name: string;
  role: string;
  role_path: string;
  provenance: string;
  key: QueryLocation;
  value: QueryLocation;
  comments: QueryLocation[];
}
export interface QueryCompletion {
  label: string;
  detail: string;
  location: QueryLocation;
  text: string;
}
export interface QueryReport {
  schema_version: 1;
  root: string;
  path: string;
  source_sha256: string;
  operation: QueryOperation;
  offset: number;
  state: "none" | "resolved" | "ambiguous" | "dynamic" | "unavailable";
  reasons: string[];
  coverage: { complete: false; reasons: string[] };
  origin?: QueryLocation;
  target_hashes: Record<string, string>;
  locations: (QueryLocation & { kind: "declaration" | "read" })[];
  declarations: QueryDeclaration[];
  completions: QueryCompletion[];
  dependencies: AnalysisRecord;
}
function valid(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid Saltbox Lint query response");
}
function object(value: unknown): asserts value is Record<string, unknown> {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
}
function text(value: unknown): asserts value is string {
  valid(typeof value === "string" && value.isWellFormed());
}
function strings(value: unknown): asserts value is string[] {
  valid(Array.isArray(value) && value.length <= 100000);
  for (const item of value) text(item);
}
function location(value: unknown): asserts value is QueryLocation {
  object(value);
  sourcePath(value.path);
  object(value.span);
  valid(
    Number.isSafeInteger(value.span.start) &&
      Number.isSafeInteger(value.span.end),
  );
  valid(
    (value.span.start as number) >= 0 &&
      (value.span.end as number) >= (value.span.start as number),
  );
  valid(
    Number.isSafeInteger(value.line) &&
      (value.line as number) >= 1 &&
      Number.isSafeInteger(value.column) &&
      (value.column as number) >= 1,
  );
  text(value.text);
}
export function parseQuery(
  wire: string,
  root: string,
  path: string,
  source: string,
  operation: QueryOperation,
  offset: number,
): QueryReport {
  const value: unknown = JSON.parse(wire);
  object(value);
  valid(
    value.schema_version === 1 &&
      value.root === root &&
      value.path === path &&
      value.source_sha256 === hash(source) &&
      value.operation === operation &&
      value.offset === offset,
  );
  valid(
    ["none", "resolved", "ambiguous", "dynamic", "unavailable"].includes(
      value.state as string,
    ),
  );
  strings(value.reasons);
  object(value.coverage);
  valid(value.coverage.complete === false);
  strings(value.coverage.reasons);
  valid(value.coverage.reasons.length > 0);
  analysisRecord(value.dependencies);
  valid(
    value.dependencies.root === root &&
      value.dependencies.sources.length === 1 &&
      value.dependencies.sources[0].path === path &&
      value.dependencies.sources[0].source_sha256 === value.source_sha256,
  );
  object(value.target_hashes);
  valid(Object.keys(value.target_hashes).length <= 100000);
  const observations = new Map(
    value.dependencies.sources[0].files.map((file) => [file.path, file]),
  );
  for (const [target, digest] of Object.entries(value.target_hashes)) {
    sourcePath(target);
    valid(typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest));
    valid(
      observations.get(target)?.state === "read" &&
        observations.get(target)?.sha256 === digest,
    );
  }
  const targetLocation = (item: unknown) => {
    location(item);
    valid(Object.hasOwn(value.target_hashes as object, item.path));
  };
  if (value.origin !== undefined) {
    location(value.origin);
    valid(value.origin.path === path);
    valid(value.origin.span.start <= offset && offset < value.origin.span.end);
  }
  valid(
    Array.isArray(value.locations) &&
      Array.isArray(value.declarations) &&
      Array.isArray(value.completions),
  );
  valid(
    value.locations.length +
      value.declarations.length +
      value.completions.length <=
      100000,
  );
  for (const item of value.locations) {
    targetLocation(item);
    object(item);
    valid(item.kind === "declaration" || item.kind === "read");
  }
  for (const declaration of value.declarations) {
    object(declaration);
    for (const key of ["name", "role", "role_path", "provenance"])
      text(declaration[key]);
    targetLocation(declaration.key);
    targetLocation(declaration.value);
    valid(
      Array.isArray(declaration.comments) &&
        declaration.comments.length <= 100000,
    );
    for (const comment of declaration.comments) targetLocation(comment);
  }
  for (const completion of value.completions) {
    object(completion);
    text(completion.label);
    text(completion.detail);
    text(completion.text);
    location(completion.location);
    valid(
      operation === "completion" &&
        completion.location.path === path &&
        completion.location.span.start <= offset &&
        completion.location.span.end >= offset,
    );
    valid(
      /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(completion.text) &&
        completion.text === completion.label,
    );
  }
  if (operation !== "completion") valid(value.completions.length === 0);
  if (value.state === "none") valid(value.origin === undefined);
  if (value.state === "none" || value.state === "dynamic")
    valid(
      value.locations.length === 0 &&
        value.declarations.length === 0 &&
        value.completions.length === 0,
    );
  return value as unknown as QueryReport;
}
