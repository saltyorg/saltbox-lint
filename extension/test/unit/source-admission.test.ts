import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { TextDocument } from "vscode";
import type { EditorIntegration } from "../../src/editor.ts";
import type { Identity } from "../../src/identity.ts";
import { Results } from "../../src/results.ts";
import { Scheduler } from "../../src/scheduler.ts";

const bundled = await build({
  entryPoints: ["src/editor.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "source-admission-api",
      setup(builder) {
        builder.onResolve(
          { filter: /^vscode$|^\.\/process\.ts$/ },
          ({ path }) => ({ path, namespace: "source-admission-api" }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "source-admission-api" },
          ({ path }) => ({
            contents:
              path === "vscode"
                ? "module.exports = globalThis.api"
                : "exports.runProcess = globalThis.api.runProcess",
            loader: "js",
          }),
        );
      },
    },
  ],
});

function uri(filename: string) {
  return {
    scheme: "file",
    path: filename.replaceAll("\\", "/"),
    fsPath: filename,
    toString: () => `file://${filename}`,
  };
}
function document(
  filename: string,
  languageId = "yaml",
  isDirty = false,
): TextDocument {
  return {
    uri: uri(filename),
    languageId,
    isClosed: false,
    isDirty,
    version: 1,
    getText: () => "value: 1\n",
  } as unknown as TextDocument;
}

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "saltbox-source-admission-")),
  );
  const folder = { uri: uri(root) };
  const documents: TextDocument[] = [];
  const workspace = {
    isTrusted: true,
    textDocuments: documents,
    getWorkspaceFolder: () => folder,
  };
  const notices: { error: unknown; manual: boolean }[] = [];
  const checked: TextDocument[] = [];
  const canceled: string[] = [];
  const removed: string[] = [];
  const deletedDiagnostics: string[] = [];
  let processRequests = 0;
  let processFailure: string | undefined;
  let fault: { filename: string; code: string } | undefined;
  let beforeRealpath: ((filename: string) => Promise<void>) | undefined;
  let activeRoot: string | undefined = root;
  const require = createRequire(import.meta.url);
  const module = {
    exports: {} as { EditorIntegration: typeof EditorIntegration },
  };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) =>
      name === "node:fs/promises"
        ? {
            ...fs,
            realpath: async (filename: string) => {
              await beforeRealpath?.(filename);
              if (fault?.filename === filename)
                throw Object.assign(
                  new Error("controlled filesystem failure"),
                  { code: fault.code },
                );
              return fs.realpath(filename);
            },
          }
        : require(name),
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    api: {
      workspace,
      Uri: {
        file: uri,
        parse: (value: string) => uri(value.slice("file://".length)),
      },
      runProcess: async () => {
        processRequests++;
        throw Object.assign(new Error("controlled process boundary"), {
          code: processFailure,
        });
      },
    },
  });
  const sourceOwners = new Map<string, Identity>();
  const results = new Results<{ diagnostics: [] }>();
  const lint = new Scheduler("retain");
  const cancel = lint.cancel.bind(lint);
  lint.cancel = (key: string) => {
    canceled.push(key);
    cancel(key);
  };
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as Pick<
      EditorIntegration,
      "check" | "format" | "providerDocuments" | "status" | "writable"
    > & {
      snapshot(doc: TextDocument): Promise<unknown>;
      admit(doc: TextDocument): Promise<boolean>;
      synchronizeSources(): Promise<void>;
      query(
        doc: TextDocument,
        position: { line: number; character: number },
        operation: "definition",
        token?: undefined,
        manual?: boolean,
      ): Promise<unknown>;
    },
    {
      disposed: false,
      executable: "controlled-CLI",
      closedTabs: new Set(),
      sourceOwners,
      canonicalRoots: new Map(),
      documentFolders: new Map(),
      checking: new Map(),
      rootRevisions: new Map(),
      documentRevisions: new WeakMap(),
      nextRevision: 0,
      queryRevision: 0,
      relatedRevision: 0,
      failures: new Map(),
      pendingFiles: new Map(),
      fileFingerprints: new Map(),
      pendingDiskReload: new Set(),
      missingFiles: new Map(),
      scanRevisions: new Map(),
      roots: {
        ready: async () => {},
        refresh: async () => {},
        get: () => activeRoot,
        folder: () => folder,
        watchSource() {},
        forgetSource(key: string) {
          removed.push(key);
        },
      },
      dependencies: {
        begin: () => 0,
        revision: () => 0,
        admissionRevision: () => 0,
        remove(_folder: string, path: string) {
          removed.push(path);
        },
      },
      eligibilityChanged: { fire() {} },
      results,
      collection: {
        delete(value: { toString(): string }) {
          deletedDiagnostics.push(value.toString());
        },
      },
      publish() {},
      updateStatus() {},
      output: { appendLine() {} },
      error(error: unknown, manual: boolean) {
        notices.push({ error, manual });
      },
      lint,
      formatting: new Scheduler(),
      queryLanes: new Map([["definition", new Scheduler()]]),
      checkSnapshot: async (doc: TextDocument) => {
        checked.push(doc);
      },
    },
  );
  const own = async (doc: TextDocument) => {
    documents.push(doc);
    await editor.check(doc, true);
    assert.equal(sourceOwners.has(doc.uri.toString()), true);
    results.storeDocument(doc.uri.toString(), { diagnostics: [] });
  };
  return {
    root,
    documents,
    editor,
    sourceOwners,
    results,
    checked,
    notices,
    removed,
    canceled,
    deletedDiagnostics,
    own,
    workspace,
    requests: () => processRequests,
    fault(value: typeof fault) {
      fault = value;
    },
    beforeResolve(callback: typeof beforeRealpath) {
      beforeRealpath = callback;
    },
    processError(code: string) {
      processFailure = code;
    },
    actualCheck() {
      Reflect.deleteProperty(editor, "checkSnapshot");
    },
    rootValue(value: string | undefined) {
      activeRoot = value;
    },
    async dispose() {
      lint.dispose();
      (Reflect.get(editor, "formatting") as Scheduler).dispose();
      for (const lane of (
        Reflect.get(editor, "queryLanes") as Map<string, Scheduler>
      ).values())
        lane.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("deleted alias parents quietly decline checks, queries and formatting and do not reject unrelated startup checks", async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, "roles/one/tasks");
    const alias = join(f.root, "navalias");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, "main.yml"), "value: 1\n");
    await fs.symlink(join(f.root, "roles/one"), alias, "junction");
    const stale = document(join(alias, "tasks/main.yml"));
    const valid = document(join(directory, "main.yml"));
    await f.own(stale);
    f.documents.push(valid);
    await fs.rm(alias, { recursive: true });
    f.checked.length = 0;
    await assert.doesNotReject(
      Promise.all([f.editor.check(stale), f.editor.check(valid)]),
    );
    assert.deepEqual(
      f.checked,
      [valid],
      "one unavailable open document cannot reject unrelated startup checks",
    );
    for (const manual of [false, true]) await f.editor.check(stale, manual);
    assert.equal(
      await f.editor.query(
        stale,
        { line: 0, character: 0 },
        "definition",
        undefined,
        true,
      ),
      undefined,
    );
    for (const mode of ["canonical", "lint-fixes"] as const)
      assert.equal((await f.editor.format(stale, mode)).length, 0);
    assert.equal(f.requests(), 0);
    assert.equal(f.notices.length, 0);
    assert.equal(f.sourceOwners.has(stale.uri.toString()), false);
    assert.equal(f.editor.providerDocuments().includes(stale), false);
    assert.equal(f.results.document(stale.uri.toString()), undefined);
    assert.ok(f.deletedDiagnostics.includes(stale.uri.toString()));
    assert.ok(f.canceled.includes(stale.uri.toString()));
    assert.ok(
      f.removed.includes(stale.uri.toString()),
      "retired source watcher is released",
    );
    await fs.symlink(join(f.root, "roles/one"), alias, "junction");
    await f.editor.check(stale, true);
    assert.equal(
      f.sourceOwners.get(stale.uri.toString())?.filename,
      valid.uri.fsPath,
    );
    assert.equal(f.editor.providerDocuments().includes(stale), true);
  } finally {
    await f.dispose();
  }
});

