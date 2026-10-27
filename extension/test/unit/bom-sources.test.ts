import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type * as vscode from "vscode";
import type { ProcessRequest } from "../../src/process.ts";
import type { AnalysisRecord, Finding } from "../../src/protocol.ts";
import { hash } from "../../src/protocol.ts";
import {
  fixtureUri,
  withNavigationFixture,
  type NavigationFixture,
} from "../support/navigation-fixture.ts";

// VS Code decodes a UTF-8 BOM as encoding metadata: the document model never
// contains it and saving the clean model writes it back. The Go CLI analyzes raw
// bytes, so its line-1 columns and byte spans include the BOM's code point.
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const token = "port";

function clock() {
  const timers: { perform(): void; active: boolean }[] = [];
  return {
    schedule(perform: () => void, milliseconds: number) {
      assert.equal(milliseconds, 100);
      const timer = { perform, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    deliver() {
      const pending = timers.filter((timer) => timer.active);
      for (const timer of pending) {
        timer.active = false;
        timer.perform();
      }
      return pending.length;
    },
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Deliver admitted timers until the editor's owned work is quiescent. */
async function settle(
  f: NavigationFixture,
  timer: ReturnType<typeof clock>,
): Promise<void> {
  let joined = false;
  const pending = f.editor.join().then(() => {
    joined = true;
  });
  for (let round = 0; round < 2000 && !joined; round++) {
    timer.deliver();
    await turn();
  }
  if (!joined) {
    // Fixture disposal seals producers; the join is still owned by that cleanup.
    pending.catch(() => undefined);
    assert.fail("background file work did not become quiescent");
  }
  await pending;
}

/** Report the first token with the CLI's raw-byte rune columns and spans. */
function finding(path: string, bytes: Uint8Array): Finding[] {
  const text = Buffer.from(bytes).toString("utf8");
  const offset = text.indexOf(token);
  if (offset < 0) return [];
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = [...before.slice(before.lastIndexOf("\n") + 1)].length + 1;
  const start = Buffer.byteLength(before);
  return [
    {
      path,
      range: {
        start: { line, column },
        end: { line, column: column + token.length },
      },
      span: { start, end: start + token.length },
      rule_id: "fixture-rule",
      severity: "error",
      message: "fixture finding",
    },
  ];
}

async function wire(
  request: ProcessRequest,
  f: NavigationFixture,
  closed: readonly string[],
): Promise<string> {
  if (request.args[0] === "--version") return "fixture backend\n";
  if (request.args[0] === "rules")
    return JSON.stringify({ schema_version: 1, rules: [] });
  assert.equal(request.args[0], "check");
  const slash = (filename: string) =>
    relative(f.root, filename).replaceAll("\\", "/");
  const known = [f.source, f.target, ...closed].map(slash);
  const selected =
    request.input !== undefined
      ? [slash(request.args[request.args.indexOf("--stdin-filename") + 1])]
      : request.args.slice(request.args.indexOf("--") + 1);
  const paths = selected.includes(".") ? known : selected;
  const sources: AnalysisRecord["sources"] = [];
  const diagnostics: Finding[] = [];
  for (const path of paths) {
    const bytes =
      request.input !== undefined
        ? Buffer.from(request.input)
        : await readFile(join(f.root, ...path.split("/")));
    sources.push({
      path,
      source_sha256: hash(bytes),
      files: [{ path, sha256: hash(bytes), state: "read" }],
      identity: [],
      discovery: [],
      directories: [],
    });
    diagnostics.push(...finding(path, bytes));
  }
  return JSON.stringify({
    schema_version: 2,
    diagnostics,
    fixes: [],
    analysis: {
      schema_version: 1,
      root: f.root,
      generation: hash("generation"),
      complete: true,
      sources,
    },
  });
}

const operations = { acceptedOperations: ["check", "--version", "rules"] };

function start(diagnostics: readonly vscode.Diagnostic[] | undefined) {
  assert.equal(diagnostics?.length, 1);
  const { line, character } = diagnostics[0].range.start;
  const end = diagnostics[0].range.end;
  return { line, character, endLine: end.line, endCharacter: end.character };
}

test(
  "saved BOM document is rechecked against its BOM-less editor model",
  { timeout: 60000 },
  async () => {
    const timer = clock();
    const requests: ProcessRequest[] = [];
    let fixture!: NavigationFixture;
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        runProcess: async (request) => {
          requests.push(request);
          return wire(request, fixture, []);
        },
      },
      async (f) => {
        fixture = f;
        await settle(f, timer);
        const document = f.targetDocument;
        const text = document.getText();
        assert.equal(text.startsWith("\uFEFF"), false);
        // Saving the clean model writes VS Code's encoding BOM back to disk.
        await writeFile(f.target, Buffer.concat([bom, Buffer.from(text)]));
        const before = requests.length;
        f.editor.saved(document.asDocument());
        await settle(f, timer);
        const checks = requests
          .slice(before)
          .filter((request) => request.args[0] === "check");
        assert.ok(checks.length > 0, "the saved BOM source is rechecked");
        assert.ok(
          checks.length <= 2,
          `a stable BOM source settles without re-queueing (${checks.length} checks)`,
        );
        assert.equal(
          f.editor.status(document.asDocument()).state,
          "current",
          "the saved BOM source has a current result",
        );
        const expected = text.indexOf(token);
        assert.deepEqual(start(f.diagnostics.get(document.uri.toString())), {
          line: 0,
          character: expected,
          endLine: 0,
          endCharacter: expected + token.length,
        });
      },
      operations,
    );
  },
);

test(
  "clean open BOM document analyzes its saved bytes and stays current",
  { timeout: 60000 },
  async () => {
    const timer = clock();
    const requests: ProcessRequest[] = [];
    let fixture!: NavigationFixture;
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        runProcess: async (request) => {
          requests.push(request);
          return wire(request, fixture, []);
        },
      },
      async (f) => {
        fixture = f;
        await settle(f, timer);
        const document = f.targetDocument;
        const text = document.getText();
        const saved = Buffer.concat([bom, Buffer.from(text)]);
        await writeFile(f.target, saved);
        const before = requests.length;
        await f.editor.check(document.asDocument(), true);
        await settle(f, timer);
        const checks = requests
          .slice(before)
          .filter((request) => request.args[0] === "check");
        assert.equal(checks.length, 1, "no observation retry is queued");
        assert.deepEqual(
          Buffer.from(checks[0].input ?? ""),
          saved,
          "the CLI receives the exact saved bytes",
        );
        assert.equal(f.editor.status(document.asDocument()).state, "current");
        const expected = text.indexOf(token);
        assert.deepEqual(start(f.diagnostics.get(document.uri.toString())), {
          line: 0,
          character: expected,
          endLine: 0,
          endCharacter: expected + token.length,
        });
        // A dirty model is still analyzed as the editor's own BOM-less text.
        document.edit(`${text}# edit\n`);
        f.editor.change(document.asDocument());
        await f.editor.check(document.asDocument(), true);
        await settle(f, timer);
        const dirty = requests.at(-1)!;
        assert.equal(dirty.input, document.getText());
      },
      operations,
    );
  },
);

test(
  "unopened BOM file diagnostics use BOM-less editor columns on line one",
  { timeout: 60000 },
  async () => {
    const timer = clock();
    let fixture!: NavigationFixture;
    let closed = "";
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        runProcess: async (request) => wire(request, fixture, [closed]),
      },
      async (f) => {
        fixture = f;
        closed = join(f.root, "roles/closed/defaults/main.yml");
        await mkdir(dirname(closed), { recursive: true });
        const text = "closed_role_port: 1\nclosed_role_name: x\n";
        await writeFile(closed, Buffer.concat([bom, Buffer.from(text)]));
        await settle(f, timer);
        await f.editor.checkWorkspace();
        await settle(f, timer);
        const expected = text.indexOf(token);
        assert.deepEqual(
          start(f.diagnostics.get(fixtureUri(closed).toString())),
          {
            line: 0,
            character: expected,
            endLine: 0,
            endCharacter: expected + token.length,
          },
        );
      },
      operations,
    );
  },
);
