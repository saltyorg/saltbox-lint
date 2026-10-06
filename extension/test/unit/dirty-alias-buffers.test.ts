import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { synchronizeDirtyAliases } from "../host/dirty-alias-buffers.ts";

const baseline = Buffer.from("saved\r\n😀é");
const overlay = baseline.toString() + "\r\n{# dirty #}";
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-dirty-alias-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "templates"));
  const owner = join(root, "owner.yml");
  const aliasPath = join(root, "reverse-alias.j2");
  const primaryPath = join(root, "templates/reverse.yaml");
  await writeFile(owner, baseline);
  await symlink(owner, aliasPath, "file");
  await symlink(owner, primaryPath, "file");
  function document(filename: string, text: string, dirty: boolean) {
    return {
      uri: {
        scheme: "file",
        fsPath: filename,
        toString: () => pathToFileURL(filename).toString(),
      },
      text,
      version: 7,
      eol: 2,
      isDirty: dirty,
      isClosed: false,
      getText() {
        return this.text;
      },
    };
  }
  const primary = document(primaryPath, overlay, true);
  const alias = document(aliasPath, baseline.toString(), false);
  const unrelated = document(join(root, "unrelated.j2"), overlay, true);
  await writeFile(unrelated.uri.fsPath, baseline);
  const closed = document(aliasPath, "closed conflict", false);
  closed.uri = {
    ...closed.uri,
    toString: () => "file:///unadmitted/closed.j2",
  };
  closed.isClosed = true;
  const documents = [primary, alias, unrelated, closed];
  type Document = typeof primary;
  const edits: string[] = [];
  const cleanups: string[] = [];
  const options = {
    root,
    owner,
    primary,
    baseline,
    knownURIs: [primary.uri.toString(), alias.uri.toString()],
    documents: () => documents,
    replace: async (doc: Document, text: string) => {
      edits.push(doc.uri.toString());
      doc.text = text;
      doc.version++;
      doc.isDirty = true;
    },
    restoreClean: async (doc: Document) => {
      cleanups.push(doc.uri.toString());
      doc.text = (await readFile(doc.uri.fsPath)).toString();
      doc.version++;
      doc.isDirty = false;
    },
  };
  return {
    root,
    owner,
    primary,
    alias,
    unrelated,
    closed,
    documents,
    edits,
    cleanups,
    options,
  };
}

test("dirty fixture edits only the exact known same-owner public alias and restores saved data", async (t) => {
  const f = await fixture(t);
  const before = {
    text: f.primary.text,
    version: f.primary.version,
    eol: f.primary.eol,
  };
  const buffers = await synchronizeDirtyAliases(f.options);
  buffers.assertCurrent();
  assert.equal(f.alias.text, overlay);
  assert.deepEqual(f.edits, [f.alias.uri.toString()]);
  assert.deepEqual(
    { text: f.primary.text, version: f.primary.version, eol: f.primary.eol },
    before,
  );
  assert.equal(f.unrelated.version, 7);
  assert.equal(f.closed.text, "closed conflict");
  assert.deepEqual(await readFile(f.owner), baseline);
  await buffers.restore();
  assert.equal(f.alias.text, baseline.toString());
  assert.equal(f.alias.eol, 2);
  assert.equal(f.alias.isDirty, false);
  assert.ok(f.alias.version > 7, "public cleanup never decrements versions");
  assert.deepEqual(f.cleanups, [f.alias.uri.toString()]);
  assert.deepEqual(await readFile(f.owner), baseline);
});