test("known removed YAML and dirty template owners lose diagnostics before watcher delivery; fresh missing YAML leaves keep their identity", async () => {
  const f = await fixture();
  try {
    for (const [relative, language] of [
      ["roles/demo/tasks/main.yml", "yaml"],
      ["roles/demo/templates/config", "plaintext"],
      ["output.j2", "jinja"],
    ]) {
      const filename = join(f.root, relative);
      await fs.mkdir(join(filename, ".."), { recursive: true });
      await fs.writeFile(filename, "value: 1\n");
      const doc = document(filename, language, true);
      await f.own(doc);
      await fs.rm(filename);
      await f.editor.check(doc, true);
      assert.equal(f.sourceOwners.has(doc.uri.toString()), false, relative);
      assert.equal(f.results.document(doc.uri.toString()), undefined, relative);
      assert.equal(f.editor.providerDocuments().includes(doc), false, relative);
      assert.ok(f.deletedDiagnostics.includes(doc.uri.toString()), relative);
    }
    const missing = document(join(f.root, "roles/demo/tasks/new.yml"));
    await f.editor.check(missing, true);
    await f.editor.check(missing, true);
    assert.ok(await f.editor.snapshot(missing));
    await f.editor.check(missing, true);
    assert.equal(
      f.sourceOwners.has(missing.uri.toString()),
      true,
      "a missing ordinary YAML leaf with an existing parent retains the established unsaved-source identity",
    );
    const missingTemplate = document(
      join(f.root, "roles/demo/templates/new.conf"),
      "plaintext",
      true,
    );
    await f.editor.check(missingTemplate, true);
    assert.equal(f.sourceOwners.has(missingTemplate.uri.toString()), false);
    assert.equal(f.notices.length, 0);
  } finally {
    await f.dispose();
  }
});

