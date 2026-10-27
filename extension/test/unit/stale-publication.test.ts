import assert from "node:assert/strict";
import { test } from "node:test";
import { relative } from "node:path";
import type { ProcessRequest } from "../../src/process.ts";
import { hash } from "../../src/protocol.ts";
import {
  targetText,
  withNavigationFixture,
  type NavigationFixture,
} from "../support/navigation-fixture.ts";
import { fileClock, settleFiles } from "../support/file-clock.ts";

// VS Code tracks published markers through buffer edits. Re-setting a stale
// result after every keystroke would move its markers back to the old ranges.
function wire(request: ProcessRequest, f: NavigationFixture): string {
  if (request.args[0] === "--version") return "fixture backend\n";
  if (request.args[0] === "rules")
    return JSON.stringify({ schema_version: 1, rules: [] });
  assert.equal(request.args[0], "check");
  const slash = (filename: string) =>
    relative(f.root, filename).replaceAll("\\", "/");
  const source = slash(f.source),
    target = slash(f.target);
  if (request.input === undefined)
    // Saved scans are outside this contract; report no sources for them.
    return JSON.stringify({
      schema_version: 2,
      diagnostics: [],
      fixes: [],
      analysis: {
        schema_version: 1,
        root: f.root,
        generation: hash("generation"),
        complete: true,
        sources: [],
      },
    });
  assert.equal(
    slash(request.args[request.args.indexOf("--stdin-filename") + 1]),
    source,
  );
  const text = String(request.input);
  return JSON.stringify({
    schema_version: 2,
    diagnostics: [
      {
        path: source,
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        span: { start: 0, end: 1 },
        rule_id: "fixture-rule",
        severity: "error",
        message: "fixture finding",
        related: [
          {
            path: target,
            range: {
              start: { line: 1, column: 1 },
              end: { line: 1, column: 5 },
            },
            span: { start: 0, end: 4 },
            message: "related",
          },
        ],
      },
    ],
    fixes: [],
    analysis: {
      schema_version: 1,
      root: f.root,
      generation: hash("generation"),
      complete: true,
      sources: [
        {
          path: source,
          source_sha256: hash(text),
          files: [
            { path: source, sha256: hash(text), state: "read" },
            { path: target, sha256: hash(targetText), state: "read" },
          ],
          identity: [],
          discovery: [],
          directories: [],
        },
      ],
    },
  });
}

const operations = { acceptedOperations: ["check", "--version", "rules"] };

test(
  "edits keep a stale result's published markers instead of re-setting old ranges",
  { timeout: 60000 },
  async () => {
    const timer = fileClock();
    let fixture!: NavigationFixture;
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        runProcess: async (request) => wire(request, fixture),
      },
      async (f) => {
        fixture = f;
        await settleFiles(f.editor, timer);
        const document = f.document;
        const key = document.uri.toString();
        await f.editor.check(document.asDocument(), true);
        await settleFiles(f.editor, timer);
        const published = f.diagnostics.get(key);
        assert.equal(published?.length, 1);
        assert.equal(published[0].relatedInformation?.length, 1);
        assert.equal(f.editor.status(document.asDocument()).state, "current");
        const writes = () =>
          f.diagnosticWrites.filter((write) => write === `set ${key}`).length;

        // The first edit removes saved related coordinates, a real change.
        const original = document.getText();
        document.edit(`# 1\n${original}`);
        f.editor.change(document.asDocument());
        const afterFirst = writes();
        assert.equal(
          f.diagnostics.get(key)?.[0].relatedInformation,
          undefined,
          "related locations into edited context are withdrawn",
        );

        // Further keystrokes leave the editor-tracked stale markers alone.
        for (let index = 2; index <= 4; index++) {
          document.edit(`# ${index}\n${document.getText()}`);
          f.editor.change(document.asDocument());
        }
        assert.equal(writes(), afterFirst, "no stale result is re-set");
        assert.equal(f.diagnostics.get(key)?.length, 1, "markers remain");
        assert.equal(f.editor.status(document.asDocument()).state, "stale");
        await settleFiles(f.editor, timer);

        // A fresh result is still published normally.
        const before = writes();
        await f.editor.check(document.asDocument(), true);
        await settleFiles(f.editor, timer);
        assert.equal(writes(), before + 1);
        assert.equal(f.editor.status(document.asDocument()).state, "current");
      },
      operations,
    );
  },
);