for (const kind of [
  "matching",
  "closed",
  "different owner",
  "unadmitted URI",
] as const) {
  test(`dirty fixture preserves ${kind} alias bytes without edits`, async (t) => {
    const f = await fixture(t);
    if (kind === "matching") f.alias.text = overlay;
    if (kind === "closed") f.alias.isClosed = true;
    if (kind === "different owner") {
      await rm(f.alias.uri.fsPath);
      await writeFile(f.alias.uri.fsPath, baseline);
    }
    if (kind === "unadmitted URI") f.options.knownURIs.pop();
    const before = { ...f.alias };
    const buffers = await synchronizeDirtyAliases(f.options);
    buffers.assertCurrent();
    await buffers.restore();
    assert.deepEqual(f.alias, before);
    assert.deepEqual(f.edits, []);
    assert.deepEqual(f.cleanups, []);
  });
}

for (const kind of [
  "alias bytes",
  "alias version",
  "alias EOL",
  "alias closed",
  "alias model",
  "duplicate URI",
  "disk bytes",
  "owner retarget",
] as const) {
  test(`dirty fixture detects ${kind} changes after setup`, async (t) => {
    const f = await fixture(t);
    const buffers = await synchronizeDirtyAliases(f.options);
    if (kind === "alias bytes") f.alias.text = "conflict";
    if (kind === "alias version") f.alias.version++;
    if (kind === "alias EOL") f.alias.eol = 1;
    if (kind === "alias closed") f.alias.isClosed = true;
    if (kind === "alias model") f.documents[1] = { ...f.alias };
    if (kind === "duplicate URI") f.documents.push({ ...f.alias });
    if (kind === "disk bytes") await writeFile(f.owner, "changed disk");
    if (kind === "owner retarget") {
      await rm(f.alias.uri.fsPath);
      await symlink(f.unrelated.uri.fsPath, f.alias.uri.fsPath, "file");
    }
    assert.throws(buffers.assertCurrent);
  });
}

test("dirty fixture refuses changed disk, an escaped owner and duplicate public models before edits", async (t) => {
  const f = await fixture(t);
  await writeFile(f.owner, "changed disk");
  await assert.rejects(synchronizeDirtyAliases(f.options));
  assert.deepEqual(f.edits, []);
  await writeFile(f.owner, baseline);
  await assert.rejects(
    synchronizeDirtyAliases({ ...f.options, root: join(f.root, "templates") }),
  );
  assert.deepEqual(f.edits, []);
  f.documents.push({ ...f.alias });
  await assert.rejects(synchronizeDirtyAliases(f.options));
  assert.deepEqual(f.edits, []);
});

test("dirty fixture restores a partial failed public edit without masking its original error", async (t) => {
  const f = await fixture(t);
  const failure = new Error("public edit rejected after partial replacement");
  let calls = 0;
  const replace = f.options.replace;
  await assert.rejects(
    synchronizeDirtyAliases({
      ...f.options,
      replace: async (doc, text) => {
        await replace(doc, text);
        if (++calls === 1) throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(f.alias.text, baseline.toString());
  assert.equal(f.alias.isDirty, false);
  assert.deepEqual(await readFile(f.owner), baseline);
  assert.equal(f.primary.version, 7);
});

test("dirty fixture reports cleanup failure while still restoring the remaining alias", async (t) => {
  const f = await fixture(t);
  const secondPath = join(f.root, "second.j2");
  await symlink(f.owner, secondPath, "file");
  const second = {
    ...f.alias,
    uri: {
      ...f.alias.uri,
      fsPath: secondPath,
      toString: () => pathToFileURL(secondPath).toString(),
    },
  };
  f.documents.push(second);
  f.options.knownURIs.push(second.uri.toString());
  const replace = f.options.replace;
  let cleanup = false;
  const buffers = await synchronizeDirtyAliases({
    ...f.options,
    replace: async (doc, text) => {
      if (cleanup && doc === second) throw new Error("second cleanup rejected");
      await replace(doc, text);
    },
  });
  cleanup = true;
  await assert.rejects(buffers.restore(), AggregateError);
  assert.equal(f.alias.text, baseline.toString());
  assert.equal(f.alias.isDirty, false);
  assert.deepEqual(await readFile(f.owner), baseline);
});
