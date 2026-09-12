import { createHash } from "node:crypto";

export interface Position {
  line: number;
  character: number;
}
interface Point {
  line: number;
  column: number;
}
export interface SourceRange {
  start: Point;
  end: Point;
}
interface Span {
  start: number;
  end: number;
}
export interface SourceEdit {
  range: SourceRange;
  span: Span;
  text: string;
}
export interface EditorEdit {
  start: Position;
  end: Position;
  text: string;
}
export interface Location {
  path: string;
  range: SourceRange;
  span: Span;
}
export interface Finding extends Location {
  rule_id: string;
  severity: "error" | "warning" | "info";
  message: string;
  expected?: string;
  related?: (Location & { message: string })[];
  fix_id?: string;
}
export interface SharedFix {
  id: string;
  path: string;
  message: string;
  edits: SourceEdit[];
}
export interface CheckReport {
  diagnostics: Finding[];
  fixes: Map<string, SharedFix>;
}
export function hash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
function valid(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid Saltbox Lint response");
}
function object(value: unknown): asserts value is Record<string, unknown> {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
}
function integer(value: unknown, min = 0): asserts value is number {
  valid(Number.isSafeInteger(value) && (value as number) >= min);
}
function string(value: unknown, nonempty = true): asserts value is string {
  valid(typeof value === "string" && (!nonempty || value.length > 0));
}
export function sourcePath(value: unknown): asserts value is string {
  string(value);
  valid(
    !value.includes("\\") &&
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value),
  );
  valid(
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."),
  );
}
function point(value: unknown): asserts value is Point {
  object(value);
  integer(value.line, 1);
  integer(value.column, 1);
}
function location(value: unknown, withPath = true): asserts value is Location {
  object(value);
  if (withPath) sourcePath(value.path);
  object(value.range);
  point(value.range.start);
  point(value.range.end);
  const { start, end } = value.range;
  valid(
    end.line > start.line ||
      (end.line === start.line && end.column >= start.column),
  );
  object(value.span);
  integer(value.span.start);
  integer(value.span.end);
  valid(value.span.end >= value.span.start);
}
function edits(value: unknown): asserts value is SourceEdit[] {
  valid(Array.isArray(value));
  let end = -1;
  let start = -1;
  for (const item of value) {
    location(item, false);
    object(item);
    string(item.text, false);
    valid(item.text.isWellFormed());
    valid(item.span.start >= end && item.span.start !== start);
    start = item.span.start;
    end = item.span.end;
  }
}

/** One pass builds byte/code-point/UTF16 boundaries for all consumers of a snapshot. */
export class SnapshotIndex {
  private readonly lines: { byte: number; character: number }[][] = [[]];
  readonly byteLength: number;
  constructor(source: string) {
    valid(source.isWellFormed());
    let byte = 0;
    let character = 0;
    let line = this.lines[0];
    line.push({ byte, character });
    for (let offset = 0; offset < source.length;) {
      const rune = String.fromCodePoint(source.codePointAt(offset)!);
      byte += Buffer.byteLength(rune);
      offset += rune.length;
      if (rune === "\n") {
        character = 0;
        line = [];
        this.lines.push(line);
      } else if (!(rune === "\r" && source[offset] === "\n"))
        character += rune.length;
      line.push({ byte, character });
    }
    this.byteLength = byte;
  }
  private boundary(position: Point) {
    point(position);
    const found = this.lines[position.line - 1]?.[position.column - 1];
    valid(found);
    return found;
  }
  position(position: Point): Position {
    return {
      line: position.line - 1,
      character: this.boundary(position).character,
    };
  }
  range(range: SourceRange, span?: Span): { start: Position; end: Position } {
    const start = this.boundary(range.start);
    const end = this.boundary(range.end);
    valid(start.byte <= end.byte);
    if (span) valid(span.start === start.byte && span.end === end.byte);
    return { start: this.position(range.start), end: this.position(range.end) };
  }
  edits(editsToMap: SourceEdit[]): EditorEdit[] {
    edits(editsToMap);
    return editsToMap.map((edit) => ({
      ...this.range(edit.range, edit.span),
      text: edit.text,
    }));
  }
}
export function parseFormat(
  wire: string,
  path: string,
  source: string,
): {
  status: "ready" | "unchanged" | "skipped";
  edits: EditorEdit[];
  reason?: string;
} {
  const value: unknown = JSON.parse(wire);
  object(value);
  valid(value.schema_version === 1);
  sourcePath(value.path);
  valid(value.path === path);
  valid(value.source_sha256 === hash(source));
  edits(value.edits);
  valid(
    value.status === "ready" ||
      value.status === "unchanged" ||
      value.status === "skipped",
  );
  if (value.status === "ready") valid(value.edits.length > 0);
  else valid(value.edits.length === 0);
  if (value.status === "skipped") string(value.reason);
  else valid(value.reason === undefined);
  const result = {
    status: value.status as "ready" | "unchanged" | "skipped",
    edits: new SnapshotIndex(source).edits(value.edits),
  };
  return value.status === "skipped"
    ? { ...result, reason: value.reason as string }
    : result;
}
export function parseCheck(wire: string): CheckReport {
  const value: unknown = JSON.parse(wire);
  object(value);
  valid(value.schema_version === 2);
  valid(Array.isArray(value.diagnostics) && Array.isArray(value.fixes));
  const fixes = new Map<string, SharedFix>();
  for (const fix of value.fixes) {
    object(fix);
    string(fix.id);
    sourcePath(fix.path);
    string(fix.message);
    edits(fix.edits);
    valid(fix.edits.length > 0 && !fixes.has(fix.id));
    fixes.set(fix.id, fix as unknown as SharedFix);
  }
  for (const finding of value.diagnostics) {
    location(finding);
    object(finding);
    string(finding.rule_id);
    string(finding.message);
    valid(["error", "warning", "info"].includes(finding.severity as string));
    if (finding.expected !== undefined) string(finding.expected);
    if (finding.related !== undefined) {
      valid(Array.isArray(finding.related));
      for (const related of finding.related) {
        location(related);
        object(related);
        string(related.message);
      }
    }
    if (finding.fix_id !== undefined) {
      string(finding.fix_id);
      valid(fixes.get(finding.fix_id)?.path === finding.path);
    }
  }
  return { diagnostics: value.diagnostics as Finding[], fixes };
}
