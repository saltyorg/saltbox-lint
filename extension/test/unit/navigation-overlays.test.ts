import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  symlink,
  rm,
  utimes,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { SnapshotIndex, hash } from "../../src/protocol.ts";
import { observeAnalysis } from "../../src/observations.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { synchronizeDirtyAliases } from "../host/dirty-alias-buffers.ts";
import type { QueryReport } from "../../src/navigation-protocol.ts";
import type { validateNavigation } from "../../src/navigation.ts";
import type { Uri, TextDocument } from "vscode";

const sourcePath = "roles/a/defaults/reverse.yml";
const alias = "roles/a/templates/reverse.yaml";
const secondAlias = "roles/a/templates/second.j2";
const earlier = "roles/b/defaults/earlier.yml";
const savedAlias = "roles/b/templates/earlier.j2";
const earlierText = "# 😀é\r\nb_value: 42\r\n";
const later = "roles/b/defaults/main.yml";
const text = "😀é\r\n{{ value }}\r\n{# dirty buffer #}";
const laterText = "b_value: 42\n";
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
async function bundle(entry: string, query = false) {
  return (
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      plugins: [
        {
          name: "overlay-api",
          setup(builder) {
            builder.onResolve(
              {
                filter: query
                  ? /^vscode$|^\.\/process\.ts$|^\.\/navigation\.ts$/
                  : /^vscode$/,
              },
              ({ path }) => ({ path, namespace: "overlay-api" }),
            );
            builder.onLoad(
              { filter: /.*/, namespace: "overlay-api" },
              ({ path }) => ({
                contents:
                  path === "vscode"
                    ? "module.exports=globalThis.api"
                    : path === "./process.ts"
                      ? "exports.runProcess=globalThis.api.runProcess"
                      : "exports.validateNavigation=globalThis.api.validateNavigation",
                loader: "js",
              }),
            );
          },
        },
      ],
    })
  ).outputFiles[0].text;
}
const validatorBundle = await bundle("src/navigation.ts");
const queryBundle = await bundle("src/editor.ts", true);

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-navigation-overlay-")),
  );
  const external = root + "-external";
  const original = join(root, "reverse-alias.j2");
  for (const directory of [
    "roles/a/defaults",
    "roles/a/templates",
    "roles/b/defaults",
    "roles/b/templates",
    ".git",
    "owned-admin",
  ])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, sourcePath), "saved contents");
  await writeFile(join(root, earlier), earlierText);
  await writeFile(join(root, later), laterText);
  await symlink(join(root, later), join(root, savedAlias), "file");
  await symlink(
    join(root, earlier),
    join(root, "roles/b/templates/buffer.yml"),
    "file",
  );
  await writeFile(join(root, "other.yml"), text);
  await writeFile(join(root, ".git/config"), text);
  await writeFile(join(root, "owned-admin/config"), text);
  await writeFile(external, text);
  await symlink(join(root, sourcePath), join(root, alias), "file");
  await symlink(join(root, sourcePath), join(root, secondAlias), "file");
  await symlink(join(root, sourcePath), original, "file");
  const document = {
    uri: uri(original),
    languageId: "jinja",
    isClosed: false,
    isDirty: true,
    eol: 2,
    version: 1,
    getText: () => text,
  };
  const documents = [document as unknown as TextDocument];
  const module = {
    exports: {} as { validateNavigation: typeof validateNavigation },
  };
  let afterRead: ((filename: string) => Promise<void>) | undefined;
  let afterResolve: ((filename: string) => Promise<void>) | undefined;
  const originalRequire = createRequire(import.meta.url);
  const fs = {
    ...originalRequire("node:fs/promises"),
    realpath: async (filename: string) => {
      const resolved = await realpath(filename);
      await afterResolve?.(filename);
      return resolved;
    },
    readFile: async (filename: string) => {
      const bytes = await readFile(filename);
      await afterRead?.(filename);
      return bytes;
    },
  };
  const require = (name: string) =>
    name === "node:fs/promises" ? fs : originalRequire(name);
  const api = {
    Uri: { file: uri },
    Range,
    Location,
    workspace: { textDocuments: documents },
  };
  runInNewContext(validatorBundle, {
    module,
    exports: module.exports,
    require,
    process,
    Buffer,
    api,
  });
  const digest = hash(text);
  const read = {
    path: alias,
    span: { start: 11, end: 16 },
    line: 2,
    column: 4,
    text: "value",
    kind: "read" as const,
  };
  const report: QueryReport = {
    schema_version: 1,
    root,
    path: sourcePath,
    source_sha256: digest,
    operation: "references",
    offset: 11,
    state: "resolved",
    origin: { ...read, path: sourcePath },
    reasons: [],
    coverage: { complete: false, reasons: ["static-reads-only"] },
    target_hashes: {
      [sourcePath]: digest,
      [alias]: digest,
      [secondAlias]: digest,
      [earlier]: hash(earlierText),
      [savedAlias]: hash(laterText),
      [later]: hash(laterText),
    },
    locations: [
      read,
      { ...read, path: secondAlias },
      ...[earlier, savedAlias].map((path) => ({
        path,
        span: path === earlier ? { start: 10, end: 17 } : { start: 0, end: 7 },
        line: path === earlier ? 2 : 1,
        column: 1,
        text: "b_value",
        kind: "declaration" as const,
      })),
      {
        path: later,
        span: { start: 0, end: 7 },
        line: 1,
        column: 1,
        text: "b_value",
        kind: "declaration",
      },
    ],
    declarations: [
      {
        name: "b_value",
        role: "b",
        role_path: "roles/b",
        provenance: "roles/b/defaults/earlier.yml",
        key: {
          path: earlier,
          span: { start: 10, end: 17 },
          line: 2,
          column: 1,
          text: "b_value",
        },
        value: {
          path: earlier,
          span: { start: 19, end: 21 },
          line: 2,
          column: 10,
          text: "42",
        },
        comments: [
          {
            path: earlier,
            span: { start: 0, end: 8 },
            line: 1,
            column: 1,
            text: "# 😀é",
          },
        ],
      },
    ],
    completions: [],
    dependencies: {
      schema_version: 1,
      root,
      generation: digest,
      complete: true,
      sources: [
        {
          path: sourcePath,
          source_sha256: digest,
          files: [
            { path: sourcePath, sha256: digest, state: "read" },
            { path: alias, sha256: digest, state: "read" },
            { path: secondAlias, sha256: digest, state: "read" },
            { path: earlier, sha256: hash(earlierText), state: "read" },
            { path: savedAlias, sha256: hash(laterText), state: "read" },
            { path: later, sha256: hash(laterText), state: "read" },
          ],
          identity: [],
          discovery: [],
          directories: [],
        },
      ],
    },
  };
  const observed = await observeAnalysis(
    report.dependencies,
    new Set([sourcePath]),
    undefined,
    {
      path: sourcePath,
      filename: join(root, sourcePath),
      sourceFilename: original,
      sha256: digest,
    },
    true,
  );
  assert.equal(observed.changed.size, 0);
  const validate = (
    paths = observed.overlayPaths,
    aliases = observed.aliases,
  ) =>
    module.exports.validateNavigation(
      report,
      text,
      new SnapshotIndex(text),
      document.uri as unknown as Uri,
      paths,
      aliases,
      observed.targets,
    );
  const retarget = async (destination: string) => {
    await rm(join(root, alias));
    await symlink(destination, join(root, alias), "file");
  };
  return {
    root,
    external,
    original,
    document,
    documents,
    report,
    observed,
    validate,
    require,
    api,
    actualValidator: module.exports.validateNavigation,
    setResolve: (hook: typeof afterResolve) => {
      afterResolve = hook;
    },
    setRead: (hook: typeof afterRead) => {
      afterRead = hook;
    },
    retarget,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(external, { force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
test("dirty fixture synchronizes an earlier nonclosed saved alias before positive navigation", async () => {
  const f = await fixture();
  f.document.uri = uri(join(f.root, alias));
  const saved = await readFile(join(f.root, sourcePath));
  let aliasText = saved.toString("utf8");
  const prior = {
    uri: uri(join(f.root, "reverse-alias.j2")),
    isClosed: false,
    isDirty: false,
    version: 7,
    eol: 2,
    getText: () => aliasText,
  };
  f.documents.push(prior as unknown as TextDocument);
  let buffers: Awaited<ReturnType<typeof synchronizeDirtyAliases>> | undefined;
  let setupEdits = 0;
  try {
    // A closed tab does not close this earlier public model. The positive
    // fixture must synchronize its bytes before asking for dirty navigation.
    assert.equal(
      await f.validate(),
      undefined,
      "the original conflict remains refused",
    );
    buffers = await synchronizeDirtyAliases({
      root: f.root,
      owner: join(f.root, sourcePath),
      primary: f.document,
      baseline: saved,
      knownURIs: [f.document.uri.toString(), prior.uri.toString()],
      documents: () => f.documents,
      replace: async (document, value) => {
        assert.equal(document, prior);
        setupEdits++;
        aliasText = value;
        prior.version++;
        prior.isDirty = true;
      },
    });
    buffers.assertCurrent();
    assert.equal(setupEdits, 1);
    const answer = await f.validate();
    assert.ok(answer, "dirty positive fixture requires coherent alias buffers");
    assert.equal(
      answer.locations.get(f.report.locations[0])?.uri,
      f.document.uri,
    );
    assert.deepEqual(answer.locations.get(f.report.locations[0])?.range.start, {
      line: 1,
      character: 3,
    });
    assert.deepEqual(answer.locations.get(f.report.locations[0])?.range.end, {
      line: 1,
      character: 8,
    });
    assert.equal(await answer.targetsCurrent(), true);
    assert.equal(answer.targetsCurrentNow(), true);
    buffers.assertCurrent();
    assert.equal(setupEdits, 1, "navigation applies no buffer edits");
    assert.equal(hash(f.document.getText()), f.report.source_sha256);
    assert.deepEqual(await readFile(join(f.root, sourcePath)), saved);
    // The real final acceptance guard still refuses a reintroduced conflict.
    aliasText = saved.toString("utf8");
    prior.isDirty = false;
    assert.equal(await answer.targetsCurrent(), false);
    assert.equal(answer.targetsCurrentNow(), false);
  } finally {
    await buffers?.restore();
    assert.equal(aliasText, saved.toString("utf8"));
    await f.cleanup();
  }
});
const changes = [
  "stable",
  "deleted",
  "second alias deleted",
  "same contents different owner",
  "escape",
  "git admin",
  "separate admin",
  "root identity",
  "owner replacement",
  "conflicting dirty alias",
  "conflicting clean alias",
  "conflicting dirty owner",
  "matching dirty alias",
  "unrelated dirty buffer",
  "ordinary in-place edit",
  "ordinary restored-mtime edit",
  "ordinary equal-content replacement",
  "ordinary deleted",
  "ordinary retarget same bytes",
  "ordinary escape",
  "ordinary git admin",
  "ordinary separate admin",
  "ordinary conflicting dirty owner",
  "ordinary matching dirty owner",
  "ordinary conflicting clean owner",
  "ordinary conflicting dirty alias",
  "ordinary conflicting clean alias",
  "ordinary matching clean alias",
  "ordinary closed conflict",
] as const;
type Change = (typeof changes)[number];
async function change(f: Fixture, kind: Change) {
  if (kind === "ordinary in-place edit")
    await writeFile(join(f.root, earlier), "# changed\r\nb_value: 99\r\n");
  if (kind === "ordinary restored-mtime edit") {
    const before = await stat(join(f.root, earlier));
    await writeFile(join(f.root, earlier), earlierText.replace("42", "99"));
    await utimes(join(f.root, earlier), before.atime, before.mtime);
  }
  if (kind === "ordinary equal-content replacement") {
    await rm(join(f.root, earlier));
    await writeFile(join(f.root, earlier), earlierText);
  }
  if (kind === "ordinary deleted") await rm(join(f.root, earlier));
  if (
    [
      "ordinary retarget same bytes",
      "ordinary escape",
      "ordinary git admin",
      "ordinary separate admin",
    ].includes(kind)
  ) {
    const destination =
      kind === "ordinary escape"
        ? f.external
        : join(
            f.root,
            kind === "ordinary git admin"
              ? ".git/config"
              : kind === "ordinary separate admin"
                ? "owned-admin/config"
                : "other.yml",
          );
    await writeFile(destination, earlierText);
    await rm(join(f.root, earlier));
    await symlink(destination, join(f.root, earlier), "file");
  }
  if (
    kind.startsWith("ordinary ") &&
    (kind.includes("conflict") || kind.includes("matching"))
  ) {
    f.documents.push({
      uri: uri(
        join(
          f.root,
          kind.includes("alias") ? "roles/b/templates/buffer.yml" : earlier,
        ),
      ),
      isClosed: kind === "ordinary closed conflict",
      isDirty: !kind.includes("clean"),
      getText: () =>
        kind.includes("matching") ? earlierText : "conflicting buffer",
    } as unknown as TextDocument);
  }
  if (kind === "deleted") await rm(join(f.root, alias));
  if (kind === "second alias deleted") await rm(join(f.root, secondAlias));
  if (kind === "same contents different owner")
    await f.retarget(join(f.root, "other.yml"));
  if (kind === "escape") await f.retarget(f.external);
  if (kind === "git admin") await f.retarget(join(f.root, ".git/config"));
  if (kind === "separate admin")
    await f.retarget(join(f.root, "owned-admin/config"));
  if (kind === "root identity") await mkdir(join(f.root, "new-root-entry"));
  if (kind === "owner replacement") {
    await rm(join(f.root, sourcePath));
    await writeFile(join(f.root, sourcePath), "saved contents");
  }
  if (
    [
      "conflicting dirty alias",
      "conflicting clean alias",
      "conflicting dirty owner",
      "matching dirty alias",
      "unrelated dirty buffer",
    ].includes(kind)
  ) {
    const filename =
      kind === "conflicting dirty owner"
        ? sourcePath
        : kind === "unrelated dirty buffer"
          ? "other.yml"
          : alias;
    f.documents.push({
      uri: uri(join(f.root, filename)),
      isClosed: false,
      isDirty: kind !== "conflicting clean alias",
      getText: () =>
        kind === "matching dirty alias" ? text : "conflicting buffer",
    } as unknown as TextDocument);
  }
}
const accepted = (kind: string) =>
  [
    "stable",
    "matching dirty alias",
    "unrelated dirty buffer",
    "ordinary closed conflict",
    "ordinary matching clean alias",
  ].includes(kind);
for (const kind of changes) {
  test(`mapped template overlay ${kind} is checked again at final target acceptance`, async () => {
    const f = await fixture();
    try {
      const answer = await f.validate();
      assert.ok(answer);
      assert.equal(
        answer.locations.get(f.report.locations[0])?.uri,
        f.document.uri,
      );
      assert.deepEqual(
        answer.locations.get(f.report.locations[0])?.range.start,
        { line: 1, character: 3 },
      );
      assert.deepEqual(answer.locations.get(f.report.locations[0])?.range.end, {
        line: 1,
        character: 8,
      });
      await change(f, kind);
      assert.equal(await answer.targetsCurrent(), accepted(kind));
      assert.equal(answer.targetsCurrentNow(), accepted(kind));
    } finally {
      await f.cleanup();
    }
  });
  test(`template overlay ${kind} while a later declaration read is held cannot escape validation`, async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let enter!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    f.setRead(async (filename) => {
      if (filename === join(f.root, later)) {
        enter();
        await held;
      }
    });
    let pending: ReturnType<typeof f.validate> | undefined;
    try {
      pending = f.validate();
      await Promise.race([
        entered,
        pending.then(() => {
          throw new Error(
            "The query returned before reaching its controlled hold",
          );
        }),
      ]);
      await change(f, kind);
      release();
      assert.equal(!!(await pending), accepted(kind));
    } finally {
      release();
      await pending;
      await f.cleanup();
    }
  });
}
test("template overlay paths and hashes require shared observed ownership", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.validate(new Set([alias]), new Map()), undefined);
    f.report.target_hashes[alias] = hash("saved contents");
    assert.equal(await f.validate(), undefined);
  } finally {
    await f.cleanup();
  }
});