test("admission of a retargeted escaping source declines and revokes its previous owner; canonical buffer ownership remains separate", async () => {
  const f = await fixture();
  const external = f.root + "-outside.yml";
  try {
    const canonical = join(f.root, "source.yml");
    const alias = join(f.root, "source-alias.yml");
    await fs.writeFile(canonical, "value: 1\n");
    await fs.writeFile(external, "value: 1\n");
    await fs.symlink(canonical, alias, "file");
    const stale = document(alias);
    const valid = document(canonical);
    await f.own(stale);
    await f.own(valid);
    await fs.rm(alias);
    await fs.symlink(external, alias, "file");
    await assert.doesNotReject(f.editor.check(stale, true));
    assert.equal(f.sourceOwners.has(stale.uri.toString()), false);
    assert.equal(f.results.document(stale.uri.toString()), undefined);
    assert.equal(f.sourceOwners.has(valid.uri.toString()), true);
    assert.ok(
      f.results.document(valid.uri.toString()),
      "withdrawing an alias preserves another live canonical buffer result",
    );
    assert.equal(f.notices.length, 0);
    await fs.rm(alias);
    await fs.symlink(canonical, alias, "file");
    await f.editor.check(stale, true);
    assert.equal(f.sourceOwners.get(stale.uri.toString())?.filename, canonical);
  } finally {
    await f.dispose();
    await fs.rm(external, { force: true });
  }
});

test("unexpected admission filesystem failures remain failed check status and manual notices; ordinary plaintext is quiet", async () => {
  const f = await fixture();
  try {
    const doc = document(join(f.root, "source.yml"));
    await fs.writeFile(doc.uri.fsPath, "value: 1\n");
    f.documents.push(doc);
    for (const code of ["EACCES", "EIO"]) {
      f.fault({ filename: doc.uri.fsPath, code });
      await assert.doesNotReject(f.editor.check(doc, true));
      assert.equal(f.editor.status(doc).state, "failed");
      assert.equal(f.notices.at(-1)?.manual, true);
      assert.equal(
        (f.notices.at(-1)?.error as NodeJS.ErrnoException).code,
        code,
      );
    }
    f.fault({ filename: doc.uri.fsPath, code: "EIO" });
    await f.editor.check(doc, false);
    assert.equal(f.notices.at(-1)?.manual, false);
    const count = f.notices.length;
    const plain = document(join(f.root, "notes"), "plaintext");
    f.fault({ filename: plain.uri.fsPath, code: "EIO" });
    await f.editor.check(plain, true);
    assert.equal(f.notices.length, count);
    assert.equal(f.sourceOwners.has(plain.uri.toString()), false);
  } finally {
    await f.dispose();
  }
});

