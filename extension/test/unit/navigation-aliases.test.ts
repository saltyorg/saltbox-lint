import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import type { Uri, TextDocument } from "vscode";
import type { validateNavigation } from "../../src/navigation.ts";
import type { QueryReport } from "../../src/navigation-protocol.ts";
import { SnapshotIndex, hash } from "../../src/protocol.ts";
import { observeAnalysis } from "../../src/observations.ts";

const bundled = await build({
  entryPoints: ["src/navigation.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
const sourcePath = "roles/navsource/tasks/main.yml";
const owner = "roles/readonly/defaults/reverse.yml";
const alias = "roles/readonly/templates/reverse.yaml";
const primary =
  "# 😀é\r\n- debug: {msg: \"😀 {{ lookup('role_var', '_port', role='navtarget') }}\"}\r\n";
const text =
  "readonly_role_value: \"{{ value\n }}\"\nlookup: \"{{ lookup('role_var', '_port', role='navtarget') }}\"\n";
function uri(filename: string) {
  return {
    scheme: "file",
    path: filename,
    fsPath: filename,
    toString: () => "file://" + filename,
  };
}
class Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
  constructor(a: number, b: number, c: number, d: number) {
    this.start = { line: a, character: b };
    this.end = { line: c, character: d };
  }
}
class Location {
  readonly uri: Uri;
  readonly range: Range;
  constructor(uri: Uri, range: Range) {
    this.uri = uri;
    this.range = range;
  }
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-navigation-target-alias-")),
  );
  const external = root + "-external";
  for (const directory of [
    "roles/navsource/tasks",
    "roles/readonly/defaults",
    "roles/readonly/templates",
    ".git",
    "owned-admin",
  ])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, sourcePath), primary);
  await writeFile(join(root, owner), text);
  await writeFile(join(root, "other.yml"), text);
  await writeFile(join(root, ".git/config"), text);
  await writeFile(join(root, "owned-admin/config"), text);
  await writeFile(external, text);
  await symlink(join(root, owner), join(root, alias), "file");
  const read = {
    path: sourcePath,
    span: { start: 34, end: 79 },
    line: 2,
    column: 22,
    text: Buffer.from(primary).subarray(34, 79).toString(),
    kind: "read" as const,
  };
  const target = {
    path: alias,
    span: { start: 48, end: 93 },
    line: 3,
    column: 13,
    text: Buffer.from(text).subarray(48, 93).toString(),
    kind: "read" as const,
  };
  const report: QueryReport = {
    schema_version: 1,
    root,
    path: sourcePath,
    source_sha256: hash(primary),
    operation: "references",
    offset: 56,
    state: "ambiguous",
    reasons: [],
    coverage: { complete: false, reasons: ["static-reads-only"] },
    origin: read,
    target_hashes: {
      [sourcePath]: hash(primary),
      [owner]: hash(text),
      [alias]: hash(text),
    },
    locations: [read, { ...target, path: owner }, target],
    declarations: [],
    completions: [],
    dependencies: {
      schema_version: 1,
      root,
      generation: hash("generation"),
      complete: true,
      sources: [
        {
          path: sourcePath,
          source_sha256: hash(primary),
          files: [
            { path: sourcePath, state: "read", sha256: hash(primary) },
            { path: owner, state: "read", sha256: hash(text) },
            { path: alias, state: "read", sha256: hash(text) },
          ],
          identity: [],
          discovery: [],
          directories: [],
        },
      ],
    },
  };
  const documents: TextDocument[] = [];
  let afterRead: ((filename: string) => Promise<void>) | undefined;
  const module = {
    exports: {} as { validateNavigation: typeof validateNavigation },
  };
  const originalRequire = createRequire(import.meta.url);
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    Buffer,
    require: (name: string) =>
      name === "vscode"
        ? {
            Uri: { file: uri },
            Range,
            Location,
            workspace: { textDocuments: documents },
          }
        : name === "node:fs/promises"
          ? {
              ...originalRequire(name),
              readFile: async (filename: string) => {
                const bytes = await readFile(filename);
                await afterRead?.(filename);
                return bytes;
              },
            }
          : originalRequire(name),
  });
  const observed = await observeAnalysis(
    report.dependencies,
    new Set([sourcePath]),
    undefined,
    undefined,
    true,
  );
  assert.equal(observed.changed.size, 0);
  const validate = (useAliases = true) =>
    module.exports.validateNavigation(
      report,
      primary,
      new SnapshotIndex(primary),
      uri(join(root, sourcePath)) as unknown as Uri,
      undefined,
      useAliases ? observed.aliases : undefined,
    );
  return {
    root,
    external,
    report,
    observed,
    documents,
    validate,
    setRead: (hook: typeof afterRead) => {
      afterRead = hook;
    },
    retarget: async (destination: string) => {
      await rm(join(root, alias), { force: true });
      await symlink(destination, join(root, alias), "file");
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(external, { force: true });
    },
  };
}

