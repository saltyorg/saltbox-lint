import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  createLiveControlEvidence,
  captureLiveInvocationFailure,
  captureLivePendingInvocations,
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
      controlledInvocations: new Map(),
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
      invocations: [],
      controlledInvocations: new Map(),
      overflow: false,
      captureLiveInvocationFailure,
      captureLivePendingInvocations,
      primaryFilenames: new Map(),
      small: {},
      heavy: {},
      evidence,
      fixtureRecords: [],
      checkpoints: [],
      cleanupFailures: [],
      reportLiveControlFailure: (
        state: LiveControlEvidence | undefined,
        counts: { fixtures: number; checkpoints: number },
        _write: undefined,
        invocations: ReturnType<typeof captureLiveInvocationFailure>,
        pendingInvocations: ReturnType<typeof captureLivePendingInvocations>,
      ) =>
        reportLiveControlFailure(
          state,
          counts,
          () => {
            throw new Error("report failed");
          },
          invocations,
          pendingInvocations,
        ),
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
      controlledInvocations: new Map(),
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

test("held invocation projection distinguishes controlled close from later closes and actions", () => {
  const controlled: { closed?: number } = {};
  const successor: { closed?: number } = {};
  const mapping = new Map([["manual" as const, controlled]]);
  const calls = [controlled, successor];
  let value = captureLiveInvocationFailure(calls, mapping, false);
  assert.ok(value !== "unknown");
  assert.equal(value.launches, 2);
  assert.equal(value.closes, 0);
  assert.equal(value.pendingCloses, 2);
  assert.equal(
    value.controls.find((item) => item.control === "manual")!.close,
    "unknown",
  );
  controlled.closed = 1;
  value = captureLiveInvocationFailure(calls, mapping, false);
  assert.ok(value !== "unknown");
  assert.equal(
    value.controls.find((item) => item.control === "manual")!.close,
    "observed",
  );
  assert.equal(value.closes, 1);
  successor.closed = 2;
  value = captureLiveInvocationFailure(calls, mapping, false);
  assert.ok(value !== "unknown");
  assert.equal(value.pendingCloses, 0);
  const messages: string[] = [];
  reportLiveControlFailure(
    createLiveControlEvidence(),
    { fixtures: 0, checkpoints: 0 },
    (message) => messages.push(message),
    value,
  );
  const record = JSON.parse(
    messages[0].slice("SALTBOX_LIVE_CONTROL_FAILURE ".length),
  );
  validateLiveControlFailureRecord(record);
  assert.ok(record.operations.every((item) => item.completion === "unknown"));
  assert.doesNotMatch(messages[0], /cancelled|manualOwner|descendant/);
});

test("invocation evidence is capped, fault tolerant and strict about fields and counts", () => {
  const calls = Array.from({ length: 256 }, () => ({ closed: 1 }));
  const value = captureLiveInvocationFailure(calls, new Map(), false);
  assert.ok(value !== "unknown");
  assert.equal(value.launches, 256);
  assert.equal(value.closes, 256);
  assert.equal(value.pendingCloses, 0);
  assert.equal(captureLiveInvocationFailure(calls, new Map(), true), "unknown");
  assert.equal(
    captureLiveInvocationFailure([...calls, {}], new Map(), false),
    "unknown",
  );
  assert.equal(
    captureLiveInvocationFailure(
      [
        {
          get closed(): number {
            throw new Error("private");
          },
        },
      ],
      new Map(),
      false,
    ),
    "unknown",
  );
  const messages: string[] = [];
  reportLiveControlFailure(
    createLiveControlEvidence(),
    { fixtures: 0, checkpoints: 0 },
    (message) => messages.push(message),
    value,
  );
  const record = JSON.parse(
    messages[0].slice("SALTBOX_LIVE_CONTROL_FAILURE ".length),
  );
  for (const mutate of [
    (r) => {
      r.invocations.launches = 257;
    },
    (r) => {
      r.invocations.closes = -1;
    },
    (r) => {
      r.invocations.pendingCloses = 1;
    },
    (r) => {
      r.invocations.controls[0].close = "cancelled";
    },
    (r) => {
      r.invocations.controls[0].owner = "manual";
    },
    (r) => {
      r.invocations.pid = 10;
    },
  ] as ((r: typeof record) => void)[]) {
    const invalid = structuredClone(record);
    mutate(invalid);
    assert.throws(() => validateLiveControlFailureRecord(invalid));
  }
});

