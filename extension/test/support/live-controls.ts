import assert from "node:assert/strict";
import {
  noteLiveOperation,
  noteLiveControlStage,
  captureLiveInvocationFailure,
  captureLivePendingInvocations,
  reportLiveControlFailure,
  type LiveControlEvidence,
} from "../host/live-control-evidence.ts";
import type {
  LiveControlName,
  LiveOperationName,
} from "../host/live-control-vocabulary.ts";

export interface LiveInvocation {
  started?: number;
  primary?: string;
  closed?: number;
  cancelled?: boolean;
  exitCode?: number | null;
}
export type LiveBounded = <T>(
  operation: PromiseLike<T>,
  name: LiveOperationName,
  evidence: LiveControlEvidence | undefined,
) => Promise<T>;
export interface LiveDeadline {
  milliseconds?: number;
  schedule?: (expire: () => void, milliseconds: number) => () => void;
  cancel?: () => void;
}
export function createLiveBounded(adapters: LiveDeadline = {}): LiveBounded {
  return async (operation, name, evidence) => {
    noteLiveOperation(evidence, name, "entered");
    const admitted = Promise.resolve(operation);
    let clear: (() => void) | undefined;
    let cancellationFailure: { error: unknown } | undefined;
    let primary: { error: unknown } | undefined;
    try {
      const result = await Promise.race([
        admitted,
        new Promise<never>((_resolve, reject) => {
          const schedule =
            adapters.schedule ??
            ((expire, milliseconds) => {
              const timer = setTimeout(expire, milliseconds);
              return () => clearTimeout(timer);
            });
          clear = schedule(() => {
            noteLiveOperation(evidence, name, "deadline");
            const failure = new Error("Live checking control deadline");
            reject(failure);
            try {
              adapters.cancel?.();
            } catch (error) {
              cancellationFailure = { error };
            }
          }, adapters.milliseconds ?? 15000);
        }),
      ]);
      noteLiveOperation(evidence, name, "completed");
      return result;
    } catch (error) {
      primary = { error };
      // The deadline identifies failure. Its losing operation remains owned.
      await admitted.catch(() => undefined);
      if (cancellationFailure)
        throw new AggregateError(
          [error, cancellationFailure.error],
          "Live deadline cancellation failed",
          { cause: error },
        );
      throw error;
    } finally {
      try {
        clear?.();
      } catch (error) {
        throw new AggregateError(
          [
            ...(primary ? [primary.error] : []),
            ...(cancellationFailure ? [cancellationFailure.error] : []),
            error,
          ],
          "Live deadline restoration failed",
          { cause: primary?.error ?? error },
        );
      }
    }
  };
}

export async function replaceLiveDocument<Document>(
  document: Document,
  text: string,
  name: LiveOperationName,
  evidence: LiveControlEvidence | undefined,
  adapters: {
    apply: (document: Document, text: string) => PromiseLike<boolean>;
    bounded: LiveBounded;
  },
): Promise<void> {
  assert.equal(
    await adapters.bounded(adapters.apply(document, text), name, evidence),
    true,
  );
}

