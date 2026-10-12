import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { OutputChannel } from "vscode";
import type { ProcessRequest } from "../../src/process.ts";
import { checkWire } from "../support/check-wire.ts";
import {
  deferred,
  withNavigationFixture,
  fixtureUri,
  type NavigationFixture,
} from "../support/navigation-fixture.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("an unknown queued source owns public status without copying text and deduplicates through actual admission", async () => {
  const entered = deferred<void>(),
    release = deferred<void>(),
    checking = deferred<void>();
  let fixture!: NavigationFixture;
  let reads = 0;
  const requests: ProcessRequest[] = [];
  const output: OutputChannel = {
    name: "fixture",
    append() {},
    appendLine() {},
    replace() {},
    clear() {},
    show() {},
    hide() {},
    dispose() {},
  };
  await withNavigationFixture(
    {
      schedule: () => () => {},
      createOutputChannel: () => output,
      createStatusBarItem: () => ({
        name: "fixture",
        alignment: 1,
        priority: 0,
        id: "fixture",
        command: undefined,
        get text() {
          return "";
        },
        set text(value: string) {
          if (value === "Saltbox Lint: checking") checking.resolve();
        },
        tooltip: undefined,
        color: undefined,
        backgroundColor: undefined,
        accessibilityInformation: undefined,
        show() {},
        hide() {},
        dispose() {},
      }),
      runProcess: async (request) => {
        requests.push(request);
        if (request.args.includes(fixture.target)) {
          entered.resolve();
          await release.promise;
        }
        return checkWire(request, fixture);
      },
    },
    async (f) => {
      fixture = f;
      const original = f.document.getText.bind(f.document);
      f.document.getText = () => {
        reads++;
        return original();
      };
      const blocker = f.resources.operation("blocker", () =>
        f.editor.check(f.targetDocument.asDocument()),
      );
      await entered.promise;
      const pending = f.resources.operation("unknown queued source", () =>
        f.editor.check(f.document.asDocument()),
      );
      try {
        await checking.promise;
        assert.equal(f.editor.status().state, "checking");
        assert.equal((await f.editor.showStatus()).state, "checking");
        assert.ok(
          f.editor.providerDocuments().includes(f.document.asDocument()),
        );
        assert.equal(reads, 0);
        const context = join(f.root, "unrelated.yml");
        await writeFile(context, "value: changed\n");
        f.editor.removeFile(fixtureUri(context));
        assert.equal(f.editor.status().state, "checking");
        assert.equal((await f.editor.showStatus()).state, "checking");
        assert.equal(reads, 0);
        const duplicate = f.resources.operation("duplicate queued source", () =>
          f.editor.check(f.document.asDocument()),
        );
        await turn();
        assert.equal(
          requests.filter((request) => request.args.includes(f.source)).length,
          0,
        );
        release.resolve();
        await Promise.all([blocker, pending, duplicate]);
        assert.ok(
          reads > 0,
          "source copying starts after the lane releases its predecessor",
        );
        assert.equal(
          requests.filter((request) => request.args.includes(f.source)).length,
          1,
        );
      } finally {
        release.resolve();
        await Promise.all([blocker, pending]);
      }
    },
    { acceptedOperations: ["check", "--version", "rules"] },
  );
});