test("ordinary declarations retain admitted observations and reject stale target hashes", async () => {
  const f = await fixture();
  try {
    assert.equal(f.observed.targets.size, 6);
    assert.equal(f.observed.aliases.size, 3);
    assert.equal(
      f.observed.targets.get(earlier)?.filename,
      join(f.root, earlier),
    );
    assert.equal(
      f.observed.targets.get(savedAlias),
      f.observed.aliases.get(savedAlias),
    );
    f.report.target_hashes[earlier] = hash("stale declaration");
    assert.equal(await f.validate(), undefined);
  } finally {
    await f.cleanup();
  }
});

for (const phase of [
  "later read",
  "after mapping",
  "primary probe",
  "final target read",
] as const) {
  for (const kind of [
    ...changes,
    "dependency generation",
    "query generation",
    "primary version",
    "primary contents",
    "root generation",
    "source generation",
    "cancelled",
  ] as const) {
    test(`actual template query ${kind} at ${phase} without a watcher notification`, async () => {
      const f = await fixture();
      const lane = new Scheduler();
      const folder = { uri: uri(f.root) };
      let generation = 0;
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      let enter!: () => void;
      const entered = new Promise<void>((done) => {
        enter = done;
      });
      let reads = 0,
        invoked = 0,
        joined = 0;
      if (phase === "later read")
        f.setRead(async (filename) => {
          // Two analysis observations precede the two mapped saved targets.
          if (filename === join(f.root, later) && ++reads === 4) {
            enter();
            await held;
          }
        });
      const module = {
        exports: {} as {
          EditorIntegration: typeof import("../../src/editor.ts").EditorIntegration;
        },
      };
      runInNewContext(queryBundle, {
        module,
        exports: module.exports,
        require: f.require,
        process,
        Buffer,
        AbortController,
        setTimeout,
        clearTimeout,
        api: {
          ...f.api,
          workspace: {
            ...f.api.workspace,
            isTrusted: true,
            getWorkspaceFolder: () => folder,
          },
          runProcess: async () => {
            invoked++;
            try {
              return JSON.stringify(f.report);
            } finally {
              joined++;
            }
          },
          validateNavigation: async (
            ...args: Parameters<typeof validateNavigation>
          ) => {
            const answer = await f.actualValidator(...args);
            if (phase === "final target read") {
              assert.ok(answer);
              f.setRead(async (filename) => {
                if (filename === join(f.root, later)) {
                  f.setRead(undefined);
                  enter();
                  await held;
                }
              });
            }
            if (phase === "primary probe") {
              assert.ok(answer);
              f.setResolve(async (filename) => {
                if (filename === f.original) {
                  f.setResolve(undefined);
                  enter();
                  await held;
                }
              });
            }
            if (phase === "after mapping") {
              assert.ok(answer);
              enter();
              await held;
            }
            return answer;
          },
        },
      });
      const editor = Object.assign(
        Object.create(module.exports.EditorIntegration.prototype),
        {
          disposed: false,
          executable: "controlled-query-wire",
          queryRevision: 0,
          closedTabs: new Set(),
          sourceOwners: new Map(),
          canonicalRoots: new Map(),
          documentFolders: new Map(),
          checking: new Map(),
          rootRevisions: new Map(),
          documentRevisions: new WeakMap(),
          nextRevision: 0,
          roots: { ready: async () => {}, get: () => f.root, watchSource() {} },
          dependencies: {
            begin: () => generation,
            revision: () => 0,
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
        token: unknown,
      ) => ReturnType<typeof f.validate>;
      let cancel: (() => void) | undefined;
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          cancel = listener;
          return { dispose() {} };
        },
      };
      let pending: ReturnType<typeof f.validate> | undefined;
      try {
        pending = Reflect.apply(query, editor, [
          f.document,
          new SnapshotIndex(text).span({ start: 11, end: 11 }).start,
          "references",
          token,
        ]) as ReturnType<typeof f.validate>;
        await Promise.race([
          entered,
          pending.then(() => {
            throw new Error(
              "The query returned before reaching its controlled hold",
            );
          }),
        ]);
        if (kind === "dependency generation") generation++;
        else if (kind === "query generation") editor.queryRevision++;
        else if (kind === "primary version") f.document.version++;
        else if (kind === "primary contents")
          f.document.getText = () => "changed primary";
        else if (kind === "root generation")
          editor.rootRevisions.set(
            folder.uri.toString(),
            editor.rootRevisions.get(folder.uri.toString()) + 1,
          );
        else if (kind === "source generation")
          editor.documentRevisions.set(f.document, 999);
        else if (kind === "cancelled") {
          assert.ok(cancel);
          cancel();
        } else await change(f, kind);
        assert.equal(
          await realpath(f.original),
          join(f.root, sourcePath),
          "the original primary spelling stays confined to its owner",
        );
        release();
        const answer = await pending;
        assert.equal(!!answer, accepted(kind));
        assert.equal(invoked, 1);
        assert.equal(
          joined,
          1,
          "the controlled wire invocation was joined before acceptance",
        );
        if (answer) {
          assert.equal(answer.locations.size, 8);
          assert.equal(answer.report.target_hashes[earlier], hash(earlierText));
          const declaration = answer.report.declarations[0];
          assert.equal(declaration.value.text, "42");
          assert.equal(declaration.comments[0].text, "# 😀é");
          assert.deepEqual(answer.locations.get(declaration.key)?.range.start, {
            line: 1,
            character: 0,
          });
          assert.deepEqual(
            answer.locations.get(declaration.comments[0])?.range.end,
            { line: 0, character: 5 },
          );
          assert.equal(
            answer.locations.get(declaration.key)?.uri.fsPath,
            join(f.root, earlier),
          );
          assert.equal(
            answer.locations.get(answer.report.locations[3])?.uri.fsPath,
            join(f.root, savedAlias),
          );
          const location = [...answer.locations.values()].find(
            (location) => location.uri.fsPath === f.original,
          );
          assert.ok(location);
          assert.deepEqual(location.range.start, { line: 1, character: 3 });
          assert.deepEqual(location.range.end, { line: 1, character: 8 });
        }
      } finally {
        release();
        await pending;
        lane.dispose();
        await f.cleanup();
      }
    });
  }
}