test("saved lexical reference aliases retain their URI and Unicode CRLF spans only with an admitted owner", async () => {
  const f = await fixture();
  try {
    assert.equal(
      await f.validate(false),
      undefined,
      "strict global source resolution still declines an unobserved alias",
    );
    assert.equal(f.observed.aliases.size, 1);
    const answer = await f.validate();
    assert.ok(answer);
    assert.equal(answer.locations.size, 3);
    const location = answer.locations.get(f.report.locations[2]);
    assert.equal(location?.uri.fsPath, join(f.root, alias));
    assert.equal(location?.range.start.line, 2);
    assert.equal(location?.range.start.character, 12);
    assert.equal(location?.range.end.line, 2);
    assert.equal(location?.range.end.character, 57);
    assert.equal(await answer.targetsCurrent(), true);
    f.documents.push({
      uri: uri(join(f.root, alias)),
      isClosed: false,
      isDirty: true,
      getText: () => text,
    } as unknown as TextDocument);
    assert.equal(
      await answer.targetsCurrent(),
      false,
      "late dirty aliases revoke a previously mapped answer",
    );
    f.documents.length = 0;
    f.documents.push({
      uri: uri(join(f.root, owner)),
      isClosed: false,
      isDirty: true,
      getText: () => text,
    } as unknown as TextDocument);
    assert.equal(
      await answer.targetsCurrent(),
      false,
      "late dirty owners revoke a previously mapped answer",
    );
    f.documents.length = 0;
    await f.retarget(join(f.root, "other.yml"));
    assert.equal(
      await answer.targetsCurrent(),
      false,
      "a returned answer cannot retain a retargeted alias",
    );
  } finally {
    await f.cleanup();
  }
});
for (const change of [
  "retarget same bytes",
  "deleted",
  "escape",
  "git admin",
  "separate admin",
  "stale hash",
  "dirty canonical",
  "dirty alias",
  "stale clean alias",
  "unrelated dirty same bytes",
  "changed during read",
  "root identity",
  "unsafe lexical",
  "range mismatch",
  "UTF8 boundary",
] as const) {
  test(`saved reference alias ${change} preserves only a current source observation`, async () => {
    const f = await fixture();
    try {
      if (change === "retarget same bytes")
        await f.retarget(join(f.root, "other.yml"));
      if (change === "deleted") await rm(join(f.root, alias));
      if (change === "escape") await f.retarget(f.external);
      if (change === "git admin") await f.retarget(join(f.root, ".git/config"));
      if (change === "separate admin")
        await f.retarget(join(f.root, "owned-admin/config"));
      if (change === "stale hash")
        f.report.target_hashes[alias] = hash("stale");
      if (
        [
          "dirty canonical",
          "dirty alias",
          "stale clean alias",
          "unrelated dirty same bytes",
        ].includes(change)
      ) {
        const filename =
          change === "dirty canonical"
            ? owner
            : change === "unrelated dirty same bytes"
              ? "other.yml"
              : alias;
        f.documents.push({
          uri: uri(join(f.root, filename)),
          isClosed: false,
          isDirty: change !== "stale clean alias",
          getText: () => (change === "stale clean alias" ? "stale" : text),
        } as unknown as TextDocument);
      }
      if (change === "changed during read")
        f.setRead(async (filename) => {
          if (filename === join(f.root, owner))
            await f.retarget(join(f.root, "other.yml"));
        });
      if (change === "root identity")
        await mkdir(join(f.root, "new-root-entry"));
      if (change === "unsafe lexical") {
        const unsafe = "roles/readonly/templates/../templates/reverse.yaml";
        const observed = f.observed.aliases.get(alias);
        assert.ok(observed);
        f.observed.aliases.set(unsafe, observed);
        f.report.target_hashes[unsafe] = f.report.target_hashes[alias];
        delete f.report.target_hashes[alias];
        f.report.locations[2].path = unsafe;
      }
      if (change === "range mismatch") f.report.locations[2].column++;
      if (change === "UTF8 boundary") f.report.locations[0].span.start = 3;
      if (change === "range mismatch" || change === "UTF8 boundary")
        await assert.rejects(f.validate());
      else if (change === "unrelated dirty same bytes")
        assert.ok(await f.validate());
      else assert.equal(await f.validate(), undefined);
    } finally {
      await f.cleanup();
    }
  });
}
test("unadmitted equal-content and opaque canonical owners cannot acquire alias observations", async () => {
  const f = await fixture();
  try {
    for (const destination of [
      join(f.root, "other.yml"),
      join(f.root, "owned-admin/config"),
      join(f.root, ".git/config"),
      f.external,
    ]) {
      await f.retarget(destination);
      const observed = await observeAnalysis(
        f.report.dependencies,
        new Set([sourcePath]),
        undefined,
        undefined,
        true,
      );
      assert.equal(observed.aliases.size, 0);
    }
  } finally {
    await f.cleanup();
  }
});

