import assert from "node:assert/strict";
import { test } from "node:test";
import { Dependencies } from "../../src/dependencies.ts";
import {
  hash,
  parseCheck,
  type AnalysisRecord,
  type SourceDependencies,
} from "../../src/protocol.ts";

const source = (role: string): SourceDependencies => ({
  path: `roles/${role}/tasks/main.yml`,
  source_sha256: hash("[]\n"),
  identity: [],
  discovery: [],
  files: [
    {
      path: `roles/${role}/tasks/main.yml`,
      sha256: hash("[]\n"),
      state: "read",
    },
    { path: `roles/${role}/templates/missing.conf`, state: "missing" },
  ],
  directories: [
    { path: `roles/${role}/templates`, state: "directory", members: [] },
  ],
});
const report = (...sources: SourceDependencies[]): AnalysisRecord => ({
  schema_version: 1,
  root: "/project",
  generation: hash("generation"),
  complete: true,
  sources,
});

test("dependency lifecycle observes clean files, missing creations, directories and deletions within owning roots", () => {
  const graph = new Dependencies();
  const a = source("a"),
    b = source("b");
  assert.equal(graph.accept("one", report(a, b), graph.begin(), true), true);
  assert.equal(graph.accept("two", report(a), graph.begin(), true), true);
  for (const file of [
    "roles/a/templates/missing.conf",
    "roles/a/templates/new.txt",
    "roles/a/templates/nested/new.conf",
    "roles/a/templates",
  ]) {
    const before = graph.revision("one", a.path);
    assert.deepEqual([...graph.event("one", "/project", file)!!], [a.path])!;
    assert.ok(graph.revision("one", a.path) > before);
    assert.equal(graph.revision("one", b.path), 0);
    assert.equal(graph.revision("two", a.path), 0);
  }
  assert.deepEqual(
    [...graph.event("one", "/project", "roles/a-extra/templates/new")!!],
    [],
  );
  assert.deepEqual(
    [...graph.event("one", "/another", "roles/a/templates/new")!!],
    [],
  );
});
test("late dependency events reject scans even before the first graph exists", () => {
  const graph = new Dependencies();
  const token = graph.begin();
  graph.event("one", "/project", "roles/a/templates/late.txt");
  assert.equal(graph.accept("one", report(source("a")), token, true), false);
  assert.equal(
    graph.accept("one", report(source("a")), graph.begin(), true),
    true,
  );
  const next = graph.begin();
  graph.event("one", "/project", "roles/b/templates/other.txt");
  assert.equal(graph.accept("one", report(source("a")), next, false), true);
});
test("partial replacement removes old reverse dependencies and full scans retain event revisions", () => {
  const graph = new Dependencies(),
    a = source("a"),
    b = source("b");
  graph.accept("one", report(a, b), graph.begin(), true);
  graph.event("one", "/project", "roles/a/templates/bad");
  const revision = graph.revision("one", a.path);
  graph.accept("one", report(a, b), graph.begin(), true);
  assert.equal(graph.revision("one", a.path), revision);
  const local = { ...a, files: [a.files[0]], directories: [] };
  graph.accept("one", report(local), graph.begin(), false);
  assert.deepEqual(
    [...graph.event("one", "/project", "roles/a/templates/bad")!!],
    [],
  );
  assert.deepEqual(
    [...graph.event("one", "/project", "roles/b/templates/bad")!!],
    [b.path],
  );
  graph.remove("one", b.path);
  assert.deepEqual(
    [...graph.event("one", "/project", "roles/b/templates/bad")!!],
    [],
  );
  graph.remove("one");
  assert.equal(graph.revision("one", a.path), 0);
  graph.clear();
});
test("bounded event history rejects tokens whose observations can no longer be proved current", () => {
  const graph = new Dependencies(),
    token = graph.begin();
  for (let i = 0; i < 4100; i++) graph.event("one", "/project", `other/${i}`);
  assert.equal(graph.accept("one", report(source("a")), token, true), false);
  assert.equal(
    graph.accept("one", report(source("a")), graph.begin(), true),
    true,
  );
});
test("analysis wire validates identities, hashes, completeness, membership and optional compatibility", () => {
  const wire = (analysis: unknown) =>
    JSON.stringify({ schema_version: 2, diagnostics: [], fixes: [], analysis });
  assert.deepEqual(
    parseCheck('{"schema_version":2,"diagnostics":[],"fixes":[]}'),
    { diagnostics: [], fixes: new Map() },
  );
  assert.throws(() =>
    parseCheck('{"schema_version":2,"diagnostics":[],"fixes":[]}', true),
  );
  assert.equal(
    parseCheck(wire(report(source("a"))), true).analysis!.sources.length,
    1,
  );
  const valid = report(source("a"));
  for (const invalid of [
    { ...valid, schema_version: 2 },
    { ...valid, complete: false },
    { ...valid, root: "relative" },
    { ...valid, generation: "bad" },
    { ...valid, sources: [] },
    { ...valid, sources: [source("a"), source("a")] },
    { ...valid, sources: [{ ...source("a"), path: "../out" }] },
    { ...valid, sources: [{ ...source("a"), source_sha256: hash("wrong") }] },
    {
      ...valid,
      sources: [
        {
          ...source("a"),
          files: [{ path: source("a").path, state: "missing" }],
        },
      ],
    },
    {
      ...valid,
      sources: [
        {
          ...source("a"),
          directories: [
            { path: "roles/a/templates", members: ["outside.txt"] },
          ],
        },
      ],
    },
    {
      ...valid,
      sources: [
        {
          ...source("a"),
          files: [
            ...source("a").files,
            {
              path: "roles/a/templates/read.txt",
              state: "read",
              sha256: hash("read"),
            },
          ],
        },
      ],
    },
  ])
    assert.throws(() => parseCheck(wire(invalid), true));
});