test("source removal between admission and snapshot retires the owner without a child or manual failure", async () => {
  const f = await fixture();
  try {
    const parent = join(f.root, "roles/demo/templates");
    const doc = document(join(parent, "config"), "plaintext", true);
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(doc.uri.fsPath, "value: 1\n");
    await f.own(doc);
    let resolutions = 0;
    f.beforeResolve(async (filename) => {
      if (filename === doc.uri.fsPath && ++resolutions === 2)
        await fs.rm(parent, { recursive: true });
    });
    assert.equal(await f.editor.snapshot(doc), undefined);
    assert.equal(resolutions, 2);
    assert.equal(f.sourceOwners.has(doc.uri.toString()), false);
    assert.equal(f.results.document(doc.uri.toString()), undefined);
    assert.equal(f.notices.length, 0);
    assert.equal(f.requests(), 0);
  } finally {
    await f.dispose();
  }
});

test("a provider or formatter is sufficient to withdraw a removed source before any check or watcher event", async () => {
  for (const operation of [
    "definition",
    "canonical",
    "lint-fixes",
    "template definition",
  ] as const) {
    const f = await fixture();
    try {
      const template = operation === "template definition";
      const parent = join(
        f.root,
        template ? "roles/demo/templates" : "roles/demo/tasks",
      );
      const doc = document(
        join(parent, template ? "config" : "main.yml"),
        template ? "plaintext" : "yaml",
        true,
      );
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(doc.uri.fsPath, "value: 1\n");
      await f.own(doc);
      await fs.rm(parent, { recursive: true });
      // ENOTDIR is also an identity refusal, rather than an editor failure.
      await fs.writeFile(parent, "replaced directory");
      if (operation === "definition" || operation === "template definition")
        assert.equal(
          await f.editor.query(
            doc,
            { line: 0, character: 0 },
            "definition",
            undefined,
            true,
          ),
          undefined,
        );
      else assert.equal((await f.editor.format(doc, operation)).length, 0);
      assert.equal(f.sourceOwners.has(doc.uri.toString()), false, operation);
      assert.equal(
        f.results.document(doc.uri.toString()),
        undefined,
        operation,
      );
      assert.equal(
        f.editor.providerDocuments().includes(doc),
        false,
        operation,
      );
      assert.equal(f.notices.length, 0, operation);
      assert.equal(f.requests(), 0, operation);
    } finally {
      await f.dispose();
    }
  }
});

test("a stale unavailable admission cannot withdraw a newer document revision's owner", async () => {
  const f = await fixture();
  try {
    const doc = document(join(f.root, "source.yml"));
    await fs.writeFile(doc.uri.fsPath, "value: 1\n");
    await f.own(doc);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.beforeResolve(async (filename) => {
      if (filename !== doc.uri.fsPath) return;
      entered();
      await held;
      throw Object.assign(new Error("controlled absent old identity"), {
        code: "ENOENT",
      });
    });
    const pending = f.editor.admit(doc);
    await reached;
    Reflect.set(doc, "version", 2);
    release();
    assert.equal(await pending, false);
    assert.equal(f.sourceOwners.has(doc.uri.toString()), true);
    assert.ok(f.results.document(doc.uri.toString()));
    assert.equal(f.canceled.length, 0);
    assert.equal(f.notices.length, 0);
  } finally {
    await f.dispose();
  }
});

test("missing CLI errors after submission retain manual reporting for queries, formatting and checks", async () => {
  const f = await fixture();
  try {
    const doc = document(join(f.root, "source.yml"));
    await fs.writeFile(doc.uri.fsPath, "value: 1\n");
    f.documents.push(doc);
    f.processError("ENOENT");
    await f.editor.query(
      doc,
      { line: 0, character: 0 },
      "definition",
      undefined,
      true,
    );
    assert.equal(f.requests(), 1);
    assert.equal(f.notices.length, 1);
    assert.match(
      String(f.notices[0].error),
      /Static role lookup impact failed/,
    );
    for (const mode of ["canonical", "lint-fixes"] as const)
      assert.equal((await f.editor.format(doc, mode)).length, 0);
    assert.equal(f.requests(), 3);
    assert.equal(f.notices.length, 3);
    f.actualCheck();
    await f.editor.check(doc, true);
    assert.equal(f.requests(), 4);
    assert.equal(f.notices.length, 4);
    assert.equal(f.editor.status(doc).state, "failed");
    assert.equal(
      f.notices.every((notice) => notice.manual),
      true,
    );
    assert.equal(f.sourceOwners.has(doc.uri.toString()), true);
  } finally {
    await f.dispose();
  }
});
