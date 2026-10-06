import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const source = ts.createSourceFile(
  "live-checking.ts",
  readFileSync("test/host/live-checking.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const run = source.statements.find(
  (statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "runLiveChecking",
);
assert.ok(run?.body);
const cleanup = run.body.statements.find(ts.isTryStatement)?.finallyBlock;
assert.ok(cleanup);
for (const failure of [
  "none",
  "deactivate",
  "join",
  "restore",
  "unsubscribe",
] as const) {
  test(`actual live host restores observer and releases listener after ${failure}`, async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const original = new Error("owned cleanup failure");
    const control = (name: string) => {
      calls.push(name);
      if (name === failure) throw original;
    };
    const operation = runInNewContext(
      `(async () => ${cleanup.getText(source)})()`,
      {
        launchControl: () => {},
        runtime: { deactivate: async () => control("deactivate") },
        bounded: (promise: Promise<void>) => promise,
        observed: async () => control("join"),
        invocations: [],
        cleanupFailures: errors,
        Object: { defineProperty: () => control("restore") },
        childProcesses: {},
        descriptor: {},
        changeListener: { dispose: () => control("unsubscribe") },
      },
    ) as Promise<void>;
    await operation;
    assert.ok(calls.includes("restore"));
    assert.ok(calls.includes("unsubscribe"));
    assert.deepEqual(errors, failure === "none" ? [] : [original]);
  });
}
