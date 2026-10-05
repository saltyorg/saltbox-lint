import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotIndex, hash } from "../../src/protocol.ts";
import { parseQuery } from "../../src/navigation-protocol.ts";
const source = "# 😀é\r\nvalue: x\r\n";
const digest = hash(source),
  path = "roles/a/tasks/main.yml";
const root = process.platform === "win32" ? "C:\\project" : "/project";
function response(overrides = {}) {
  return JSON.stringify({
    schema_version: 1,
    root,
    path,
    source_sha256: digest,
    operation: "definition",
    offset: 11,
    state: "none",
    reasons: [],
    coverage: { complete: false, reasons: ["static-reads-only"] },
    target_hashes: {},
    locations: [],
    declarations: [],
    completions: [],
    dependencies: {
      schema_version: 1,
      root,
      generation: digest,
      complete: true,
      sources: [
        {
          path,
          source_sha256: digest,
          files: [{ path, state: "read", sha256: digest }],
          identity: [],
          discovery: [],
          directories: [],
        },
      ],
    },
    ...overrides,
  });
}
test("navigation maps captured UTF16 positions and rejects astral and CRLF interiors", () => {
  const index = new SnapshotIndex(source);
  assert.equal(index.byteOffset({ line: 0, character: 4 }), 6);
  assert.equal(index.byteOffset({ line: 1, character: 0 }), 10);
  assert.deepEqual(index.span({ start: 2, end: 8 }), {
    start: { line: 0, character: 2 },
    end: { line: 0, character: 5 },
  });
  for (const position of [
    { line: 0, character: 3 },
    { line: -1, character: 0 },
    { line: 1, character: 99 },
  ])
    assert.throws(() => index.byteOffset(position));
  for (const span of [
    { start: 3, end: 6 },
    { start: 8, end: 9 },
    { start: 10, end: 2 },
  ])
    assert.throws(() => index.span(span));
});
test("query validates operation, offset, root, source and dependency identity", () => {
  assert.equal(
    parseQuery(response(), root, path, source, "definition", 11).state,
    "none",
  );
  for (const overrides of [
    { schema_version: 2 },
    { root: "/elsewhere" },
    { path: "../main.yml" },
    { source_sha256: "0".repeat(64) },
    { offset: 12 },
    { operation: "hover" },
    { state: "guessed" },
    {
      origin: {
        path,
        span: { start: 12, end: 15 },
        line: 2,
        column: 3,
        text: "lue",
      },
    },
    { coverage: { complete: true, reasons: [] } },
    { target_hashes: { "../outside.yml": digest } },
    { target_hashes: { "target.yml": digest } },
  ])
    assert.throws(() =>
      parseQuery(response(overrides), root, path, source, "definition", 11),
    );
});
test("query rejects unobserved locations and edits beyond active literal", () => {
  const location = {
    path,
    span: { start: 10, end: 15 },
    line: 2,
    column: 1,
    text: "value",
  };
  assert.throws(() =>
    parseQuery(
      response({ locations: [{ ...location, kind: "read" }] }),
      root,
      path,
      source,
      "definition",
      11,
    ),
  );
  assert.throws(() =>
    parseQuery(
      response({
        target_hashes: { [path]: digest },
        locations: [{ ...location, kind: "fabricated" }],
      }),
      root,
      path,
      source,
      "definition",
      11,
    ),
  );
  for (const completion of [
    {
      label: "a",
      text: "a",
      detail: "source",
      location: { ...location, span: { start: 12, end: 15 } },
    },
    { label: "evil", text: "'; run()", detail: "source", location },
  ])
    assert.throws(() =>
      parseQuery(
        response({ operation: "completion", completions: [completion] }),
        root,
        path,
        source,
        "completion",
        11,
      ),
    );
});
