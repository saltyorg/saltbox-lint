import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type * as vscode from "vscode";
import type {
  EditorIntegration,
  WritableStageCollector,
} from "../../src/editor.ts";
import { hash } from "../../src/protocol.ts";
import { collectWritableOwnershipStages } from "../host/writable-ownership-failure.ts";
const bundle = await build({
  stdin: {
    contents: 'export { EditorIntegration } from "./src/editor.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "writable-stage-controls",
      setup(builder) {
        builder.onResolve(
          { filter: /^vscode$|^\.\/process\.ts$/ },
          ({ path }) => ({ path, namespace: "control" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "control" }, ({ path }) => ({
          contents:
            path === "vscode"
              ? "module.exports = globalThis.api"
              : "exports.runProcess = globalThis.operation",
          loader: "js",
        }));
      },
    },
  ],
});
const primary = new Error("original operation failure");
const text = "a: 1\n";
const cases = [
  "accepted",
  "fixall-document",
  "fixall-folder",
  "format-preflight",
  "snapshot-admission",
  "disk-utf8",
  "before-submission",
  "after-submission",
  "operation-failed",
  "parser-failed",
  "format-result-authority",
  "format-return-authority",
  "fixall-result",
  "fixall-write-authority",
  "root-failed",
  "operation-cancelled",
] as const;
type Scenario = (typeof cases)[number];
async function invoke(scenario: Scenario, collect?: WritableStageCollector) {
  const operations: string[] = [];
  const errors: unknown[] = [];
  let version = 1,
    currentChecks = 0,
    authorityChecks = 0;
  let cancel: (() => void) | undefined;
  const document = {
    uri: { toString: () => "private-uri" },
    get version() {
      operations.push("version");
      return version;
    },
    getText() {
      operations.push("text");
      return text;
    },
    isDirty: scenario !== "disk-utf8",
  } as vscode.TextDocument;
  const module = {
    exports: {} as { EditorIntegration: typeof EditorIntegration },
  };
  const snapshot = {
    path: "source.yml",
    filename: "private-file",
    root: "private-root",
    text,
  };
  const operation = async () => {
    operations.push("operation");
    if (scenario === "operation-failed") throw primary;
    if (scenario === "fixall-result") version++;
    if (scenario === "operation-cancelled") cancel?.();
    return scenario === "parser-failed"
      ? "invalid private response"
      : JSON.stringify({
          schema_version: 1,
          path: snapshot.path,
          source_sha256: hash(text),
          status: "ready",
          edits: [
            {
              range: {
                start: { line: 1, column: 4 },
                end: { line: 1, column: 5 },
              },
              span: { start: 3, end: 4 },
              text: "2",
            },
          ],
        });
  };
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) =>
      name === "node:fs/promises"
        ? {
            readFile: async () => {
              operations.push("read");
              return Buffer.from([255]);
            },
          }
        : require(name),
    Buffer,
    process,
    AbortController,
    operation,
    api: {
      workspace: {
        textDocuments: scenario === "fixall-document" ? [] : [document],
        getWorkspaceFolder() {
          operations.push("folder");
          return scenario === "fixall-folder"
            ? undefined
            : { uri: { toString: () => "private-folder" } };
        },
        async applyEdit() {
          operations.push("apply");
          return true;
        },
      },
      WorkspaceEdit: class {
        set() {
          operations.push("edit");
        }
      },
      Range: class {},
      TextEdit: { replace: () => ({}) },
    },
  });
  const editor = Object.assign(
    Object.create(module.exports.EditorIntegration.prototype) as Pick<
      EditorIntegration,
      "format" | "fixAll"
    >,
    {
      roots: {
        async refresh() {
          operations.push("refresh");
          if (scenario === "root-failed") throw primary;
        },
      },
      async snapshot() {
        operations.push("snapshot");
        return scenario === "snapshot-admission" ? undefined : snapshot;
      },
      isTemplate() {
        operations.push("template");
        return scenario === "format-preflight";
      },
      writable() {
        operations.push("writable");
        return true;
      },
      current() {
        operations.push("current");
        currentChecks++;
        return !(scenario === "before-submission" && currentChecks === 1);
      },
      async writableSnapshot() {
        operations.push("authority");
        authorityChecks++;
        return !(
          scenario === "format-result-authority" ||
          (scenario === "fixall-write-authority" && authorityChecks === 2)
        );
      },
      writableSnapshotNow() {
        operations.push("authority-now");
        return scenario !== "format-return-authority";
      },
      formatting: {
        async submit(
          _key: string,
          _priority: number,
          run: (signal: AbortSignal) => Promise<string>,
          signal: AbortSignal,
        ) {
          operations.push("submit");
          if (scenario === "after-submission") return undefined;
          return run(signal);
        },
      },
      output: {
        appendLine() {
          operations.push("output");
        },
      },
      error(error: unknown) {
        operations.push("error");
        errors.push(error);
      },
    },
  );
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      cancel = listener;
      return {
        dispose() {
          operations.push("detach");
        },
      };
    },
  } as vscode.CancellationToken;
  let outcome: unknown;
  try {
    outcome =
      scenario === "format-return-authority" ||
      scenario === "operation-cancelled"
        ? await editor.format(document, "canonical", token, collect)
        : await editor.fixAll(document.uri, collect);
  } catch (error) {
    outcome = error;
  }
  return { operations, errors, outcome };
}