test("discovery controls and equal content do not confer alias source ownership", async () => {
  const f = await fixture();
  try {
    for (const target of ["other.yml", "owned-admin/config", ".git/config"]) {
      await f.retarget(join(f.root, target));
      f.report.dependencies.sources[0].discovery = [
        { path: target, state: "read", sha256: hash(text) },
      ];
      const observed = await observeAnalysis(
        f.report.dependencies,
        new Set([sourcePath]),
        undefined,
        undefined,
        true,
      );
      assert.equal(observed.aliases.size, 0);
    }
    f.report.dependencies.sources[0].files.push({
      path: ".git/config",
      state: "read",
      sha256: hash(text),
    });
    const observed = await observeAnalysis(
      f.report.dependencies,
      new Set([sourcePath]),
      undefined,
      undefined,
      true,
    );
    assert.equal(
      observed.aliases.size,
      0,
      "an opaque .git target remains inadmissible even with a matching digest",
    );
  } finally {
    await f.cleanup();
  }
});

const queryBundle = await build({
  entryPoints: ["src/editor.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "query-wire",
      setup(builder) {
        builder.onResolve(
          { filter: /^vscode$|^\.\/process\.ts$/ },
          ({ path }) => ({ path, namespace: "query-wire" }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "query-wire" },
          ({ path }) => ({
            contents:
              path === "vscode"
                ? "module.exports=globalThis.api"
                : "exports.runProcess=globalThis.api.runProcess",
            loader: "js",
          }),
        );
      },
    },
  ],
});

for (const change of [
  "stable",
  "document version",
  "document hash",
  "document revision",
  "root revision",
  "dependency revision",
  "dependency generation",
  "query generation",
  "marker removed",
  "document closed",
] as const) {
  test(`actual alias reference query ${change} retains its captured source and generation`, async () => {
    const f = await fixture();
    const { Scheduler } = await import("../../src/scheduler.ts");
    const lane = new Scheduler();
    let buffer = primary,
      activeRoot: string | undefined = f.root,
      dependency = 0,
      generation = 0;
    const document = {
      uri: uri(join(f.root, sourcePath)),
      languageId: "yaml",
      isClosed: false,
      isDirty: false,
      version: 1,
      getText: () => buffer,
    };
    const model = document as unknown as TextDocument;
    const folder = { uri: uri(f.root) };
    const roots = new Map<string, number>();
    const revisions = new WeakMap<TextDocument, number>();
    let enter!: () => void, release!: (wire: string) => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    const module = {
      exports: {} as {
        EditorIntegration: typeof import("../../src/editor.ts").EditorIntegration;
      },
    };
    const originalRequire = createRequire(import.meta.url);
    runInNewContext(queryBundle.outputFiles[0].text, {
      module,
      exports: module.exports,
      require: originalRequire,
      process,
      Buffer,
      AbortController,
      setTimeout,
      clearTimeout,
      api: {
        Uri: { file: uri },
        Range,
        Location,
        workspace: {
          isTrusted: true,
          textDocuments: [document],
          getWorkspaceFolder: () => folder,
        },
        runProcess: async () => {
          enter();
          return new Promise<string>((done) => {
            release = done;
          });
        },
      },
    });
    const editor = Object.assign(
      Object.create(module.exports.EditorIntegration.prototype),
      {
        disposed: false,
        executable: "controlled-query",
        queryRevision: 0,
        closedTabs: new Set(),
        sourceOwners: new Map(),
        canonicalRoots: new Map(),
        documentFolders: new Map(),
        checking: new Map(),
        rootRevisions: roots,
        documentRevisions: revisions,
        nextRevision: 0,
        roots: {
          ready: async () => {},
          get: () => activeRoot,
          watchSource() {},
        },
        dependencies: {
          begin: () => generation,
          revision: () => dependency,
          admissionRevision: () => 0,
        },
        eligibilityChanged: { fire() {} },
        publish() {},
        queryLanes: new Map([["references", lane]]),
      },
    );
    const query = Reflect.get(editor, "query") as (
      document: TextDocument,
      position: { line: number; character: number },
      operation: "references",
    ) => Promise<Awaited<ReturnType<typeof validateNavigation>>>;
    try {
      const pending = Reflect.apply(query, editor, [
        model,
        new SnapshotIndex(primary).span({ start: 56, end: 56 }).start,
        "references",
      ]) as ReturnType<typeof query>;
      await entered;
      if (change === "document version") document.version++;
      if (change === "document hash") buffer += "\n# new";
      if (change === "document revision") revisions.set(model, 99);
      if (change === "root revision") roots.set(folder.uri.toString(), 99);
      if (change === "dependency revision") dependency++;
      if (change === "dependency generation") generation++;
      if (change === "query generation") editor.queryRevision++;
      if (change === "marker removed") activeRoot = undefined;
      if (change === "document closed") document.isClosed = true;
      release(JSON.stringify(f.report));
      const answer = await pending;
      assert.equal(!!answer, change === "stable");
      if (answer) {
        assert.equal(answer.locations.size, 3);
        assert.equal(
          answer.locations.get(f.report.locations[2]),
          undefined,
          "wire parsing owns new location objects",
        );
        assert.ok(
          [...answer.locations.values()].some(
            (location) => location.uri.fsPath === join(f.root, alias),
          ),
        );
      }
    } finally {
      lane.dispose();
      await f.cleanup();
    }
  });
}
