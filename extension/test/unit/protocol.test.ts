import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SnapshotIndex, parseFormat, parseCheck } from "../../src/protocol.ts";

const source = "a: 😀é\r\nx:  1\r\n";
const edit = {
  range: { start: { line: 2, column: 4 }, end: { line: 2, column: 5 } },
  span: { start: 14, end: 15 },
  text: "",
};
function format(overrides = {}) {
  return JSON.stringify({
    schema_version: 1,
    path: "roles/a/defaults/main.yml",
    source_sha256: createHash("sha256").update(source).digest("hex"),
    status: "ready",
    edits: [edit],
    ...overrides,
  });
}

test("code-point coordinates become UTF16 positions including CRLF and EOF", () => {
  const index = new SnapshotIndex(source);
  assert.deepEqual(index.position({ line: 1, column: 5 }), {
    line: 0,
    character: 5,
  });
  assert.deepEqual(index.position({ line: 3, column: 1 }), {
    line: 2,
    character: 0,
  });
});
test("verified format plans retain small edits at exact UTF8 boundaries", () => {
  assert.deepEqual(parseFormat(format(), "roles/a/defaults/main.yml", source), {
    status: "ready",
    edits: [
      {
        start: { line: 1, character: 3 },
        end: { line: 1, character: 4 },
        text: "",
      },
    ],
  });
});
test("format rejects stale hash, wrong identity, malformed state and conflicts", () => {
  for (const overrides of [
    { source_sha256: "0".repeat(64) },
    { path: "../main.yml" },
    { status: "skipped" },
    { status: "unchanged" },
    { edits: [edit, edit] },
    { edits: [{ ...edit, span: { start: 5, end: 6 } }] },
    {
      edits: [
        {
          ...edit,
          range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        },
      ],
    },
  ]) {
    assert.throws(() =>
      parseFormat(format(overrides), "roles/a/defaults/main.yml", source),
    );
  }
});
test("shared fix references cannot be dangling or target a different file", () => {
  const diagnostic = {
    path: "a.yml",
    rule_id: "spacing",
    message: "spacing",
    severity: "error",
    range: edit.range,
    span: edit.span,
    fix_id: "fix-1",
  };
  for (const fixes of [
    [],
    [{ id: "fix-1", path: "b.yml", message: "fix", edits: [edit] }],
    [
      { id: "fix-1", path: "a.yml", message: "fix", edits: [edit] },
      { id: "fix-1", path: "a.yml", message: "fix", edits: [edit] },
    ],
  ]) {
    assert.throws(() =>
      parseCheck(
        JSON.stringify({ schema_version: 2, diagnostics: [diagnostic], fixes }),
      ),
    );
  }
});
test("thousands of small edits map independently without losing astral offsets", () => {
  const source = "😀:  1\r\n".repeat(3000);
  const wireEdits = [];
  for (let i = 0; i < 3000; i++)
    wireEdits.push({
      range: {
        start: { line: i + 1, column: 4 },
        end: { line: i + 1, column: 5 },
      },
      span: { start: i * 10 + 6, end: i * 10 + 7 },
      text: "",
    });
  const result = new SnapshotIndex(source).edits(wireEdits);
  assert.equal(result.length, 3000);
  assert.deepEqual(result[2999], {
    start: { line: 2999, character: 4 },
    end: { line: 2999, character: 5 },
    text: "",
  });
});
test("invalid JSON, surrogate source and duplicate insertion points are rejected", () => {
  assert.throws(() => parseCheck("{bad"));
  assert.throws(() => new SnapshotIndex("\ud800"));
  assert.throws(() =>
    new SnapshotIndex("a").edits([
      {
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
        span: { start: 0, end: 0 },
        text: "x",
      },
      {
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        span: { start: 0, end: 1 },
        text: "y",
      },
    ]),
  );
});
test("replacement strings reject unpaired surrogates from malformed wire", () => {
  assert.throws(() =>
    parseFormat(
      format({ edits: [{ ...edit, text: "\ud800" }] }),
      "roles/a/defaults/main.yml",
      source,
    ),
  );
});