function pendingContext(evidence = createLiveControlEvidence()) {
  const small = {};
  const heavy = {};
  return {
    evidence,
    small,
    heavy,
    primaryFilenames: new Map([
      [small, "/private/small"],
      [heavy, "/private/heavy"],
    ]),
  };
}
function pendingRecord(
  value: ReturnType<typeof captureLivePendingInvocations>,
) {
  const messages: string[] = [];
  reportLiveControlFailure(
    createLiveControlEvidence(),
    { fixtures: 2, checkpoints: 13 },
    (message) => messages.push(message),
    "unknown",
    value,
  );
  assert.equal(messages.length, 1);
  assert.ok(Buffer.byteLength(messages[0]) <= liveControlEvidenceLimit);
  assert.doesNotMatch(
    messages[0],
    /private|pid|signal|exitCode|sha256|revision/,
  );
  const record: unknown = JSON.parse(
    messages[0].slice("SALTBOX_LIVE_CONTROL_FAILURE ".length),
  );
  validateLiveControlFailureRecord(record);
  return record;
}

test("failure projection retains selected closed invocation and later unclosed successor without inferring action success", () => {
  const context = pendingContext();
  noteLiveOperation(context.evidence, "manual", "entered");
  noteLiveOperation(context.evidence, "manual", "deadline");
  const selected = {
    primary: "/private/heavy",
    started: 10,
    closed: 30,
    cancelled: true,
  };
  const successor = { primary: "/private/heavy", started: 40 };
  const value = captureLivePendingInvocations(
    [{ primary: "/private/small", started: 1, closed: 2 }, selected, successor],
    new Map([["manual", selected]]),
    false,
    context,
    () => 15040,
  );
  assert.deepEqual(value, {
    selected: 2,
    suppressed: 0,
    entries: [
      {
        ordinal: 2,
        primary: "context-heavy",
        controls: ["manual"],
        elapsedMs: 15030,
        close: "observed",
        cancelled: true,
      },
      {
        ordinal: 3,
        primary: "context-heavy",
        controls: [],
        elapsedMs: 15000,
        close: "unknown",
        cancelled: "unknown",
      },
    ],
  });
  const record = pendingRecord(value);
  assert.ok(record.operations.every((item) => item.completion === "unknown"));
});

test("failure projection uses one capture clock and no clock or path-derived category values", () => {
  const context = pendingContext();
  let reads = 0;
  const calls = [
    { primary: "/private/small", started: 10, cancelled: false },
    { primary: "/private/heavy", started: 20 },
    { primary: "/private/unrecognized", started: 30 },
    { started: 40 },
  ];
  const value = captureLivePendingInvocations(
    calls,
    new Map(),
    false,
    context,
    () => {
      reads++;
      return 50.9;
    },
  );
  assert.ok(value !== "unknown");
  assert.equal(reads, 1);
  assert.deepEqual(
    value.entries.map((item) => item.primary),
    ["small", "context-heavy", "unknown", "unknown"],
  );
  assert.deepEqual(
    value.entries.map((item) => item.elapsedMs),
    [40, 30, 20, 10],
  );
  assert.deepEqual(
    value.entries.map((item) => item.cancelled),
    [false, "unknown", "unknown", "unknown"],
  );
  assert.equal(value.selected, "unknown");
  pendingRecord(value);
  assert.deepEqual(calls, [
    { primary: "/private/small", started: 10, cancelled: false },
    { primary: "/private/heavy", started: 20 },
    { primary: "/private/unrecognized", started: 30 },
    { started: 40 },
  ]);
});

test("unheld or unentered selection stays unknown and closed nonselected records are omitted", () => {
  const context = pendingContext();
  const closed = { started: 10, closed: 20 };
  const pending = { started: 30 };
  for (const evidence of [context.evidence, undefined]) {
    const value = captureLivePendingInvocations(
      [closed, pending],
      new Map([["manual", closed]]),
      false,
      { ...context, evidence },
      () => 40,
    );
    assert.ok(value !== "unknown");
    assert.equal(value.selected, "unknown");
    assert.deepEqual(
      value.entries.map((item) => item.ordinal),
      [2],
    );
  }
  noteLiveOperation(context.evidence, "manual", "deadline");
  const missing = captureLivePendingInvocations(
    [pending],
    new Map([["manual", closed]]),
    false,
    context,
    () => 40,
  );
  assert.ok(missing !== "unknown");
  assert.equal(missing.selected, "unknown");
  assert.deepEqual(
    missing.entries.map((item) => item.ordinal),
    [1],
  );
  const empty = captureLivePendingInvocations(
    [],
    new Map(),
    false,
    context,
    () => 40,
  );
  assert.deepEqual(empty, { selected: "unknown", suppressed: 0, entries: [] });
});

