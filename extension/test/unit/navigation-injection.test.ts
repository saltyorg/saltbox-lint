import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import type { CancellationToken } from "vscode";
import {
  withNavigationFixture,
  targetText,
} from "../support/navigation-fixture.ts";
import type { ProcessRequest } from "../../src/process.ts";

const noCancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as CancellationToken;

test("navigation adapters isolate backend failures and fixed manual notices by instance", async () => {
  const payload = "PRIVATE_CHILD_RESPONSE_VARIABLE_1234";
  let calls = 0;
  await withNavigationFixture(
    {
      runProcess: async (request) => {
        if (request.args[0] !== "query")
          throw new Error("unexpected background operation");
        calls++;
        throw new Error(payload);
      },
    },
    async (f) => {
      assert.equal(
        (
          await f.editor.navigation.definition(
            f.document.asDocument(),
            f.position,
            noCancellation,
          )
        ).length,
        0,
      );
      assert.equal(calls, 1);
      assert.equal(f.notices.length, 0);
      assert.equal(
        f.lines.some((line) => line.includes(payload)),
        false,
      );
      assert.equal(await f.editor.navigation.impact(), undefined);
      assert.equal(calls, 2);
      const message =
        "Static role lookup impact failed. Check the bundled CLI and try again.";
      assert.deepEqual(f.notices, ["Saltbox Lint: " + message]);
      assert.equal(f.lines.filter((line) => line === message).length, 1);
      assert.equal(
        f.lines.some((line) => line.includes(payload)),
        false,
      );
    },
  );
  let wire!: (request: ProcessRequest) => string;
  await withNavigationFixture(
    { runProcess: async (request) => wire(request) },
    async (f) => {
      wire = f.wire;
      const locations = await f.editor.navigation.definition(
        f.document.asDocument(),
        f.position,
        noCancellation,
      );
      assert.equal(
        locations.length,
        1,
        "another instance retains its independent successful backend",
      );
      assert.equal(locations[0].uri.fsPath, f.target);
      assert.equal(f.notices.length, 0);
    },
  );
});

test("target validation owns its read and rejects a context event during response acceptance", async () => {
  let wire!: (request: ProcessRequest) => string;
  let contextRead!: (filename: string) => Promise<Buffer>;
  let reads = 0;
  await withNavigationFixture(
    {
      runProcess: async (request) => wire(request),
      navigation: {
        readFile: ((filename: string) =>
          contextRead(filename)) as typeof readFile,
      },
    },
    async (f) => {
      wire = f.wire;
      contextRead = async (filename) => {
        const bytes = await readFile(filename);
        if (filename === f.target && reads++ === 0) {
          await writeFile(f.target, targetText + "# changed query context\n");
          f.editor.refresh([f.targetDocument.uri]);
        }
        return bytes;
      };
      assert.equal(
        (
          await f.editor.navigation.definition(
            f.document.asDocument(),
            f.position,
            noCancellation,
          )
        ).length,
        0,
      );
      assert.equal(
        reads,
        1,
        "the actual validator read owns the controlled interleaving",
      );
      assert.equal(
        (await readFile(f.target, "utf8")).endsWith(
          "# changed query context\n",
        ),
        true,
      );
    },
  );
});

test("an accepted response precedes a dirty target edit and a fresh response refuses that target", async () => {
  let wire!: (request: ProcessRequest) => string;
  await withNavigationFixture(
    { runProcess: async (request) => wire(request) },
    async (f) => {
      wire = f.wire;
      const accepted = await f.editor.navigation.definition(
        f.document.asDocument(),
        f.position,
        noCancellation,
      );
      assert.equal(accepted.length, 1);
      f.targetDocument.edit(targetText + "# dirty after response\n");
      f.editor.change(f.targetDocument.asDocument());
      assert.equal(
        accepted.length,
        1,
        "an already returned response is not mutated by a later edit",
      );
      assert.equal(
        (
          await f.editor.navigation.definition(
            f.document.asDocument(),
            f.position,
            noCancellation,
          )
        ).length,
        0,
      );
      assert.equal(
        await readFile(f.target, "utf8"),
        targetText,
        "dirty-buffer checks never rewrite saved context",
      );
    },
  );
});

test("manual dynamic context and dirty-target refusal remain quiet after an operational failure control", async () => {
  let wire!: (request: ProcessRequest) => string;
  let dynamic = true;
  await withNavigationFixture(
    {
      runProcess: async (request) => {
        const report: unknown = JSON.parse(wire(request));
        if (dynamic && report && typeof report === "object")
          Object.assign(report, {
            state: "dynamic",
            reasons: ["dynamic-suffix"],
            locations: [],
            declarations: [],
          });
        return JSON.stringify(report);
      },
    },
    async (f) => {
      wire = f.wire;
      assert.equal((await f.editor.navigation.impact())?.state, "dynamic");
      assert.deepEqual(f.notices, []);
      dynamic = false;
      f.targetDocument.edit(targetText + "# dirty manual target\n");
      assert.equal(await f.editor.navigation.impact(), undefined);
      assert.deepEqual(f.notices, []);
      assert.equal(
        f.lines.some((line) =>
          line.startsWith("Static role lookup impact failed."),
        ),
        false,
      );
    },
  );
});
