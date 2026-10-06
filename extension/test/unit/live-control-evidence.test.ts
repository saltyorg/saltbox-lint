import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  createLiveControlEvidence,
  noteLiveOperation,
  noteLiveControlStage,
  reportLiveControlFailure,
  validateLiveControlFailureRecord,
  type LiveControlEvidence,
} from "../host/live-control-evidence.ts";
import {
  liveControlNames,
  liveOperationNames,
  liveOperationCountLimit,
  liveControlEvidenceLimit,
} from "../host/live-control-vocabulary.ts";

const source = ts.createSourceFile(
  "live-checking.ts",
  readFileSync("test/host/live-checking.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
function declaration(name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found);
  return found;
}
function javascript(text: string): string {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function projection(evidence: LiveControlEvidence | undefined) {
  const messages: string[] = [];
  reportLiveControlFailure(
    evidence,
    { fixtures: 0, checkpoints: 0 },
    (message) => messages.push(message),
  );
  assert.equal(messages.length, 1);
  assert.ok(Buffer.byteLength(messages[0]) <= liveControlEvidenceLimit);
  const value: unknown = JSON.parse(
    messages[0].slice("SALTBOX_LIVE_CONTROL_FAILURE ".length),
  );
  validateLiveControlFailureRecord(value);
  return value;
}
function boundedControl(evidence = createLiveControlEvidence()) {
  const callbacks: (() => void)[] = [];
  const cleared: unknown[] = [];
  const durations: number[] = [];
  const bounded = runInNewContext(
    javascript(declaration("bounded").getText(source)) + "\nbounded;",
    {
      deadlineMs: 15000,
      noteLiveOperation,
      setTimeout: (callback: () => void, milliseconds: number) => {
        callbacks.push(callback);
        durations.push(milliseconds);
        return callbacks.length;
      },
      clearTimeout: (timer: unknown) => cleared.push(timer),
    },
  ) as (
    operation: PromiseLike<unknown>,
    name: string,
    evidence: LiveControlEvidence | undefined,
  ) => Promise<unknown>;
  return { evidence, callbacks, cleared, durations, bounded };
}

test("unentered operations and controls have no observed completion", () => {
  const value = projection(createLiveControlEvidence());
  assert.equal(value.deadline, "unknown");
  assert.ok(
    value.operations.every(
      (item) =>
        item.entered === 0 &&
        item.completed === 0 &&
        item.completion === "unknown",
    ),
  );
  assert.ok(value.controls.every((item) => item.stage === "unknown"));
});

test("actual bounded success keeps one original timer, one await and no report", async () => {
  const control = boundedControl();
  const operation = Promise.withResolvers<number>();
  const pending = control.bounded(
    operation.promise,
    "default-off-edit",
    control.evidence,
  );
  assert.equal(
    projection(control.evidence).operations[0].completion,
    "unknown",
  );
  operation.resolve(7);
  assert.equal(await pending, 7);
  assert.deepEqual(control.durations, [15000]);
  assert.deepEqual(control.cleared, [1]);
  assert.equal(
    projection(control.evidence).operations[0].completion,
    "observed",
  );
  assert.equal(projection(control.evidence).deadline, "unknown");
});

test("actual timeout preserves the exact error and records the existing bounded operation", async () => {
  const control = boundedControl();
  const operation = Promise.withResolvers<void>();
  const pending = control.bounded(
    operation.promise,
    "enable-setting",
    control.evidence,
  );
  const rejection = assert.rejects(pending, (error: unknown) => {
    assert.ok(error && typeof error === "object" && "message" in error);
    assert.equal(error.message, "Live checking control deadline");
    return true;
  });
  control.callbacks[0]();
  await rejection;
  const value = projection(control.evidence);
  assert.equal(value.deadline, "enable-setting");
  assert.deepEqual(value.operations[2], {
    operation: "enable-setting",
    entered: 1,
    completed: 0,
    completion: "unknown",
  });
  assert.deepEqual(control.durations, [15000]);
  assert.deepEqual(control.cleared, [1]);
});

for (const name of liveControlNames) {
  test(`actual ${name} callbacks distinguish launch, action and close without claiming native cause`, async () => {
    const control = boundedControl();
    const action = Promise.withResolvers<void>();
    const close = Promise.withResolvers<void>();
    const waitingForClose = Promise.withResolvers<void>();
    const heavy = {};
    const edits: unknown[][] = [];
    const context = {
      evidence: control.evidence,
      noteLiveControlStage,
      assert,
      performance: { now: () => 10 },
      observed: async (predicate: () => boolean) => {
        assert.equal(predicate(), false);
        waitingForClose.resolve();
        await close.promise;
        assert.equal(predicate(), true);
      },
      launchControl: undefined as
        | ((invocation: { closed?: number; cancelled?: boolean }) => void)
        | undefined,
      controlNumber: 0,
      heavy,
      slow: "fixed test workload",
      replace: async (...args: unknown[]) => {
        edits.push(args);
      },
      bounded: control.bounded,
    };
    const cancel = runInNewContext(
      javascript(declaration("cancelControl").getText(source)) +
        "\ncancelControl;",
      context,
    ) as (name: string, action: () => Promise<void>) => Promise<number>;
    const pending = cancel(name, () => action.promise);
    const stage = () =>
      projection(control.evidence).controls.find(
        (item) => item.control === name,
      )!.stage;
    assert.equal(stage(), "waiting-for-launch");
    assert.equal(edits.length, 1);
    assert.equal(edits[0][0], heavy);
    assert.equal(edits[0][2], "control-launch-edit");
    const invocation: { closed?: number; cancelled?: boolean } = {};
    context.launchControl!(invocation);
    assert.equal(stage(), "action-pending");
    action.resolve();
    await waitingForClose.promise;
    assert.equal(stage(), "waiting-for-close");
    assert.equal(
      projection(control.evidence).operations.find(
        (item) => item.operation === name,
      )!.completion,
      "unknown",
    );
    invocation.closed = 20;
    invocation.cancelled = true;
    close.resolve();
    assert.equal(await pending, 10);
    assert.equal(stage(), "close-completed");
    assert.equal(
      projection(control.evidence).operations.find(
        (item) => item.operation === name,
      )!.completion,
      "observed",
    );
    assert.deepEqual(control.durations, [15000]);
    assert.deepEqual(control.cleared, [1]);
  });
}

test("actual applyEdit wrapper preserves arguments and default absent collector behavior", async () => {
  const control = boundedControl();
  let calls = 0;
  const document = {
    uri: {},
    getText: () => "previous",
    positionAt: (offset: number) => offset,
  };
  const replacements: unknown[][] = [];
  const replace = runInNewContext(
    javascript(declaration("replace").getText(source)) + "\nreplace;",
    {
      assert,
      bounded: control.bounded,
      vscode: {
        WorkspaceEdit: class {
          replace(...args: unknown[]) {
            replacements.push(args);
          }
        },
        Range: class {
          readonly start: number;
          readonly end: number;
          constructor(start: number, end: number) {
            this.start = start;
            this.end = end;
          }
        },
        workspace: {
          applyEdit: async () => {
            calls++;
            return true;
          },
        },
      },
    },
  ) as (
    document: unknown,
    text: string,
    name: string,
    evidence: undefined,
  ) => Promise<void>;
  await replace(document, "replacement", "default-off-edit", undefined);
  assert.equal(calls, 1);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0][0], document.uri);
  assert.equal(replacements[0][2], "replacement");
  assert.deepEqual(control.durations, [15000]);
  assert.deepEqual(control.cleared, [1]);
});