test("passive invocation stages preserve default results, guards, operations and original errors", async () => {
  for (const scenario of cases) {
    const absent = await invoke(scenario);
    const collector = collectWritableOwnershipStages();
    const observed = await invoke(scenario, collector.collect);
    const throwing = await invoke(scenario, () => {
      throw new Error("collector failure");
    });
    assert.deepEqual(observed.operations, absent.operations, scenario);
    assert.deepEqual(throwing.operations, absent.operations, scenario);
    const errorMessages = (errors: unknown[]) =>
      errors.map((error) => String(error));
    assert.deepEqual(
      errorMessages(observed.errors),
      errorMessages(absent.errors),
      scenario,
    );
    assert.deepEqual(
      errorMessages(throwing.errors),
      errorMessages(absent.errors),
      scenario,
    );
    assert.equal(
      Array.isArray(observed.outcome)
        ? observed.outcome.length
        : observed.outcome,
      Array.isArray(absent.outcome) ? absent.outcome.length : absent.outcome,
      scenario,
    );
    assert.equal(
      Array.isArray(throwing.outcome)
        ? throwing.outcome.length
        : throwing.outcome,
      Array.isArray(absent.outcome) ? absent.outcome.length : absent.outcome,
      scenario,
    );
    if (scenario === "operation-failed")
      assert.equal(observed.errors[0], primary);
    if (scenario === "root-failed") {
      assert.equal(observed.outcome, primary);
      assert.deepEqual(collector.records, []);
    } else if (scenario === "accepted") {
      assert.deepEqual(
        collector.records.map(({ stage }) => stage),
        [
          "root-refresh-returned",
          "snapshot-present",
          "submission-entered",
          "operation-returned",
          "parser-accepted",
          "final-authority-accepted",
          "final-authority-accepted",
        ],
      );
      assert.ok(observed.operations.includes("apply"));
    } else if (
      ["operation-failed", "operation-cancelled", "parser-failed"].includes(
        scenario,
      )
    )
      assert.ok(
        collector.records.some(({ stage }) => stage === scenario),
        scenario,
      );
    else
      assert.ok(
        collector.records.some(
          ({ guard, stage }) =>
            guard === scenario &&
            (stage.endsWith("declined") || stage === "submission-refused"),
        ),
        scenario,
      );
    assert.ok(collector.records.length <= 24);
    assert.doesNotMatch(
      JSON.stringify(collector.records),
      /private|source.yml|invalid/,
    );
  }
});
