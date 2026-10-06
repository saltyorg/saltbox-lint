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
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { TextDocument } from "vscode";
import type { Identity } from "../../src/identity.ts";
import type { EditorIntegration } from "../../src/editor.ts";
import { Dependencies } from "../../src/dependencies.ts";
import { contentFingerprint } from "../../src/observations.ts";
import { hash, parseCheck, type AnalysisRecord } from "../../src/protocol.ts";
import { lstatSync } from "node:fs";

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
        builder.onResolve({ filter: /^\.\/process\.ts$/ }, () => ({
          path: "process",
          namespace: "admission-api",
        }));
        builder.onLoad(
          { filter: /.*/, namespace: "admission-api" },
          ({ path }) => ({
            contents:
              path === "process"
                ? "exports.runProcess = globalThis.api.runProcess"
                : "module.exports = globalThis.api",
            loader: "js",
          }),
        );
      },
    },
  ],
});

test("canonical template events queue the clean alias after a newer saved report replaces its graph", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-alias-event-")),
  );
  const primary = "roles/example/tasks/main.yml";
  const template = "roles/example/templates/router.conf";
  const filename = join(root, primary);
  const templateFilename = join(root, template);
  const alias = join(root, "task-alias.yml");
  const text = "example_role_task: true\n";
  const good = "http:\n  routers:\n    example: {}\n";
  const bad = "http:\n  routers: {}\n";
  const uri = (filename: string) => ({
    scheme: "file",
    path: filename.replaceAll("\\", "/"),
    fsPath: filename,
    toString: () => `file://${filename}`,
  });
  const document = {
    uri: uri(alias),
    isClosed: false,
    isDirty: false,
    version: 1,
  };
  const folder = { uri: uri(root) };
  const module = {
    exports: {} as { EditorIntegration: typeof EditorIntegration },
  };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    Buffer,
    api: {
      workspace: { textDocuments: [document] },
      Uri: {
        file: uri,
        parse: (value: string) => uri(value.slice("file://".length)),
      },
    },
  });
  const dependencies = new Dependencies();
  const queued: { target: string; force: boolean }[] = [];
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as {
      contextEvent(uri: unknown): void;
    },
    {
      disposed: false,
      sourceOwners: new Map([
        [document.uri.toString(), { root, filename, path: primary }],
      ]),
      roots: { folder: () => folder, get: () => root },
      dependencies,
      results: { hasCompleteScan: () => true },
      lint: { cancel() {} },
      formatting: { cancel() {} },
      revokeQueries() {},
      updateStatus() {},
      queueFile(target: { toString(): string }, force = false) {
        queued.push({ target: target.toString(), force });
      },
      output: { appendLine() {} },
    },
  );
  const analysis = (bytes: string): AnalysisRecord => ({
    schema_version: 1,
    root,
    generation: hash(bytes),
    complete: true,
    sources: [
      {
        path: primary,
        source_sha256: hash(text),
        files: [
          { path: primary, state: "read", sha256: hash(text) },
          { path: template, state: "read", sha256: hash(bytes) },
        ],
        identity: [],
        discovery: [],
        directories: [],
      },
    ],
  });
  const report = (bytes: string) =>
    parseCheck(
      JSON.stringify({
        schema_version: 2,
        diagnostics: [],
        fixes: [],
        analysis: analysis(bytes),
      }),
      true,
    ).analysis!;
  const observed = (bytes: string) =>
    new Map([
      [
        template,
        contentFingerprint(
          lstatSync(templateFilename, { bigint: true }),
          Buffer.from(bytes),
        ),
      ],
    ]);
  try {
    await mkdir(join(root, "roles/example/tasks"), { recursive: true });
    await mkdir(join(root, "roles/example/templates"), { recursive: true });
    await writeFile(filename, text);
    await symlink(filename, alias, "file");
    await writeFile(templateFilename, good);
    assert.equal(
      dependencies.accept(
        folder.uri.toString(),
        report(good),
        dependencies.begin(),
        false,
        [],
        observed(good),
      ),
      true,
    );
    const aliasRevision = dependencies.revision(folder.uri.toString(), primary);
    await writeFile(templateFilename, bad);
    assert.equal(
      dependencies.accept(
        folder.uri.toString(),
        report(bad),
        dependencies.begin(),
        false,
        [],
        observed(bad),
      ),
      true,
    );
    editor.contextEvent(uri(templateFilename));
    assert.deepEqual(
      queued,
      [{ target: document.uri.toString(), force: true }],
      "canonical template event must refresh an alias-owned primary",
    );
    assert.ok(
      dependencies.revision(folder.uri.toString(), primary) > aliasRevision,
    );
    editor.contextEvent(uri(templateFilename));
    assert.equal(
      queued.length,
      1,
      "the consumed event still coalesces its echo",
    );
    document.isDirty = true;
    await writeFile(templateFilename, good);
    assert.equal(
      dependencies.accept(
        folder.uri.toString(),
        report(good),
        dependencies.begin(),
        false,
        [],
        observed(good),
      ),
      true,
    );
    const beforeDirtyEvent = dependencies.revision(
      folder.uri.toString(),
      primary,
    );
    editor.contextEvent(uri(templateFilename));
    assert.ok(
      dependencies.revision(folder.uri.toString(), primary) > beforeDirtyEvent,
    );
    assert.equal(
      queued.length,
      1,
      "dirty aliases remain stale without an automatic buffer check",
    );
    assert.equal(await realpath(alias), filename);
    assert.equal(hash(await readFile(filename)), hash(text));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("closed watcher selection classifies physical templates and preserves ordinary YAML primaries", async () => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-template-selection-")),
  );
  const templates = join(base, "roles/demo/templates");
  const yaml = join(base, "roles/demo/defaults/main.yml");
  const uri = (filename: string) => ({
    scheme: "file",
    path: filename.replaceAll("\\", "/"),
    fsPath: filename,
    toString: () => `file://${filename}`,
  });
  const module = {
    exports: {} as { EditorIntegration: typeof EditorIntegration },
  };
  const documents: TextDocument[] = [];
  const folder = { uri: uri(base) };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    api: {
      workspace: {
        isTrusted: true,
        getWorkspaceFolder: () => folder,
        workspaceFolders: [folder],
        textDocuments: documents,
      },
      Uri: { file: uri },
    },
  });
  const selected: string[][] = [];
  const checked: string[] = [];
  let root = base;
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as {
      flushFiles(): Promise<void>;
    },
    {
      disposed: false,
      flushingFiles: false,
      closedTabs: new Set(),
      sourceOwners: new Map(),
      canonicalRoots: new Map(),
      rootRevisions: new Map(),
      documentRevisions: new WeakMap(),
      nextRevision: 0,
      roots: { ready: async () => {}, get: () => root, folder: () => folder },
      dependencies: { admissionRevision: () => 0 },
      pendingFiles: new Map(),
      pendingRefresh: new Set(),
      missingFiles: new Map(),
      fileFingerprints: new Map(),
      pendingDiskReload: new Set(),
      results: { hasCompleteScan: () => true, document: () => undefined },
      checkSaved: async (
        _folder: unknown,
        _manual: boolean,
        files: Map<string, unknown>,
      ) => {
        selected.push([...files.keys()]);
        return new Set();
      },
      check: async (document: TextDocument) => {
        checked.push(document.uri.fsPath);
      },
      error(error: unknown) {
        throw error;
      },
    },
  );
  try {
    await mkdir(templates, { recursive: true });
    await mkdir(join(base, "roles/demo/defaults"), { recursive: true });
    await writeFile(yaml, "demo_role_value: true\n");
    await writeFile(join(templates, "config.yaml"), "{% if broken %}");
    await symlink(
      join(templates, "config.yaml"),
      join(base, "hidden.yaml"),
      "file",
    );
    await symlink(yaml, join(templates, "yaml-alias.yaml"), "file");
    for (const scenario of [
      {
        filename: join(templates, "config.yaml"),
        narrow: true,
        open: false,
        primary: false,
      },
      {
        filename: join(base, "hidden.yaml"),
        narrow: false,
        open: false,
        primary: false,
      },
      {
        filename: join(templates, "yaml-alias.yaml"),
        narrow: false,
        open: false,
        primary: false,
      },
      { filename: yaml, narrow: false, open: false, primary: true },
      {
        filename: join(templates, "config.yaml"),
        narrow: true,
        open: true,
        primary: true,
      },
    ]) {
      root = scenario.narrow ? templates : base;
      selected.length = 0;
      checked.length = 0;
      documents.length = 0;
      const target = uri(scenario.filename);
      if (scenario.open)
        documents.push({
          uri: target,
          languageId: "yaml",
          isClosed: false,
          isDirty: false,
          version: 1,
          getText: () => "{% if broken %}",
        } as unknown as TextDocument);
      (Reflect.get(editor, "pendingFiles") as Map<string, unknown>).set(
        target.toString(),
        { uri: target, force: true },
      );
      await editor.flushFiles();
      assert.equal(
        selected.length + checked.length,
        scenario.primary ? 1 : 0,
        JSON.stringify(scenario),
      );
      if (scenario.open) assert.deepEqual(checked, [scenario.filename]);
      if (scenario.primary && !scenario.open)
        assert.deepEqual(selected, [["roles/demo/defaults/main.yml"]]);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("snapshot check and query retain reverse template spelling while responses remain canonically owned", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-template-wire-")),
  );
  let filename = join(root, "roles/demo/defaults/main.yml");
  const alias = join(root, "roles/a/templates/alias.j2");
  const text = 'demo_role_value: "{{ value\n }}"\n';
  let buffer = text;
  const uri = (filename: string) => ({
    scheme: "file",
    path: filename.replaceAll("\\", "/"),
    fsPath: filename,
    toString: () => `file://${filename}`,
  });
  const document = {
    uri: uri(alias),
    languageId: "plaintext",
    version: 1,
    isClosed: false,
    isDirty: false,
    getText: () => buffer,
  } as unknown as TextDocument;
  const folder = { uri: uri(root) };
  const requests: { args: string[]; input?: string | Uint8Array }[] = [];
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
    api: {
      workspace: {
        isTrusted: true,
        getWorkspaceFolder: () => folder,
        textDocuments: [document],
      },
      Uri: { file: uri },
      runProcess: async (request: {
        args: string[];
        input?: string | Uint8Array;
      }) => {
        requests.push(request);
        throw new Error(
          "controlled wire capture stops before response acceptance",
        );
      },
    },
  });
  const submit = async (
    _key: string,
    _priority: number,
    operation: (signal: AbortSignal) => Promise<unknown>,
  ) => operation(new AbortController().signal);
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as {
      check(
        document: TextDocument,
        manual: boolean,
        version: number,
      ): Promise<unknown>;
      query(
        document: TextDocument,
        position: { line: number; character: number },
        operation: string,
      ): Promise<unknown>;
    },
    {
      disposed: false,
      executable: "controlled-CLI",
      closedTabs: new Set(),
      sourceOwners: new Map(),
      canonicalRoots: new Map(),
      documentFolders: new Map(),
      checking: new Map(),
      rootRevisions: new Map(),
      documentRevisions: new WeakMap(),
      nextRevision: 0,
      queryRevision: 1,
      relatedRevision: 0,
      failures: new Map(),
      pendingFiles: new Map(),
      fileFingerprints: new Map(),
      pendingDiskReload: new Set(),
      missingFiles: new Map(),
      roots: {
        ready: async () => {},
        refresh: async () => {},
        get: () => root,
        watchSource() {},
        forgetSource() {},
      },
      dependencies: {
        begin: () => 0,
        revision: () => 0,
        admissionRevision: () => 0,
        remove() {},
      },
      results: { close() {}, invalidateRelated: () => new Set<string>() },
      collection: { delete() {} },
      eligibilityChanged: { fire() {} },
      publish() {},
      updateStatus() {},
      error() {},
      lint: { submit, cancel() {} },
      formatting: { cancel() {} },
      queryLanes: new Map([["definition", { submit, cancelAll() {} }]]),
    },
  );
  try {
    await mkdir(join(root, "roles/demo/defaults"), { recursive: true });
    await mkdir(join(root, "roles/a/templates"), { recursive: true });
    await writeFile(filename, text);
    await symlink(filename, alias, "file");
    await editor.check(document, true, 1);
    await editor.query(document, { line: 0, character: 25 }, "definition");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(
        request.args[request.args.indexOf("--stdin-filename") + 1],
        filename,
      );
      assert.equal(
        request.args[request.args.indexOf("--stdin-source-filename") + 1],
        alias,
      );
      assert.equal(request.input, text);
    }
    assert.deepEqual(
      requests.map((request) => request.args[0]),
      ["check", "query"],
    );
    // Both spellings are templates, but the alias role still owns relevant
    // task configuration. The original spelling must accompany both requests.
    filename = join(root, "roles/b/templates/config");
    await mkdir(join(root, "roles/b/templates"), { recursive: true });
    await writeFile(filename, text);
    await rm(alias);
    await symlink(filename, alias, "file");
    Reflect.set(document, "version", 2);
    requests.length = 0;
    await editor.check(document, true, 2);
    await editor.query(document, { line: 0, character: 25 }, "definition");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(
        request.args[request.args.indexOf("--stdin-filename") + 1],
        filename,
      );
      assert.equal(
        request.args[request.args.indexOf("--stdin-source-filename") + 1],
        alias,
      );
      assert.equal(request.input, text);
    }
    const raw = Uint8Array.from([0xff, 0x00, 0x0d, 0x0a]);
    await writeFile(filename, raw);
    buffer = Buffer.from(raw).toString("utf8");
    Reflect.set(document, "version", 3);
    requests.length = 0;
    await editor.check(document, true, 3);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].args[requests[0].args.indexOf("--stdin-source-filename") + 1],
      alias,
    );
    assert.deepEqual(
      [...requests[0].input!],
      [...raw],
      "unsupported templates send raw bytes without editor replacement characters",
    );
    await editor.query(document, { line: 0, character: 0 }, "definition");
    assert.equal(
      requests.length,
      1,
      "navigation declines invalid UTF8 before subprocess work",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
