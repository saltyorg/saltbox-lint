import assert from "node:assert/strict";
import type { runProcess } from "../../src/process.ts";
import type { ProcessFailureCategory } from "../../src/process-failure.ts";

export interface LiveNativeInvocation {
  primary?: string;
  started: number;
  closed?: number;
  cancelled?: boolean;
  exitCode?: number | null;
}
export interface LiveProcessRequest {
  admitted: number;
  operation: string;
  invocation?: LiveNativeInvocation;
  admission?: "spawned" | "missing-pid";
  settled?: number;
  outcome?: "fulfilled" | "rejected";
  failure?: ProcessFailureCategory;
  cancelledBeforeSpawn?: boolean;
}

/** Requests can finish canceled before a native spawn. Every spawned child still needs close. */
export function createLiveProcessTracker(
  run: typeof runProcess,
  options: {
    now?: () => number;
    onSpawn?: (invocation: LiveNativeInvocation) => void;
  } = {},
) {
  const now = options.now ?? (() => performance.now());
  const requests: LiveProcessRequest[] = [];
  const invocations: LiveNativeInvocation[] = [];
  let overflow = false;
  const runner: typeof runProcess = (
    request,
    signal,
    observeFailure,
    lifecycle,
  ) => {
    const position = request.args.indexOf("--stdin-filename");
    const primary = position < 0 ? undefined : request.args[position + 1];
    const recorded: LiveProcessRequest = {
      admitted: now(),
      operation: request.args[0],
    };
    if (requests.length >= 256) overflow = true;
    else requests.push(recorded);
    let pending: Promise<string>;
    try {
      pending = run(
        request,
        signal,
        (failure) => {
          recorded.failure = failure;
          observeFailure?.(failure);
        },
        {
          spawned(pid) {
            if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0) {
              recorded.admission = "missing-pid";
              lifecycle?.spawned?.(pid);
              return;
            }
            recorded.admission = "spawned";
            const invocation: LiveNativeInvocation = {
              started: now(),
              primary,
            };
            recorded.invocation = invocation;
            if (invocations.length >= 256) overflow = true;
            else invocations.push(invocation);
            options.onSpawn?.(invocation);
            lifecycle?.spawned?.(pid);
          },
          closed(code, exitSignal) {
            if (recorded.invocation) {
              recorded.invocation.cancelled =
                signal.aborted ||
                exitSignal === "SIGKILL" ||
                exitSignal === "SIGTERM";
              recorded.invocation.closed = now();
              recorded.invocation.exitCode = code;
            }
            lifecycle?.closed?.(code, exitSignal);
          },
        },
      );
    } catch (error) {
      recorded.failure ??= "setup";
      pending = Promise.reject(error);
    }
    return pending.then(
      (output) => {
        recorded.settled = now();
        recorded.outcome = "fulfilled";
        return output;
      },
      (error: unknown) => {
        recorded.settled = now();
        recorded.outcome = "rejected";
        recorded.cancelledBeforeSpawn =
          !recorded.admission &&
          recorded.failure === "cancelled" &&
          signal.aborted &&
          error instanceof Error &&
          !(error instanceof AggregateError);
        throw error;
      },
    );
  };
  const accounting = () => ({
    admitted: requests.length,
    settled: requests.filter((request) => request.settled !== undefined).length,
    cancelledBeforeSpawn: requests.filter(
      (request) => request.cancelledBeforeSpawn,
    ).length,
  });
  return {
    runner,
    requests,
    invocations,
    accounting,
    get overflow() {
      return overflow;
    },
    assertJoined() {
      assert.equal(overflow, false, "live request evidence bound");
      assert.ok(
        requests.every((request) => request.settled !== undefined),
        "all admitted native runner operations settled",
      );
      assert.ok(
        invocations.every((invocation) => invocation.closed !== undefined),
        "all actual native spawns have exact close observations",
      );
      for (const request of requests) {
        assert.notEqual(
          request.admission,
          "missing-pid",
          "native admission requires a defined actual process identity",
        );
        if (!request.invocation) {
          assert.equal(
            request.outcome,
            "rejected",
            "a successful native request requires a spawn",
          );
          assert.equal(
            request.cancelledBeforeSpawn,
            true,
            "only an explicit canceled request with successful ownership cleanup can finish without a native child",
          );
        }
      }
      const counts = accounting();
      assert.equal(
        counts.admitted,
        invocations.length + counts.cancelledBeforeSpawn,
        "every admitted request owns a native child or an explicit canceled no-child outcome",
      );
    },
  };
}
