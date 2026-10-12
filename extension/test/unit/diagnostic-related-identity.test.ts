import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import type { renderDiagnostics } from "../../src/diagnostics.ts";
import { canonicalRoot } from "../../src/identity.ts";
import { SnapshotIndex, type Finding } from "../../src/protocol.ts";

const bundled = await build({
  entryPoints: ["src/diagnostics.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

const fileURI = (fsPath: string) => ({
  scheme: "file",
  fsPath,
  toString: () => pathToFileURL(fsPath).toString(),
});

function renderer() {
  const documents: { uri: ReturnType<typeof fileURI>; isDirty: boolean }[] = [];
  class Range {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };
    constructor(a: number, b: number, c: number, d: number) {
      this.start = { line: a, character: b };
      this.end = { line: c, character: d };
    }
  }
  class Location {
    readonly uri: ReturnType<typeof fileURI>;
    readonly range: Range;
    constructor(uri: ReturnType<typeof fileURI>, range: Range) {
      this.uri = uri;
      this.range = range;
    }
  }
  class Diagnostic {
    readonly range: Range;
    readonly message: string;
    readonly severity: number;
    constructor(range: Range, message: string, severity: number) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  }
  class DiagnosticRelatedInformation {
    readonly location: Location;
    readonly message: string;
    constructor(location: Location, message: string) {
      this.location = location;
      this.message = message;
    }
  }
  const adapter = {
    Range,
    Location,
    Diagnostic,
    DiagnosticRelatedInformation,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Uri: { file: fileURI },
    workspace: { textDocuments: documents },
  };
  const module: {
    exports: Partial<{ renderDiagnostics: typeof renderDiagnostics }>;
  } = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    Buffer,
    require: (name: string): unknown =>
      name === "vscode" ? adapter : require(name),
  });
  assert.ok(module.exports.renderDiagnostics);
  return { render: module.exports.renderDiagnostics, documents };
}

const finding: Finding = {
  path: "main.yml",
  range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  span: { start: 0, end: 1 },
  rule_id: "related",
  severity: "error",
  message: "related source",
  related: [
    {
      path: "related.yml",
      range: { start: { line: 1, column: 2 }, end: { line: 1, column: 3 } },
      span: { start: 4, end: 5 },
      message: "saved location",
    },
  ],
};

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "saltbox-related-root-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "source");
  const alias = join(base, "alias");
  await mkdir(root);
  await writeFile(join(root, "related.yml"), "😀x\n");
  await symlink(root, alias, "junction");
  return { base, root, alias, canonical: await canonicalRoot(alias, "") };
}

test("related renderer uses an admitted canonical root and saved UTF16 coordinates across a real root alias", async (t) => {
  const { alias, canonical } = await fixture(t);
  const { render, documents } = renderer();
  assert.notEqual(alias, canonical);
  const unadmitted = await render([finding], new SnapshotIndex("x"), alias);
  assert.equal(unadmitted[0].relatedInformation, undefined);
  const saved = await render([finding], new SnapshotIndex("x"), canonical);
  assert.equal(saved[0].relatedInformation?.length, 1);
  const location = saved[0].relatedInformation![0].location;
  assert.equal(location.uri.fsPath, join(canonical, "related.yml"));
  assert.equal(location.range.start.character, 2);
  assert.equal(location.range.end.character, 3);
  const document = { uri: fileURI(join(alias, "related.yml")), isDirty: true };
  documents.push(document);
  assert.equal(
    (await render([finding], new SnapshotIndex("x"), canonical))[0]
      .relatedInformation,
    undefined,
  );
  document.isDirty = false;
  assert.equal(
    (await render([finding], new SnapshotIndex("x"), canonical))[0]
      .relatedInformation?.[0].location.range.start.character,
    2,
  );
});

test("related renderer refuses a same-byte file outside the admitted canonical root", async (t) => {
  const { base, root, canonical } = await fixture(t);
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "related.yml"), "😀x\n");
  await symlink(outside, join(root, "external"), "junction");
  const { render } = renderer();
  const escaped: Finding = {
    ...finding,
    related: [{ ...finding.related![0], path: "external/related.yml" }],
  };
  const result = await render([escaped], new SnapshotIndex("x"), canonical);
  assert.equal(result.length, 1);
  assert.equal(result[0].message, finding.message);
  assert.equal(result[0].relatedInformation, undefined);
});
