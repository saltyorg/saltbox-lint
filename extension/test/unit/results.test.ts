import assert from "node:assert/strict";
import { test } from "node:test";
import { Results } from "../../src/results.ts";

interface Diagnostic {
  message: string;
  relatedInformation?: string[];
}
interface Document {
  id: string;
  diagnostics: Diagnostic[];
}
function diagnostic(message: string): Diagnostic[] {
  return [{ message, relatedInformation: ["saved location"] }];
}

test("partial scans merge clean results without claiming full coverage", () => {
  const results = new Results<Document>();
  results.storeScan("root", new Map([["a", diagnostic("a")]]), true);
  assert.equal(results.hasCompleteScan("root"), false);
  results.storeScan("root", new Map([["b", diagnostic("b")]]), false);
  assert.equal(results.saved("root", "a"), undefined);
  assert.equal(results.hasCompleteScan("root"), true);
  assert.deepEqual(
    results.storeScan(
      "root",
      new Map([
        ["b", []],
        ["c", diagnostic("c")],
      ]),
      true,
    ),
    new Set(["b", "c"]),
  );
  assert.deepEqual(results.saved("root", "b"), []);
  assert.equal(results.hasCompleteScan("root"), true);
  assert.deepEqual(
    results.storeScan("root", new Map([["d", diagnostic("d")]]), false),
    new Set(["b", "c", "d"]),
  );
  assert.deepEqual(results.uris(), new Set(["d"]));
});

test("closing an alias suppresses saved diagnostics but retains a live canonical result", () => {
  const results = new Results<Document>();
  const canonical = { id: "canonical", diagnostics: diagnostic("live") };
  results.storeDocument("alias", { id: "alias", diagnostics: [] });
  results.storeDocument("canonical", canonical);
  for (const root of ["root", "other"])
    results.storeScan(
      root,
      new Map([
        ["alias", diagnostic("alias")],
        ["canonical", diagnostic("saved")],
        ["unrelated", diagnostic("other")],
      ]),
      false,
    );
  results.close("alias", "canonical");
  assert.equal(results.document("alias"), undefined);
  assert.equal(results.document("canonical"), canonical);
  for (const root of ["root", "other"]) {
    assert.equal(results.saved(root, "alias"), undefined);
    assert.equal(results.saved(root, "canonical"), undefined);
    assert.ok(results.saved(root, "unrelated"));
  }
  results.forget(["alias", "canonical"]);
  assert.equal(results.document("canonical"), undefined);
  assert.deepEqual(results.uris(), new Set(["unrelated"]));
});

test("folder refresh drops its coverage and owned documents while preserving other folders", () => {
  const results = new Results<Document>();
  for (const root of ["one", "two"]) {
    results.storeDocument(root, { id: root, diagnostics: diagnostic(root) });
    results.storeScan(
      root,
      new Map([[root + "/saved", diagnostic(root)]]),
      false,
    );
  }
  assert.deepEqual(results.refresh("one", ["one"]), new Set(["one/saved"]));
  assert.equal(results.document("one"), undefined);
  assert.equal(results.hasCompleteScan("one"), false);
  assert.equal(results.hasCompleteScan("two"), true);
  assert.deepEqual(results.uris(), new Set(["two", "two/saved"]));
  results.clear();
  assert.deepEqual(results.uris(), new Set());
  assert.equal(results.hasCompleteScan("two"), false);
});

test("related invalidation retains primary diagnostics and report identity", () => {
  const results = new Results<Document>();
  const document = { id: "fix-report", diagnostics: diagnostic("buffer") };
  const saved = diagnostic("disk");
  results.storeDocument("open", document);
  results.storeScan(
    "root",
    new Map([
      ["closed", saved],
      ["clean", []],
    ]),
    false,
  );
  assert.deepEqual(results.invalidateRelated(), new Set(["open", "closed"]));
  assert.equal(results.document("open"), document);
  assert.equal(document.diagnostics[0].message, "buffer");
  assert.equal(document.diagnostics[0].relatedInformation, undefined);
  assert.equal(saved[0].relatedInformation, undefined);
  assert.deepEqual(results.invalidateRelated(), new Set());
});

test("membership reconciliation retains findings while revoking complete coverage", () => {
  const results = new Results<{
    diagnostics: { relatedInformation?: unknown[] }[];
  }>();
  results.storeScan("one", new Map([["file", []]]), false);
  results.storeScan("two", new Map([["other", []]]), false);
  results.invalidateCoverage("one");
  assert.equal(results.hasCompleteScan("one"), false);
  assert.deepEqual(results.saved("one", "file"), []);
  assert.equal(results.hasCompleteScan("two"), true);
});