test("collector faults and reporter faults preserve actual primary failure identity and partial-run rejection", async () => {
  const original = new Error("original control failure");
  const faulty = createLiveControlEvidence()!;
  Object.defineProperty(faulty, "operations", {
    get() {
      throw new Error("collector failure");
    },
  });
  noteLiveControlStage(faulty, "manual", "action-pending");
  const control = boundedControl(faulty);
  await assert.rejects(
    control.bounded(Promise.reject(original), "manual", faulty),
    (error: unknown) => error === original,
  );
  const run = declaration("runLiveChecking");
  const hook = run.body!.statements.find(ts.isTryStatement)!.catchClause!;
  const failedBranch = run.body!.statements.find(
    (item): item is ts.IfStatement =>
      ts.isIfStatement(item) && item.expression.getText(source) === "failed",
  )!;
  for (const evidence of [undefined, faulty, createLiveControlEvidence()]) {
    const context = {
      error: original,
      failed: false,
      primaryFailure: undefined,
      evidence,
      fixtureRecords: [],
      checkpoints: [],
      cleanupFailures: [],
      reportLiveControlFailure: (
        state: LiveControlEvidence | undefined,
        counts: { fixtures: number; checkpoints: number },
      ) =>
        reportLiveControlFailure(state, counts, () => {
          throw new Error("report failed");
        }),
    };
    await assert.rejects(
      runInNewContext(
        javascript(
          `async function reject() { ${hook.block.getText(source)} ${failedBranch.getText(source)} } reject();`,
        ),
        context,
      ) as Promise<void>,
      (error: unknown) => error === original,
    );
    assert.equal(context.primaryFailure, original);
    assert.equal(context.failed, true);
  }
});

