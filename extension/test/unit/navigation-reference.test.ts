import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { referencePathFromRoot } from "../support/navigation-reference.ts";

function fileReferencePath(filename: string, sourceRoot: string) {
  return referencePathFromRoot(
    { scheme: "file", fsPath: filename },
    sourceRoot,
  );
}

const alias = "roles/readonly/templates/reverse.yaml";
const owner = "roles/readonly/defaults/reverse.yml";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-reference-root-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(await realpath(directory), "root");
  const rootAlias = join(directory, "linked-root");
  await mkdir(dirname(join(root, owner)), { recursive: true });
  await mkdir(dirname(join(root, alias)), { recursive: true });
  await writeFile(join(root, owner), "lookup: '{{ lookup }}'\n");
  await symlink(root, rootAlias, "junction");
  await symlink(join(root, owner), join(root, alias), "file");
  const otherAlias = "roles/readonly/templates/other.yaml";
  await symlink(join(root, owner), join(root, otherAlias), "file");
  return { root, rootAlias, otherAlias, directory };
}

test("closed alias references preserve their exact leaf with a public root symlink or canonical root", async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.rootAlias, await realpath(f.rootAlias));
  assert.notEqual(join(f.root, alias), join(f.rootAlias, alias));
  assert.equal(fileReferencePath(join(f.rootAlias, alias), f.rootAlias), alias);
  assert.equal(fileReferencePath(join(f.root, alias), f.rootAlias), alias);
  assert.equal(fileReferencePath(join(f.root, alias), f.root), alias);
});

test("the defaults owner and another alias of the identical canonical file cannot satisfy alias lookup", async (t) => {
  const f = await fixture(t);
  const canonical = await realpath(join(f.root, alias));
  assert.equal(await realpath(join(f.root, owner)), canonical);
  assert.equal(await realpath(join(f.root, f.otherAlias)), canonical);
  for (const path of [owner, f.otherAlias]) {
    for (const root of [f.root, f.rootAlias]) {
      assert.notEqual(fileReferencePath(join(root, path), f.rootAlias), alias);
      assert.equal(fileReferencePath(join(root, path), f.rootAlias), path);
    }
  }
});

test("root membership accepts both verified root spellings and rejects outside or sibling roots", async (t) => {
  const f = await fixture(t);
  assert.equal(fileReferencePath(join(f.root, owner), f.rootAlias), owner);
  assert.equal(fileReferencePath(join(f.rootAlias, owner), f.rootAlias), owner);
  assert.equal(
    fileReferencePath(join(f.directory, "outside.yml"), f.rootAlias),
    undefined,
  );
  assert.equal(
    fileReferencePath(join(f.root + "-sibling", owner), f.rootAlias),
    undefined,
  );
  assert.equal(fileReferencePath(f.root, f.rootAlias), undefined);
});

test("root verification does not grant unverified reference spellings or relative paths", async (t) => {
  const f = await fixture(t);
  const otherRootAlias = join(f.directory, "another-linked-root");
  await symlink(f.root, otherRootAlias, "junction");
  assert.equal(await realpath(otherRootAlias), f.root);
  assert.equal(
    fileReferencePath(join(otherRootAlias, alias), f.rootAlias),
    undefined,
  );
  assert.equal(fileReferencePath(alias, f.rootAlias), undefined);
  assert.equal(
    fileReferencePath(join(f.root, alias), "relative-root"),
    undefined,
  );
});

test("non-file reference URIs cannot acquire alias or root membership from an otherwise valid file path", async (t) => {
  const f = await fixture(t);
  for (const scheme of ["untitled", "git"]) {
    for (const path of [alias, owner]) {
      assert.equal(
        referencePathFromRoot(
          { scheme, fsPath: join(f.root, path) },
          f.rootAlias,
        ),
        undefined,
      );
    }
  }
});