test("selected invocation precedes up to sixteen entries and truncation remains explicit within original byte cap", () => {
  const context = pendingContext();
  noteLiveOperation(context.evidence, "manual", "deadline");
  const calls = Array.from({ length: 256 }, () => ({
    primary: "/private/heavy",
    started: 0,
    closed: undefined,
  }));
  const selected = calls[255];
  const controls = new Map(
    liveControlNames.map((control) => [control, selected]),
  );
  const value = captureLivePendingInvocations(
    calls,
    controls,
    false,
    context,
    () => Number.MAX_SAFE_INTEGER,
  );
  assert.ok(value !== "unknown");
  assert.equal(value.selected, 256);
  assert.equal(value.entries.length, 16);
  assert.equal(value.suppressed, 240);
  assert.deepEqual(
    value.entries.map((item) => item.ordinal),
    [256, ...Array.from({ length: 15 }, (_, index) => index + 1)],
  );
  assert.deepEqual(value.entries[0].controls, [...liveControlNames]);
  const record = pendingRecord(value);
  for (const name of liveOperationNames) {
    const count = record.operations.find((item) => item.operation === name)!;
    count.entered = count.completed = liveOperationCountLimit;
    count.completion = "observed";
  }
  const messages: string[] = [];
  const evidence = createLiveControlEvidence()!;
  evidence.operations = record.operations.map(({ entered, completed }) => ({
    entered,
    completed,
  }));
  reportLiveControlFailure(
    evidence,
    { fixtures: 2, checkpoints: 13 },
    (message) => messages.push(message),
    captureLiveInvocationFailure(calls, controls, false),
    value,
  );
  assert.equal(messages.length, 1);
  assert.ok(Buffer.byteLength(messages[0]) <= liveControlEvidenceLimit);
});

test("saturated counts and faulty collectors stay unknown without mutating held records", () => {
  const context = pendingContext();
  const calls = [{ started: 0 }];
  let reads = 0;
  const clock = () => {
    reads++;
    throw new Error("private clock");
  };
  assert.equal(
    captureLivePendingInvocations(calls, new Map(), true, context, clock),
    "unknown",
  );
  assert.equal(
    captureLivePendingInvocations(
      Array.from({ length: 257 }, () => calls[0]),
      new Map(),
      false,
      context,
      clock,
    ),
    "unknown",
  );
  assert.equal(reads, 0);
  assert.equal(
    captureLivePendingInvocations(calls, new Map(), false, context, clock),
    "unknown",
  );
  assert.equal(reads, 1);
  for (const fault of [
    () =>
      captureLivePendingInvocations(
        [
          {
            get started(): number {
              throw new Error("private started");
            },
          },
        ],
        new Map(),
        false,
        context,
        () => 1,
      ),
    () =>
      captureLivePendingInvocations(
        calls,
        new Map(),
        false,
        {
          ...context,
          primaryFilenames: new (class extends Map<object, string> {
            override get(): never {
              throw new Error("private identity");
            }
          })(),
        },
        () => 1,
      ),
    () =>
      captureLivePendingInvocations(
        calls,
        new Map(),
        false,
        {
          ...context,
          evidence: {
            ...createLiveControlEvidence()!,
            get deadline(): never {
              throw new Error("private deadline");
            },
          },
        },
        () => 1,
      ),
  ])
    assert.equal(fault(), "unknown");
  assert.deepEqual(calls, [{ started: 0 }]);
  pendingRecord("unknown");
});

test("invalid or saturated monotonic ages remain unknown", () => {
  const context = pendingContext();
  for (const [started, captured] of [
    [NaN, 1],
    [Infinity, 1],
    [-1, 1],
    [2, 1],
    [0, Infinity],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ]) {
    const value = captureLivePendingInvocations(
      [{ started }],
      new Map(),
      false,
      context,
      () => captured,
    );
    assert.ok(value !== "unknown");
    assert.equal(value.entries[0].elapsedMs, "unknown");
    pendingRecord(value);
  }
});

