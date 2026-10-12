import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import type * as vscode from "vscode";
import { gateFormatterSource } from "../host/formatter-source-gate.ts";
import {
  FixtureDocument,
  withNavigationFixture,
} from "../support/navigation-fixture.ts";
import { hash } from "../../src/protocol.ts";

function tokenSource() {
  const controller = new AbortController();
  return {
    cancel: () => controller.abort(),
    token: {
      get isCancellationRequested() {
        return controller.signal.aborted;
      },
      onCancellationRequested(listener: (event: unknown) => unknown) {
        const notify = () => {
          listener(undefined);
        };
        controller.signal.addEventListener("abort", notify);
        return {
          dispose: () => controller.signal.removeEventListener("abort", notify),
        };
      },
    } satisfies vscode.CancellationToken,
  };
}

test("actual registered formatter waits for its own injected source read and preserves stale model guards", async (context) => {
  for (const mode of ["canonical", "lint-fixes"] as const) {
    for (const state of [
      "stable",
      "closed",
      "changed version",
      "canceled",
    ] as const) {
      await context.test(`${mode}: ${state}`, async () => {
        let readSource: typeof readFile = readFile;
        let requests = 0;
        await withNavigationFixture(
          {
            readFile: ((...args: Parameters<typeof readFile>) =>
              readSource(...args)) as typeof readFile,
            runProcess: async (request) => {
              assert.equal(request.args[0], "format");
              requests++;
              const text = String(request.input);
              return JSON.stringify({
                schema_version: 1,
                path: relative(
                  request.cwd,
                  request.args[request.args.indexOf("--stdin-filename") + 1],
                ).replaceAll("\\", "/"),
                source_sha256: hash(text),
                status: "ready",
                edits: [
                  {
                    range: {
                      start: { line: 1, column: 1 },
                      end: { line: 1, column: 1 },
                    },
                    span: { start: 0, end: 0 },
                    text: "# formatted\n",
                  },
                ],
              });
            },
          },
          async ({
            document,
            editor,
            source,
            resources,
            refreshProviders,
            formatter,
          }) => {
            refreshProviders();
            assert.equal(
              formatter(),
              undefined,
              "unadmitted models have no formatter",
            );
            const gate = gateFormatterSource(document.uri, source);
            readSource = gate.readFile;
            resources.defer("source read gate", () => gate.dispose());
            let admitted!: () => void;
            const admission = new Promise<void>((resolve) => {
              admitted = resolve;
            });
            const listener = editor.onDidChangeEligibility(() => {
              if (editor.providerDocuments().includes(document.asDocument()))
                admitted();
            });
            resources.defer("formatter admission listener", () =>
              listener.dispose(),
            );
            editor.open(document.asDocument());
            await admission;
            refreshProviders();
            const provider = formatter();
            assert.ok(
              provider,
              "actual provider registration follows source admission",
            );
            const canceled = tokenSource();
            let settled = false;
            const pending = gate
              .invoke(document.asDocument(), () =>
                Promise.resolve(
                  mode === "canonical"
                    ? provider.provideDocumentFormattingEdits(
                        document.asDocument(),
                        { tabSize: 2, insertSpaces: true },
                        canceled.token,
                      )
                    : editor.format(
                        document.asDocument(),
                        mode,
                        canceled.token,
                      ),
                ),
              )
              .then((edits) => {
                settled = true;
                return edits;
              });
            try {
              await gate.entered;
              assert.equal(settled, false);
              assert.equal(gate.counts().invocations, 1);
              assert.equal(gate.counts().formatterEntries, 1);
              const before = gate.counts().automaticEntries;
              assert.equal(
                (await gate.readFile(source)).toString(),
                document.getText(),
              );
              assert.ok(gate.counts().automaticEntries > before);
              assert.equal(
                settled,
                false,
                "background reads cannot release a formatter",
              );
              if (state === "closed") document.isClosed = true;
              if (state === "changed version")
                document.edit(document.getText() + "# changed\n");
              if (state === "canceled") canceled.cancel();
              gate.release();
              const edits = await pending;
              assert.equal(edits?.length, state === "stable" ? 1 : 0);
              assert.equal(requests, state === "stable" ? 1 : 0);
              if (state === "stable") {
                await gate.dispose();
                const before = gate.counts();
                assert.equal(
                  (await editor.format(document.asDocument(), mode)).length,
                  1,
                );
                assert.deepEqual(
                  gate.counts(),
                  before,
                  "disposed observation no longer holds reads",
                );
              }
              document.isClosed = true;
              refreshProviders();
              assert.equal(
                formatter(),
                undefined,
                "closed models lose their actual registration",
              );
            } finally {
              gate.release();
              await pending;
              await gate.dispose();
            }
          },
          { acceptedOperations: ["format"] },
        );
      });
    }
  }
});

test("physical templates never register or submit writable formatting", async () => {
  let requests = 0;
  await withNavigationFixture(
    {
      runProcess: async () => {
        requests++;
        throw new Error("template formatting must never reach the backend");
      },
    },
    async ({ root, document, editor }) => {
      const source = join(root, "roles/source/templates/config.yaml");
      const text = document.getText();
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, text);
      const uri = {
        ...document.uri,
        fsPath: source,
        path: source,
        toString: () => `file://${source}`,
      } as vscode.Uri;
      const template = new FixtureDocument(uri, text).asDocument();
      for (const mode of ["canonical", "lint-fixes"] as const)
        assert.equal((await editor.format(template, mode)).length, 0);
      assert.equal(requests, 0);
      assert.equal(await readFile(source, "utf8"), text);
    },
    { acceptedOperations: ["format"] },
  );
});