test("full coverage retains explicitly checked ignored buffer dependencies", () => {
  const graph = new Dependencies(),
    a = source("a"),
    b = source("b");
  graph.accept("one", report(a, b), graph.begin(), true);
  graph.accept("one", report(a), graph.begin(), true, [b.path]);
  assert.deepEqual(
    [...graph.event("one", "/project", "roles/b/templates/new")!],
    [b.path],
  );
});
test("watcher echoes coalesce by file identity while atomic replacements invalidate", () => {
  const graph = new Dependencies(),
    a = source("a");
  graph.accept("one", report(a), graph.begin(), true);
  const first = graph.event(
    "one",
    "/project",
    "roles/a/templates/file",
    "inode1:mtime1",
  )!;
  assert.equal(first.size, 1);
  const revision = graph.revision("one", a.path);
  assert.equal(
    graph.event("one", "/project", "roles/a/templates/file", "inode1:mtime1"),
    undefined,
  );
  assert.equal(graph.revision("one", a.path), revision);
  assert.equal(
    graph.event("one", "/project", "roles/a/templates/file", "inode2:mtime1")!
      .size,
    1,
  );
});

test("ancestor ignore controls invalidate membership without crossing sibling roles", () => {
  const graph = new Dependencies(),
    a = source("a"),
    b = source("b");
  graph.accept("one", report(a, b), graph.begin(), true);
  assert.deepEqual(
    [...graph.event("one", "/project", "roles/a/.gitignore")!],
    [a.path],
  );
  assert.deepEqual(
    [...graph.event("one", "/project", "roles/.gitignore")!],
    [a.path, b.path],
  );
});

test("logical admission revisions revoke old selected batches and ignore unchanged control echoes", () => {
  const graph = new Dependencies(),
    a = source("a");
  graph.accept("one", report(a), graph.begin(), true);
  const before = graph.admissionRevision("one");
  graph.event("one", "/project", "roles/a/.gitignore", "new");
  assert.ok(graph.admissionRevision("one") > before);
  const current = graph.admissionRevision("one");
  graph.event("one", "/project", "roles/a/.gitignore", "new");
  assert.equal(graph.admissionRevision("one"), current);
  graph.event("one", "/project", "roles/a/templates/changed", "bytes");
  assert.equal(graph.admissionRevision("one"), current);
});