export interface LiveCancelContext<Document> {
  evidence: LiveControlEvidence | undefined;
  performance: { now(): number };
  controlledInvocations: Map<LiveControlName, LiveInvocation>;
  launchControl: ((invocation: LiveInvocation) => void) | undefined;
  signal?: AbortSignal;
  controlNumber: number;
  heavy: Document;
  slow: string;
  replace(
    document: Document,
    text: string,
    name: LiveOperationName,
    evidence: LiveControlEvidence | undefined,
  ): Promise<void>;
  observed(predicate: () => boolean, message: string): Promise<void>;
  bounded(
    operation: PromiseLike<number>,
    name: LiveOperationName,
    evidence: LiveControlEvidence | undefined,
  ): Promise<unknown>;
}
export async function cancelLiveControl<Document>(
  name: LiveControlName,
  action: () => Promise<unknown>,
  context: LiveCancelContext<Document>,
): Promise<number> {
  let resolve!: (milliseconds: number) => void;
  let reject!: (error: unknown) => void;
  const completed = new Promise<number>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const monitored = completed.catch(() => undefined);
  const actions: Promise<void>[] = [];
  const cancel = () => {
    context.launchControl = undefined;
    reject(context.signal?.reason ?? new Error("Live control canceled"));
  };
  context.signal?.addEventListener("abort", cancel, { once: true });
  if (context.signal?.aborted) cancel();
  noteLiveControlStage(context.evidence, name, "waiting-for-launch");
  context.launchControl = (invocation) => {
    if (context.signal?.aborted) {
      cancel();
      return;
    }
    try {
      try {
        context.controlledInvocations.set(name, invocation);
      } catch {
        /* Evidence is optional. */
      }
      noteLiveControlStage(context.evidence, name, "action-pending");
      const started = context.performance.now();
      assert.equal(
        invocation.closed,
        undefined,
        "control observes a live native CLI",
      );
      const work = action()
        .then(async () => {
          noteLiveControlStage(context.evidence, name, "waiting-for-close");
          await context.observed(
            () => invocation.closed !== undefined,
            "cancelled native CLI close join",
          );
          assert.equal(
            invocation.cancelled,
            true,
            "control cancels the native CLI before joining it",
          );
          noteLiveControlStage(context.evidence, name, "close-completed");
          resolve(invocation.closed! - started);
        })
        .catch(reject);
      actions.push(work);
    } catch (error) {
      reject(error);
    }
  };
  try {
    if (context.signal?.aborted) throw context.signal.reason;
    await context.replace(
      context.heavy,
      context.slow + `# control ${++context.controlNumber}\r\n`,
      "control-launch-edit",
      context.evidence,
    );
    const result = await context.bounded(completed, name, context.evidence);
    assert.equal(typeof result, "number");
    return result as number;
  } catch (error) {
    reject(error);
    throw error;
  } finally {
    context.launchControl = undefined;
    context.signal?.removeEventListener("abort", cancel);
    await monitored;
    await Promise.all(actions);
  }
}

export interface LiveSequenceContext<Document> {
  small: Document;
  heavy: Document;
  evidence: LiveControlEvidence | undefined;
  controlledInvocations: Map<LiveControlName, LiveInvocation>;
  primaryCalls(document: Document): LiveInvocation[];
  cancelControl(
    name: LiveControlName,
    action: () => Promise<unknown>,
  ): Promise<number>;
  expected(document: Document, line: number): boolean;
  replace(
    document: Document,
    text: string,
    name: LiveOperationName,
    evidence: LiveControlEvidence | undefined,
  ): Promise<void>;
  observed(predicate: () => boolean, message: string): Promise<void>;
  checkpoint(name: string): Promise<void>;
  source(line: number): string;
  vscode: {
    window: {
      activeTextEditor: { document: Document } | undefined;
      showTextDocument(
        document: Document,
        options: { preview: boolean },
      ): PromiseLike<unknown>;
    };
    commands: { executeCommand(command: string): PromiseLike<unknown> };
  };
}
export async function runManualLiveControl<Document>(
  context: LiveSequenceContext<Document>,
): Promise<number> {
  const { small, heavy, evidence } = context;
  await context.vscode.window.showTextDocument(small, { preview: false });
  assert.equal(context.vscode.window.activeTextEditor?.document, small);
  const before = context.primaryCalls(small).length;
  const elapsed = await context.cancelControl("manual", async () => {
    const typing = context.controlledInvocations.get("manual");
    assert.ok(typing);
    assert.equal(typing.closed, undefined);
    await context.vscode.commands.executeCommand("saltboxLint.checkDocument");
  });
  const typing = context.controlledInvocations.get("manual");
  assert.ok(typing);
  assert.equal(typing.cancelled, true);
  assert.notEqual(typing.closed, undefined);
  const requests = context.primaryCalls(small).slice(before);
  assert.equal(requests.length, 1);
  assert.notEqual(requests[0].closed, undefined);
  assert.equal(requests[0].cancelled, false);
  assert.equal(requests[0].exitCode, 1);
  assert.ok(context.expected(small, 59));
  await context.replace(
    heavy,
    context.source(92),
    "manual-restored-edit",
    evidence,
  );
  await context.observed(
    () => context.expected(heavy, 92),
    "manual priority restores the latest compact typing snapshot",
  );
  await context.vscode.window.showTextDocument(heavy, { preview: false });
  await context.checkpoint("manual");
  return elapsed;
}
export async function runSaveLiveControl<Document>(
  context: Pick<
    LiveSequenceContext<Document>,
    | "heavy"
    | "evidence"
    | "controlledInvocations"
    | "cancelControl"
    | "expected"
    | "replace"
    | "observed"
    | "checkpoint"
    | "source"
  > & { small: Document & { save(): PromiseLike<unknown> } },
): Promise<number> {
  const { small, heavy, evidence } = context;
  const elapsed = await context.cancelControl("save", async () => {
    await small.save();
  });
  await context.observed(
    () => context.expected(small, 91),
    "save has priority over active typing",
  );
  const typing = context.controlledInvocations.get("save");
  assert.ok(typing);
  assert.equal(typing.cancelled, true);
  assert.notEqual(typing.closed, undefined);
  await context.replace(
    heavy,
    context.source(93),
    "save-restored-edit",
    evidence,
  );
  await context.observed(
    () => context.expected(heavy, 93),
    "save priority restores the latest compact typing snapshot",
  );
  await context.checkpoint("save");
  return elapsed;
}