test("fixed projection bounds counters and rejects added or inconsistent data", () => {
  const evidence = createLiveControlEvidence()!;
  for (const name of liveOperationNames) {
    for (let index = 0; index < liveOperationCountLimit; index++) {
      noteLiveOperation(evidence, name, "entered");
      noteLiveOperation(evidence, name, "completed");
    }
  }
  projection(evidence);
  noteLiveOperation(evidence, "manual", "entered");
  assert.equal(
    evidence.operations[liveOperationNames.indexOf("manual")].entered,
    liveOperationCountLimit,
  );
  const messages: string[] = [];
  reportLiveControlFailure(
    evidence,
    { fixtures: 2, checkpoints: 13 },
    (message) => messages.push(message),
  );
  assert.deepEqual(messages, []);
  const value = projection(createLiveControlEvidence());
  for (const mutate of [
    (record: typeof value) => {
      Reflect.set(record, "path", "forbidden");
    },
    (record: typeof value) => {
      Reflect.set(record.controls[0], "identity", "forbidden");
    },
    (record: typeof value) => {
      Reflect.set(record.operations[0], "response", "forbidden");
    },
    (record: typeof value) => {
      record.operations[0].completed = 1;
    },
    (record: typeof value) => {
      record.operations[0].completion = "observed";
    },
    (record: typeof value) => {
      record.completed.checkpoints = 14;
    },
    (record: typeof value) => {
      Reflect.set(record, "deadline", "source-derived");
    },
    (record: typeof value) => {
      Reflect.set(record.controls[0], "stage", "inferred-cause");
    },
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => validateLiveControlFailureRecord(changed));
  }
});

for (const stoppedStage of [
  "waiting-for-launch",
  "action-pending",
  "waiting-for-close",
] as const) {
  test(`actual control timeout retains ${stoppedStage} as an observation only`, async () => {
    const control = boundedControl();
    const entered = Promise.withResolvers<void>();
    const action = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const close = Promise.withResolvers<void>();
    const context = {
      evidence: control.evidence,
      noteLiveControlStage,
      assert,
      performance: { now: () => 10 },
      observed: async () => {
        waiting.resolve();
        await close.promise;
      },
      launchControl: undefined as
        | ((invocation: { closed?: number; cancelled?: boolean }) => void)
        | undefined,
      controlNumber: 0,
      heavy: {},
      slow: "fixed test workload",
      replace: async () => {},
      bounded: (
        operation: PromiseLike<unknown>,
        name: string,
        evidence: LiveControlEvidence | undefined,
      ) => {
        const pending = control.bounded(operation, name, evidence);
        entered.resolve();
        return pending;
      },
    };
    const cancel = runInNewContext(
      javascript(declaration("cancelControl").getText(source)) +
        "\ncancelControl;",
      context,
    ) as (name: string, action: () => Promise<void>) => Promise<number>;
    const pending = cancel("manual", () => action.promise);
    await entered.promise;
    const invocation: { closed?: number; cancelled?: boolean } = {};
    if (stoppedStage !== "waiting-for-launch")
      context.launchControl!(invocation);
    if (stoppedStage === "waiting-for-close") {
      action.resolve();
      await waiting.promise;
    }
    const rejection = assert.rejects(pending, {
      message: "Live checking control deadline",
    });
    control.callbacks[0]();
    await rejection;
    const record = projection(control.evidence);
    assert.equal(record.deadline, "manual");
    assert.equal(
      record.controls.find((item) => item.control === "manual")!.stage,
      stoppedStage,
    );
    assert.equal(
      record.operations.find((item) => item.operation === "manual")!.completion,
      "unknown",
    );
    assert.deepEqual(control.cleared, [1]);
    // Release held test promises after the assertion. No native SDK ran here.
    if (stoppedStage === "waiting-for-launch")
      context.launchControl!(invocation);
    action.resolve();
    invocation.closed = 20;
    invocation.cancelled = true;
    close.resolve();
  });
}
