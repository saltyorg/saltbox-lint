import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { TextDocument } from "vscode";
import { hash } from "../../src/protocol.ts";

export type AliasDocument = Pick<
  TextDocument,
  "getText" | "version" | "eol" | "isDirty" | "isClosed"
> & { readonly uri: { readonly fsPath: string; toString(): string } };

function capture(document: AliasDocument) {
  const text = document.getText();
  return {
    document,
    uri: document.uri.toString(),
    text,
    digest: hash(text),
    version: document.version,
    eol: document.eol,
    dirty: document.isDirty,
    closed: document.isClosed,
  };
}

// Test setup owns these edits. Navigation must preserve every captured buffer
// and saved byte. Only the exact public fixture spellings may be synchronized.
export async function synchronizeDirtyAliases<
  T extends AliasDocument,
>(options: {
  root: string;
  owner: string;
  primary: T;
  baseline: Buffer;
  knownURIs: readonly string[];
  documents: () => readonly T[];
  replace: (document: T, text: string) => Promise<void>;
  restoreClean?: (document: T) => Promise<void>;
}) {
  const root = realpathSync.native(options.root);
  const owner = realpathSync.native(options.owner);
  const ownerPath = relative(root, owner);
  assert.ok(
    ownerPath &&
      ownerPath !== ".." &&
      !ownerPath.startsWith(".." + sep) &&
      !isAbsolute(ownerPath),
    "fixture owner stays within its independently resolved root",
  );
  const known = new Set(options.knownURIs);
  assert.equal(known.size, options.knownURIs.length);
  const primary = capture(options.primary);
  assert.ok(known.has(primary.uri));
  assert.equal(primary.closed, false);
  assert.equal(primary.dirty, true);
  const candidates = () => {
    const documents = options
      .documents()
      .filter((doc) => known.has(doc.uri.toString()));
    assert.equal(
      new Set(documents.map((doc) => doc.uri.toString())).size,
      documents.length,
    );
    return documents.filter(
      (doc) => !doc.isClosed && realpathSync.native(doc.uri.fsPath) === owner,
    );
  };
  const originals = candidates().map((document) => ({
    ...capture(document),
    document,
  }));
  assert.ok(originals.some((item) => item.document === options.primary));
  const edited: typeof originals = [];
  const assertDisk = () => {
    assert.equal(realpathSync.native(options.root), root);
    assert.equal(realpathSync.native(options.owner), owner);
    assert.deepEqual(readFileSync(owner), options.baseline);
    for (const item of originals) {
      assert.equal(realpathSync.native(item.document.uri.fsPath), owner);
      assert.deepEqual(
        readFileSync(item.document.uri.fsPath),
        options.baseline,
      );
    }
  };
  const assertPrimary = () =>
    assert.deepEqual(capture(options.primary), primary);
  const restore = async () => {
    const failures: unknown[] = [];
    for (const item of [...edited].reverse()) {
      try {
        assertDisk();
        assert.equal(item.document.uri.toString(), item.uri);
        assert.equal(item.document.isClosed, false);
        if (item.document.getText() !== item.text)
          await options.replace(item.document, item.text);
        // Public edits do not restore historical versions or necessarily the
        // saved state. The host can use its established public revert cleanup.
        if (!item.dirty && item.document.isDirty && options.restoreClean)
          await options.restoreClean(item.document);
        assert.equal(item.document.getText(), item.text);
        assert.equal(item.document.eol, item.eol);
        assert.equal(item.document.uri.toString(), item.uri);
        assert.ok(item.document.version >= item.version);
        assertDisk();
      } catch (error) {
        failures.push(error);
      }
    }
    assertPrimary();
    if (failures.length)
      throw new AggregateError(failures, "fixture alias cleanup failed");
  };
  try {
    assertDisk();
    for (const item of originals) {
      assert.equal(
        item.eol,
        primary.eol,
        "fixture aliases share the primary EOL",
      );
      if (item.document === options.primary || item.text === primary.text)
        continue;
      edited.push(item);
      await options.replace(item.document, primary.text);
      assertPrimary();
      assert.equal(item.document.getText(), primary.text);
      assert.equal(item.document.eol, item.eol);
    }
    assertDisk();
    assertPrimary();
    const synchronized = originals.map((item) => capture(item.document));
    const assertCurrent = () => {
      assertPrimary();
      const current = candidates();
      assert.equal(current.length, originals.length);
      for (const [index, item] of originals.entries())
        assert.equal(
          current[index],
          item.document,
          "the exact public fixture model remains present",
        );
      assertDisk();
      for (const item of synchronized) {
        assert.deepEqual(capture(item.document), item);
        assert.equal(item.text, primary.text);
        assert.equal(item.digest, primary.digest);
      }
    };
    assertCurrent();
    return { assertCurrent, restore };
  } catch (error) {
    try {
      await restore();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}