export async function cleanupLiveControls(input: {
  stopLaunch(): void;
  deactivate(): Promise<unknown>;
  join(): Promise<void>;
  restore(): void;
  unsubscribe(): void;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const action of [
    input.stopLaunch,
    input.deactivate,
    input.join,
    input.restore,
    input.unsubscribe,
  ]) {
    try {
      await Promise.resolve(action());
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export interface LiveFailureState {
  failed: boolean;
  primaryFailure: unknown;
}
export function captureLiveFailure<Document>(
  error: unknown,
  context: LiveFailureState & {
    evidence: LiveControlEvidence | undefined;
    invocations: readonly (LiveInvocation & { started: number })[];
    controlledInvocations: ReadonlyMap<
      LiveControlName,
      LiveInvocation & { started: number }
    >;
    overflow: boolean;
    primaryFilenames: ReadonlyMap<Document, string>;
    small: Document;
    heavy: Document;
    fixtureRecords: readonly unknown[];
    checkpoints: readonly unknown[];
    capturePending?: typeof captureLivePendingInvocations<Document>;
    report?: (
      evidence: LiveControlEvidence | undefined,
      counts: Parameters<typeof reportLiveControlFailure>[1],
      write: undefined,
      invocations: ReturnType<typeof captureLiveInvocationFailure>,
      pending: ReturnType<typeof captureLivePendingInvocations>,
    ) => void;
  },
): void {
  context.failed = true;
  context.primaryFailure = error;
  try {
    (context.report ?? reportLiveControlFailure)(
      context.evidence,
      {
        fixtures: context.fixtureRecords.length,
        checkpoints: context.checkpoints.length,
      },
      undefined,
      captureLiveInvocationFailure(
        context.invocations,
        context.controlledInvocations,
        context.overflow,
      ),
      (context.capturePending ?? captureLivePendingInvocations)(
        context.invocations,
        context.controlledInvocations,
        context.overflow,
        context,
      ),
    );
  } catch {
    /* Reporting cannot replace the original control failure. */
  }
}
export function finishLiveFailure(
  state: LiveFailureState,
  cleanupFailures: readonly unknown[],
): void {
  if (state.failed && cleanupFailures.length === 0) throw state.primaryFailure;
  if (cleanupFailures.length)
    throw new AggregateError(
      [...(state.failed ? [state.primaryFailure] : []), ...cleanupFailures],
      "Live checking body and cleanup failed",
      { cause: state.failed ? state.primaryFailure : cleanupFailures[0] },
    );
}
