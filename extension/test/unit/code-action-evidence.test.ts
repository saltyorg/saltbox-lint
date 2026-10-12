import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { CodeActionEvidence } from "../support/code-action-evidence.ts";
import { withTestResources } from "../support/test-resources.ts";

class Channel<T> {
  readonly listeners = new Set<(value: T) => void>();
  setupFailure?: Error;
  disposalFailure?: Error;
  subscribe = (listener: (value: T) => void) => {
    if (this.setupFailure) throw this.setupFailure;
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (this.disposalFailure) throw this.disposalFailure;
      },
    };
  };
  emit(value: T) {
    for (const listener of this.listeners) listener(value);
  }
}
class Document {
  readonly uri;
  version = 1;
  languageId = "yaml";
  isClosed = false;
  isDirty = false;
  text: string;
  readFailure?: Error;
  constructor(filename: string, text: string) {
    this.uri = {
      scheme: "file",
      fsPath: filename,
      toString: () => pathToFileURL(filename).toString(),
    };
    this.text = text;
  }
  get lineCount() {
    return this.text.split("\n").length;
  }
  getText() {
    if (this.readFailure) throw this.readFailure;
    return this.text;
  }
}
const range = {
  start: { line: 0, character: 0 },
  end: { line: 3, character: 0 },
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "saltbox-action-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const yaml = new Document(join(root, "independent.yml"), "value: one\n");
  const markdown = new Document(join(root, "readme.md"), "one\n");
  markdown.languageId = "markdown";
  await writeFile(yaml.uri.fsPath, yaml.text);
  await writeFile(markdown.uri.fsPath, markdown.text);
  const changed = new Channel<{
    document: Document;
    contentChanges: readonly unknown[];
  }>();
  const opened = new Channel<Document>(),
    closed = new Channel<Document>();
  const diagnostics = new Channel<{ uris: readonly (typeof yaml.uri)[] }>();
  const lines: string[] = [];
  const sources = {
    changed: changed.subscribe,
    opened: opened.subscribe,
    closed: closed.subscribe,
    diagnosticsChanged: diagnostics.subscribe,
    write: (line: string) => {
      lines.push(line);
    },
  };
  const documents = [
    {
      label: "yaml",
      document: yaml,
      diagnostics: () => [
        { source: "saltbox-lint", code: "jinja-layout", range },
      ],
    },
    { label: "markdown", document: markdown, diagnostics: () => [] },
  ];
  const active = () =>
    [changed, opened, closed, diagnostics].reduce(
      (sum, channel) => sum + channel.listeners.size,
      0,
    );
  return {
    yaml,
    markdown,
    changed,
    opened,
    closed,
    diagnostics,
    sources,
    documents,
    lines,
    active,
  };
}

test("imported observer captures the actual single query interval and public model replacement without altering its result", async (t) => {
  const f = await fixture(t);
  const evidence = new CodeActionEvidence(f.documents, f.sources);
  t.after(() => evidence.dispose());
  const raw = [
    {
      title: "Fix All",
      kind: { value: "source.fixAll" },
      command: {
        command: "saltboxLint.fixAll",
        arguments: ["private argument"],
      },
      text: "private source",
      env: "private environment",
    },
  ];
  const query = evidence.begin("after-markdown", range);
  let calls = 0;
  const result = await (async () => {
    calls++;
    f.markdown.version++;
    f.markdown.text = "two\n";
    f.markdown.isDirty = true;
    f.changed.emit({ document: f.markdown, contentChanges: [{}] });
    const replacement = new Document(f.yaml.uri.fsPath, f.yaml.text);
    f.yaml.isClosed = true;
    f.closed.emit(f.yaml);
    f.opened.emit(replacement);
    return raw;
  })();
  evidence.returned(query, result, []);
  assert.equal(result, raw);
  assert.equal(calls, 1);
  assert.equal(f.lines.length, 0, "observations remain silent on success");
  const original = new Error("unrelated Markdown invalidated YAML actions");
  assert.throws(
    () => evidence.failure("after-markdown", original),
    (error) => error === original,
  );
  const parsed: unknown = JSON.parse(
    f.lines[0].slice("SALTBOX_I1_ACTION_FAILURE ".length),
  );
  assert.ok(
    parsed &&
      typeof parsed === "object" &&
      "queries" in parsed &&
      Array.isArray(parsed.queries) &&
      "events" in parsed &&
      Array.isArray(parsed.events),
  );
  assert.equal(parsed.queries.length, 1);
  assert.equal(parsed.events.length, 3);
  const queryRecord: unknown = parsed.queries[0];
  assert.ok(
    queryRecord &&
      typeof queryRecord === "object" &&
      "before" in queryRecord &&
      Array.isArray(queryRecord.before) &&
      "after" in queryRecord &&
      Array.isArray(queryRecord.after) &&
      "raw" in queryRecord &&
      queryRecord.raw &&
      typeof queryRecord.raw === "object" &&
      "count" in queryRecord.raw &&
      "filtered" in queryRecord &&
      queryRecord.filtered &&
      typeof queryRecord.filtered === "object" &&
      "count" in queryRecord.filtered,
  );
  assert.equal(queryRecord.raw.count, 1);
  assert.equal(queryRecord.filtered.count, 0);
  const beforeMarkdown: unknown = queryRecord.before[1],
    afterMarkdown: unknown = queryRecord.after[1];
  assert.ok(
    beforeMarkdown &&
      typeof beforeMarkdown === "object" &&
      "document" in beforeMarkdown &&
      beforeMarkdown.document &&
      typeof beforeMarkdown.document === "object" &&
      "version" in beforeMarkdown.document &&
      "textHash" in beforeMarkdown.document,
  );
  assert.ok(
    afterMarkdown &&
      typeof afterMarkdown === "object" &&
      "document" in afterMarkdown &&
      afterMarkdown.document &&
      typeof afterMarkdown.document === "object" &&
      "version" in afterMarkdown.document &&
      "textHash" in afterMarkdown.document &&
      "dirty" in afterMarkdown.document,
  );
  assert.equal(beforeMarkdown.document.version, 1);
  assert.equal(afterMarkdown.document.version, 2);
  assert.equal(afterMarkdown.document.dirty, true);
  assert.notEqual(
    beforeMarkdown.document.textHash,
    afterMarkdown.document.textHash,
  );
  const encoded = JSON.stringify(parsed);
  for (const secret of [
    "private argument",
    "private source",
    "private environment",
  ])
    assert.equal(encoded.includes(secret), false);
  assert.ok(encoded.includes('"sameModel":false'));
  evidence.dispose();
  assert.equal(f.active(), 0);
});