test("pending projection rejects added private fields, inferred claims and invalid bounds", () => {
  const value = captureLivePendingInvocations(
    [{ started: 1 }],
    new Map(),
    false,
    pendingContext(),
    () => 2,
  );
  const base = pendingRecord(value);
  assert.ok(base.pendingInvocations !== "unknown");
  const record = { ...base, pendingInvocations: base.pendingInvocations };
  for (const mutate of [
    (r) => {
      Reflect.set(r.pendingInvocations.entries[0], "pid", 1);
    },
    (r) => {
      Reflect.set(
        r.pendingInvocations.entries[0],
        "primary",
        "/private/primary",
      );
    },
    (r) => {
      r.pendingInvocations.entries[0].controls = ["manual", "manual"];
    },
    (r) => {
      Reflect.set(r.pendingInvocations.entries[0], "controls", [
        "unknown-control",
      ]);
    },
    (r) => {
      r.pendingInvocations.entries[0].elapsedMs = -1;
    },
    (r) => {
      r.pendingInvocations.entries[0].elapsedMs = Infinity;
    },
    (r) => {
      r.pendingInvocations.entries[0].ordinal = 0;
    },
    (r) => {
      Reflect.set(r.pendingInvocations.entries[0], "close", "cancelled");
    },
    (r) => {
      Reflect.set(r.pendingInvocations.entries[0], "cancelled", "success");
    },
    (r) => {
      r.pendingInvocations.entries[0].close = "observed";
    },
    (r) => {
      r.pendingInvocations.selected = 2;
    },
    (r) => {
      r.pendingInvocations.suppressed = 1;
    },
    (r) => {
      r.pendingInvocations.entries.push(r.pendingInvocations.entries[0]);
    },
    (r) => {
      r.pendingInvocations.entries = Array.from(
        { length: 17 },
        () => r.pendingInvocations.entries[0],
      );
    },
  ] as ((r: typeof record) => void)[]) {
    const invalid = structuredClone(record);
    mutate(invalid);
    assert.throws(() => validateLiveControlFailureRecord(invalid));
  }
});

test("actual primary failure hook preserves the original error when the new projection clock or held inputs fail", async () => {
  const original = new Error("original pending control failure");
  const run = declaration("runLiveChecking");
  const hook = run.body!.statements.find(ts.isTryStatement)!.catchClause!;
  const failedBranch = run.body!.statements.find(
    (item): item is ts.IfStatement =>
      ts.isIfStatement(item) && item.expression.getText(source) === "failed",
  )!;
  for (const fault of ["clock", "primary", "deadline", "started"] as const) {
    const input = pendingContext();
    const evidence =
      fault === "deadline"
        ? {
            ...input.evidence!,
            get deadline(): never {
              throw new Error("private deadline");
            },
          }
        : input.evidence;
    const invocations =
      fault === "started"
        ? [
            {
              get started(): never {
                throw new Error("private started");
              },
            },
          ]
        : [{ started: 0 }];
    const primaryFilenames =
      fault === "primary"
        ? new (class extends Map<object, string> {
            override get(): never {
              throw new Error("private primary");
            }
          })()
        : input.primaryFilenames;
    let captured: ReturnType<typeof captureLivePendingInvocations> | undefined;
    const context = {
      ...input,
      error: original,
      failed: false,
      primaryFailure: undefined,
      invocations,
      controlledInvocations: new Map(),
      overflow: false,
      evidence,
      primaryFilenames,
      captureLiveInvocationFailure,
      captureLivePendingInvocations: (
        ...args: Parameters<typeof captureLivePendingInvocations>
      ) => {
        captured = captureLivePendingInvocations(
          ...(args.slice(0, 4) as [
            (typeof args)[0],
            (typeof args)[1],
            boolean,
            (typeof args)[3],
          ]),
          () => {
            if (fault === "clock") throw new Error("private clock");
            return 1;
          },
        );
        return captured;
      },
      fixtureRecords: [],
      checkpoints: [],
      cleanupFailures: [],
      reportLiveControlFailure,
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
    assert.equal(captured, "unknown");
    assert.equal(context.primaryFailure, original);
    assert.equal(context.failed, true);
  }
});
