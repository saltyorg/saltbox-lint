import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  realpath,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { TextDocument } from "vscode";
import type { Identity } from "../../src/identity.ts";
import type { EditorIntegration } from "../../src/editor.ts";

const bundled = await build({
  entryPoints: ["src/editor.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "admission-api",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "admission-api",
        }));
        builder.onLoad({ filter: /.*/, namespace: "admission-api" }, () => ({
          contents: "module.exports = globalThis.api",
          loader: "js",
        }));
      },
    },
  ],
});

test("first plaintext alias admission resolves canonical templates and retains origin without granting writes", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-template-admission-")),
  );
  const external = root + "-external";
  const directory = join(root, "roles/demo/templates");
  const alias = join(root, "readonly-alias");
  const uri = (filename: string) => ({
    scheme: "file",
    path: filename.replaceAll("\\", "/"),
    fsPath: filename,
    toString: () => `file://${filename}`,
  });
  const folder = { uri: uri(root) };
  const documents: TextDocument[] = [];
  const workspace = {
    isTrusted: true,
    getWorkspaceFolder: () => folder,
    textDocuments: documents,
  };
  const module = {
    exports: {} as { EditorIntegration: typeof EditorIntegration },
  };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    api: { workspace, Uri: { file: uri } },
  });
  const watched: { origin: string; identity: Identity }[] = [];
  const checked: TextDocument[] = [];
  const sourceOwners = new Map<string, Identity>();
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as Pick<
      EditorIntegration,
      "check" | "providerDocuments" | "writable" | "format" | "fixAll"
    > & {
      synchronizeSources(): Promise<void>;
      admit(document: TextDocument): Promise<boolean>;
    },
    {
      disposed: false,
      closedTabs: new Set(),
      sourceOwners,
      canonicalRoots: new Map(),
      documentFolders: new Map(),
      rootRevisions: new Map(),
      documentRevisions: new WeakMap(),
      checking: new Map(),
      nextRevision: 0,
      roots: {
        ready: async () => {},
        refresh: async () => {},
        get: () => root,
        watchSource(origin: { toString(): string }, identity: Identity) {
          watched.push({ origin: origin.toString(), identity });
        },
        forgetSource() {},
      },
      dependencies: { revision: () => 0, admissionRevision: () => 0 },
      eligibilityChanged: { fire() {} },
      publish() {},
      updateStatus() {},
      checkSnapshot: async (document: TextDocument) => {
        checked.push(document);
      },
    },
  );
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "config"),
      "{{ lookup('role_var', '_port') }}",
    );
    await symlink(directory, alias, "junction");
    const document = {
      uri: uri(join(alias, "config")),
      languageId: "plaintext",
      isClosed: false,
      version: 1,
      getText: () => "{{ lookup('role_var', '_port') }}",
    } as unknown as TextDocument;
    documents.push(document);
    await editor.check(document, true);
    assert.deepEqual(
      checked,
      [document],
      "direct check admits the first alias request",
    );
    assert.equal(
      sourceOwners.get(document.uri.toString())?.filename,
      join(directory, "config"),
    );
    assert.equal(watched[0].origin, document.uri.toString());
    assert.equal(editor.providerDocuments().includes(document), true);
    assert.equal(editor.writable(document), false);
    for (const mode of ["canonical", "lint-fixes"] as const)
      assert.equal((await editor.format(document, mode)).length, 0);
    await editor.fixAll(document.uri);
    sourceOwners.clear();
    await editor.synchronizeSources();
    assert.equal(
      editor.providerDocuments().includes(document),
      true,
      "saved scan synchronization also establishes canonical identity",
    );
    const ordinary = {
      ...document,
      uri: uri(join(root, "notes")),
    } as TextDocument;
    await writeFile(ordinary.uri.fsPath, "ordinary plaintext");
    documents.push(ordinary);
    await editor.check(ordinary, true);
    assert.deepEqual(checked, [document]);
    assert.equal(editor.providerDocuments().includes(ordinary), false);
    assert.equal(editor.writable(ordinary), false);
    assert.equal(
      (Reflect.get(editor, "documentFolders") as Map<string, string>).has(
        ordinary.uri.toString(),
      ),
      false,
      "ordinary plaintext remains outside change invalidation ownership",
    );
    await writeFile(external, "outside root");
    const escaping = {
      ...document,
      uri: uri(join(root, "escaping-alias")),
    } as TextDocument;
    await symlink(external, escaping.uri.fsPath, "file");
    documents.push(escaping);
    await editor.check(escaping, true);
    assert.deepEqual(checked, [document]);
    assert.equal(
      sourceOwners.has(escaping.uri.toString()),
      false,
      "escaping aliases never receive checking ownership",
    );
    const mutable = document as unknown as {
      version: number;
      isClosed: boolean;
    };
    for (const scenario of [
      "changed version",
      "changed root",
      "closed",
      "untrusted",
    ] as const) {
      sourceOwners.clear();
      let release!: (value: string) => void;
      const held = new Promise<string>((resolve) => {
        release = resolve;
      });
      const pendingEditor = Object.assign(editor, { root: () => held });
      const pending = pendingEditor.admit(document);
      if (scenario === "changed version") mutable.version++;
      if (scenario === "changed root") {
        const revisions = Reflect.get(editor, "rootRevisions") as Map<
          string,
          number
        >;
        revisions.set(
          folder.uri.toString(),
          (revisions.get(folder.uri.toString()) ?? 0) + 1,
        );
      }
      if (scenario === "closed") mutable.isClosed = true;
      if (scenario === "untrusted") workspace.isTrusted = false;
      release(root);
      assert.equal(await pending, false, scenario);
      assert.equal(
        sourceOwners.size,
        0,
        "stale admission never establishes a source owner",
      );
      mutable.isClosed = false;
      workspace.isTrusted = true;
    }
    workspace.isTrusted = false;
    sourceOwners.clear();
    assert.equal(await editor.admit(document), false);
    assert.equal(sourceOwners.size, 0);
  } finally {
    await rm(external, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
