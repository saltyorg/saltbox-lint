import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { ProcessRequest } from "../../src/process.ts";
import { hash } from "../../src/protocol.ts";
import {
  deferred,
  withNavigationFixture,
  sourceText,
} from "../support/navigation-fixture.ts";

async function wire(request: ProcessRequest): Promise<string> {
  const at = request.args.indexOf("--stdin-filename");
  const files =
    at < 0
      ? ["roles/source/tasks/main.yml", "roles/target/defaults/main.yml"]
      : [relative(request.cwd, request.args[at + 1]).replaceAll("\\", "/")];
  const sources = await Promise.all(
    files.map(async (path) => {
      const text =
        at < 0
          ? await readFile(join(request.cwd, path), "utf8")
          : String(request.input);
      const source_sha256 = hash(text);
      return {
        path,
        source_sha256,
        files: [{ path, sha256: source_sha256, state: "read" }],
        directories: [],
        identity: [],
        discovery: [],
      };
    }),
  );
  return JSON.stringify({
    schema_version: 2,
    diagnostics: [],
    fixes: [],
    analysis: {
      schema_version: 1,
      root: request.cwd,
      generation: hash(JSON.stringify(sources)),
      complete: true,
      sources,
    },
  });
}

for (const invalidation of [
  "none",
  "edit",
  "version",
  "close",
  "root",
  "dispose",
] as const) {
  test(`actual constructor queues without source copies and ${invalidation} preserves its lifecycle contract`, async () => {
    const entered = deferred<void>(),
      gate = deferred<void>();
    const queued = deferred<void>();
    const invocations: ProcessRequest[] = [];
    let hold = false;
    let target = "";
    await withNavigationFixture(
      {
        runProcess: async (request, signal) => {
          if (request.args[0] !== "check")
            throw new Error("No rule-help backend in this component fixture");
          invocations.push(request);
          const at = request.args.indexOf("--stdin-filename");
          if (hold && at >= 0 && request.args[at + 1] === target) {
            entered.resolve();
            let released!: Promise<void>;
            const waiting = new Promise<void>((resolve, reject) => {
              const aborted = () => {
                gate.resolve();
                reject(new Error("Canceled"));
              };
              signal.addEventListener("abort", aborted, { once: true });
              released = gate.promise.then(() => {
                signal.removeEventListener("abort", aborted);
                resolve();
              });
              if (signal.aborted) aborted();
            });
            try {
              await waiting;
            } finally {
              await released;
            }
          }
          return wire(request);
        },
      },
      async ({
        editor,
        document,
        targetDocument,
        target: holder,
        source,
        resources,
        focus,
        removeWorkspace,
      }) => {
        await editor.join();
        target = holder;
        hold = true;
        const active = resources.operation("held component check", (signal) =>
          editor.check(
            targetDocument.asDocument(),
            false,
            undefined,
            false,
            signal,
          ),
        );
        await entered.promise;
        focus(document);
        document.reads = 0;
        const before = invocations.length;
        const admitted = deferred<void>();
        const listener = editor.onDidChangeEligibility(() => {
          if (editor.providerDocuments().includes(document.asDocument()))
            admitted.resolve();
        });
        resources.defer("queue admission observer", () => listener.dispose());
        const pending = resources.operation(
          "queued component check",
          async (signal) => {
            await editor.check(
              document.asDocument(),
              false,
              undefined,
              false,
              signal,
            );
            queued.resolve();
          },
        );
        try {
          await admitted.promise;
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(editor.status(document.asDocument()).state, "checking");
          assert.equal(
            editor.status().state,
            "checking",
            "the actual active model shares queued ownership",
          );
          assert.equal(
            document.reads,
            0,
            "enqueue and active pending status do not copy source text",
          );
          focus(targetDocument);
          if (invalidation === "edit" || invalidation === "version") {
            document.edit("# changed\n" + sourceText);
            if (invalidation === "edit") editor.change(document.asDocument());
          } else if (invalidation === "close") {
            document.isClosed = true;
            editor.close(document.asDocument());
          } else if (invalidation === "root") removeWorkspace();
          else if (invalidation === "dispose") editor.dispose();
          if (!["none", "version"].includes(invalidation)) await queued.promise;
          gate.resolve();
          await Promise.all([active, pending]);
          const selected = invocations
            .slice(before)
            .filter((request) => request.args.includes(source));
          if (invalidation === "none") {
            assert.equal(selected.length, 1);
            assert.ok(
              document.reads > 0,
              "current queued work captures its source when its turn starts",
            );
            assert.equal(selected[0].input, document.getText());
            assert.equal(editor.status(document.asDocument()).state, "current");
          } else {
            assert.deepEqual(selected, []);
            assert.equal(
              document.reads,
              0,
              "invalid queued work does not copy its source before declining",
            );
          }
        } finally {
          gate.resolve();
          await Promise.all([active, pending]);
        }
      },
      { acceptedOperations: ["check"] },
    );
  });
}