test("bounded event history retains last events and discloses omitted observations", async (t) => {
  const f = await fixture(t);
  const evidence = new CodeActionEvidence(f.documents, f.sources);
  t.after(() => evidence.dispose());
  for (let index = 0; index < 40; index++) {
    f.markdown.version++;
    f.changed.emit({ document: f.markdown, contentChanges: [] });
  }
  const original = new Error("assertion");
  assert.throws(
    () => evidence.failure("warm", original),
    (error) => error === original,
  );
  const parsed: unknown = JSON.parse(
    f.lines[0].slice("SALTBOX_I1_ACTION_FAILURE ".length),
  );
  assert.ok(
    parsed &&
      typeof parsed === "object" &&
      "events" in parsed &&
      Array.isArray(parsed.events) &&
      "droppedEvents" in parsed &&
      "eventCounts" in parsed &&
      parsed.eventCounts &&
      typeof parsed.eventCounts === "object" &&
      "change" in parsed.eventCounts,
  );
  assert.equal(parsed.events.length, 32);
  assert.equal(parsed.droppedEvents, 8);
  assert.equal(parsed.eventCounts.change, 40);
});

test("partial subscription setup rolls back acquired public listeners and retains setup plus release failures", async (t) => {
  const f = await fixture(t);
  const setup = new Error("open subscription failed"),
    cleanup = new Error("change release failed");
  f.opened.setupFailure = setup;
  f.changed.disposalFailure = cleanup;
  assert.throws(
    () => new CodeActionEvidence(f.documents, f.sources),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, setup);
      assert.deepEqual(error.errors, [setup, cleanup]);
      return true;
    },
  );
  assert.equal(f.active(), 0);
});

test("actual resource owner preserves assertion, snapshot and writer failures while removing every subscription", async (t) => {
  const f = await fixture(t);
  const original = new Error("original assertion"),
    snapshot = new Error("public snapshot failed"),
    writer = new Error("evidence output failed");
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 1000 }, async (owner) => {
      const evidence = new CodeActionEvidence(f.documents, {
        ...f.sources,
        write: () => {
          throw writer;
        },
      });
      owner.defer("action evidence", () => evidence.dispose());
      f.yaml.readFailure = snapshot;
      evidence.begin("after-markdown", range);
      evidence.failure("after-markdown", original);
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.cause, original);
      assert.deepEqual(error.cause.errors, [original, snapshot, writer]);
      return true;
    },
  );
  assert.equal(f.active(), 0);
});

test("independent listener disposal failures retain the original body error and attempt all releases once", async (t) => {
  const f = await fixture(t);
  const original = new Error("actual query rejected"),
    first = new Error("change cleanup"),
    second = new Error("close cleanup");
  f.changed.disposalFailure = first;
  f.closed.disposalFailure = second;
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 1000 }, async (owner) => {
      const evidence = new CodeActionEvidence(f.documents, f.sources);
      owner.defer("action evidence", () => evidence.dispose());
      throw original;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.ok(
        error.errors[1] &&
          typeof error.errors[1] === "object" &&
          "cause" in error.errors[1] &&
          error.errors[1].cause instanceof AggregateError,
      );
      assert.deepEqual(error.errors[1].cause.errors, [first, second]);
      return true;
    },
  );
  assert.equal(f.active(), 0);
});
