import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { Readable } from "node:stream";
import { groupHasLiveMembers } from "./native-group.ts";
import {
  processSupervisorEnvironment,
  reserveProcess,
} from "./process-reservation.ts";
import type {
  ProcessFailureCategory,
  ProcessFailureObserver,
} from "./process-failure.ts";
/** Inherited owner-lifetime pipe; its EOF tells the CLI that this host died. */
export const processLifetimeEnvironment = "SALTBOX_LINT_EDITOR_LIFETIME";
export const processLifetimeDescriptor = 3;
export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  input?: string | Uint8Array;
  successCodes?: number[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Per-request overrides; editor process ownership is always enforced. */
  env?: Readonly<NodeJS.ProcessEnv>;
}
export interface ProcessLifecycleObserver {
  spawned?(pid: number | undefined): void;
  closed?(code: number | null, signal: NodeJS.Signals | null): void;
}
export type ProcessTerminationPhase =
  "abort" | "exit" | "stdin" | "output-limit" | "timeout" | "setup";
export interface ProcessTerminationContext {
  readonly phase: ProcessTerminationPhase;
  readonly target: number;
  readonly signal: "SIGKILL";
}
export interface ProcessAdapters {
  spawn?(
    executable: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess;
  /** Recovery policy only; native spawning still uses the actual host platform. */
  platform?: NodeJS.Platform;
  /** POSIX child termination before a native exit receipt. */
  killChild?(context: Readonly<ProcessTerminationContext>): void;
  killGroup?(context: Readonly<ProcessTerminationContext>): void;
  groupHasLiveMembers?(group: number, signal?: AbortSignal): Promise<boolean>;
}
interface TerminationObservation extends ProcessTerminationContext {
  nativeExitObserved: boolean;
  code: string | number | null;
  errno: string | number | null;
  syscall: string | null;
}
function terminationObservation(
  context: Readonly<ProcessTerminationContext>,
  error: unknown,
  nativeExitObserved: boolean,
): TerminationObservation {
  const observation: TerminationObservation = {
    ...context,
    nativeExitObserved,
    code: null,
    errno: null,
    syscall: null,
  };
  try {
    const native = error as NodeJS.ErrnoException | undefined;
    observation.code =
      typeof native?.code === "string" ? native.code.slice(0, 64) : null;
    observation.errno = typeof native?.errno === "number" ? native.errno : null;
    observation.syscall =
      typeof native?.syscall === "string" ? native.syscall.slice(0, 64) : null;
  } catch {
    // Diagnostic access cannot replace the original termination error.
  }
  return observation;
}
/** Own the process tree until exit, including descendants retaining output pipes. */
export function runProcess(
  request: ProcessRequest,
  signal: AbortSignal,
  observeFailure?: ProcessFailureObserver,
  lifecycle?: ProcessLifecycleObserver,
  adapters: ProcessAdapters = {},
): Promise<string> {
  if (signal.aborted)
    return runOwnedProcess(
      request,
      signal,
      observeFailure,
      lifecycle,
      undefined,
      adapters,
    );
  let supervisor: string | undefined;
  try {
    supervisor =
      process.env[processSupervisorEnvironment] ??
      request.env?.[processSupervisorEnvironment];
  } catch (error) {
    try {
      observeFailure?.("setup");
    } catch {
      /* Preserve the setup failure. */
    }
    return Promise.reject(error);
  }
  if (process.platform !== "win32" && supervisor)
    return runReservedProcess(
      request,
      signal,
      supervisor,
      observeFailure,
      lifecycle,
      adapters,
    );
  return runOwnedProcess(
    request,
    signal,
    observeFailure,
    lifecycle,
    undefined,
    adapters,
  );
}

async function runReservedProcess(
  request: ProcessRequest,
  signal: AbortSignal,
  supervisor: string,
  observeFailure?: ProcessFailureObserver,
  lifecycle?: ProcessLifecycleObserver,
  adapters: ProcessAdapters = {},
): Promise<string> {
  const notifyFailure = (category: ProcessFailureCategory) => {
    try {
      observeFailure?.(category);
    } catch {
      /* Failure observations cannot alter ownership. */
    }
  };
  let reservation;
  try {
    reservation = await reserveProcess(supervisor, signal);
  } catch (error) {
    notifyFailure(signal.aborted ? "cancelled" : "setup");
    throw error;
  }
  const cancellation = new AbortController();
  const cancelWork = () => cancellation.abort();
  signal.addEventListener("abort", cancelWork, { once: true });
  reservation.signal.addEventListener("abort", cancelWork, { once: true });
  if (signal.aborted || reservation.signal.aborted) cancelWork();
  let pid: number | undefined;
  let category: ProcessFailureCategory | undefined;
  let outcome: { ok: true; output: string } | { ok: false; error: unknown };
  try {
    const output = await runOwnedProcess(
      {
        ...request,
        env: {
          ...request.env,
          [processSupervisorEnvironment]: reservation.environment,
        },
      },
      cancellation.signal,
      (failure) => {
        category = failure;
      },
      lifecycle,
      (created) => {
        pid = created;
      },
      adapters,
    );
    outcome = { ok: true, output };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    signal.removeEventListener("abort", cancelWork);
    reservation.signal.removeEventListener("abort", cancelWork);
  }
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    if (pid === undefined) await reservation.cancelNoChild();
    else await reservation.completeJoinedChild(pid);
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }
  if (!outcome.ok || cleanupFailed) {
    notifyFailure(
      category === "cancelled" && !signal.aborted && reservation.signal.aborted
        ? "termination"
        : (category ?? "termination"),
    );
    if (!outcome.ok && cleanupFailed)
      throw new AggregateError(
        [outcome.error, cleanupFailure],
        "Process and ownership cleanup failed",
        { cause: outcome.error },
      );
    if (!outcome.ok) throw outcome.error;
    throw cleanupFailure;
  }
  return outcome.output;
}

function runOwnedProcess(
  request: ProcessRequest,
  signal: AbortSignal,
  observeFailure?: ProcessFailureObserver,
  lifecycle?: ProcessLifecycleObserver,
  created?: (pid: number | undefined) => void,
  adapters: ProcessAdapters = {},
): Promise<string> {
  const observe = (notify: () => void) => {
    try {
      notify();
    } catch {
      // Observations cannot change the owned process operation or its outcome.
    }
  };
  const rejected = (error: unknown, category: ProcessFailureCategory) => {
    try {
      observeFailure?.(category);
    } catch {
      // Evidence cannot replace the original rejection or change process work.
    }
    return error;
  };
  if (signal.aborted)
    return Promise.reject(rejected(new Error("Canceled"), "cancelled"));
  return new Promise((resolve, reject) => {
    let failAfterSpawn: ((error: unknown) => void) | undefined;
    try {
      const child = (adapters.spawn ?? spawn)(
        request.executable,
        request.args,
        {
          cwd: request.cwd,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          // Commands without a source snapshot need no parent-owned input pipe.
          // A fast child may close stdin before even an empty end reaches it.
          // The fourth pipe is the CLI's owner lifetime. It is never written
          // or ended here, so it reaches EOF only when this host exits,
          // including a crash that leaves no timer or cleanup to stop the CLI.
          stdio: [
            request.input === undefined ? "ignore" : "pipe",
            "pipe",
            "pipe",
            "pipe",
          ],
          env: {
            ...process.env,
            ...request.env,
            SALTBOX_LINT_EDITOR_PROCESS: "1",
            [processLifetimeEnvironment]: String(processLifetimeDescriptor),
          },
        },
      );
      created?.(child.pid);
      const output: Buffer[] = [];
      child.once("spawn", () => observe(() => lifecycle?.spawned?.(child.pid)));
      const errors: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let failureCategory: ProcessFailureCategory | undefined;
      let terminationFailed = false;
      let terminationFailure: unknown;
      let terminationDetails: TerminationObservation | undefined;
      const firstFailure = (error: Error, category: ProcessFailureCategory) => {
        failureCategory = category;
        return error;
      };
      const killTree = (phase: ProcessTerminationPhase) => {
        if (!child.pid) return;
        // Exit fields are set before Node emits exit. Keep the state from this
        // attempt: a later exit cannot qualify an earlier denied live abort.
        const nativeExitObserved =
          (typeof child.exitCode === "number" &&
            Number.isFinite(child.exitCode) &&
            Number.isInteger(child.exitCode) &&
            child.exitCode >= 0) ||
          (typeof child.signalCode === "string" && child.signalCode.length > 0);
        // Stop the owned child first. Its exit receipt admits the descendant
        // sweep, avoiding a zombie-only group before Node observes native exit.
        const childOnly = phase !== "exit" && !nativeExitObserved;
        const context: Readonly<ProcessTerminationContext> = Object.freeze({
          phase,
          target: childOnly ? child.pid : -child.pid,
          signal: "SIGKILL",
        });
        try {
          // Windows editor invocations self-assign to a kill-on-close Job before CLI work.
          if (process.platform === "win32") child.kill();
          else {
            const kill = childOnly ? adapters.killChild : adapters.killGroup;
            if (kill) kill.call(adapters, context);
            else process.kill(context.target, context.signal);
          }
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH" &&
            !terminationFailed
          ) {
            terminationFailed = true;
            terminationFailure = error;
            terminationDetails = terminationObservation(
              context,
              error,
              nativeExitObserved,
            );
          }
        }
      };
      const abort = () => {
        failure ??= firstFailure(new Error("Canceled"), "cancelled");
        killTree("abort");
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      child.on("error", (error) => {
        failure ??= firstFailure(error, "spawn");
      });
      child.stdin?.on("error", (error) => {
        failure ??= firstFailure(error, "stdin");
        killTree("stdin");
      });
      const collect = (chunks: Buffer[], data: Buffer) => {
        bytes += data.length;
        if (bytes > (request.maxBytes ?? 64 * 1024 * 1024)) {
          failure ??= firstFailure(
            new Error("Saltbox Lint output exceeds limit"),
            "output-limit",
          );
          killTree("output-limit");
        } else chunks.push(data);
      };
      // The child never writes to its lifetime pipe. Keep the parent end
      // flowing so its closure is joined by 'close', and never end it early.
      const lifetime: unknown = child.stdio?.[processLifetimeDescriptor];
      if (lifetime instanceof Readable) {
        lifetime.on("error", (error) => {
          failure ??= firstFailure(error, "setup");
          killTree("setup");
        });
        lifetime.resume();
      }
      child.stdout!.on("data", (data) => collect(output, data));
      child.stderr!.on("data", (data) => collect(errors, data));
      // 'exit' precedes 'close': kill remaining descendants before waiting for their pipes.
      child.once("exit", () => killTree("exit"));
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        observe(() => lifecycle?.closed?.(code, exitSignal));
        let outputText = "";
        if (!failure && errors.length)
          failure = firstFailure(
            new Error(Buffer.concat(errors).toString("utf8").trim()),
            "stderr",
          );
        else if (
          !failure &&
          !(request.successCodes ?? [0]).includes(code ?? -1)
        )
          failure = firstFailure(
            new Error(`Saltbox Lint exited with status ${code}`),
            "exit-status",
          );
        else if (!failure) {
          try {
            outputText = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(output),
            );
          } catch {
            failure = firstFailure(
              new Error("Saltbox Lint returned invalid UTF8"),
              "utf8",
            );
          }
        }
        let queryFailed = false;
        let queryFailure: unknown;
        const settle = () => {
          if (failure && terminationFailed)
            reject(
              rejected(
                new AggregateError(
                  [
                    failure,
                    terminationFailure,
                    ...(queryFailed ? [queryFailure] : []),
                  ],
                  `Process and process-group cleanup failed: ${JSON.stringify(terminationDetails)}`,
                  { cause: failure },
                ),
                failureCategory!,
              ),
            );
          else if (failure) reject(rejected(failure, failureCategory!));
          else if (terminationFailed)
            reject(
              rejected(
                queryFailed
                  ? new AggregateError(
                      [terminationFailure, queryFailure],
                      `Process-group cleanup and observation failed: ${JSON.stringify(terminationDetails)}`,
                      { cause: terminationFailure },
                    )
                  : terminationFailure,
                "termination",
              ),
            );
          else resolve(outputText);
        };
        // Darwin can deny a redundant signal after the child has already exited.
        // A cancellation after native exit can precede our exit listener too.
        // Require the fact at the failed attempt, closure and a fresh query.
        if (
          !terminationFailed ||
          !(
            terminationDetails?.phase === "exit" ||
            (terminationDetails?.phase === "abort" &&
              terminationDetails.nativeExitObserved)
          ) ||
          terminationDetails.code !== "EPERM" ||
          (adapters.platform ?? process.platform) !== "darwin"
        ) {
          settle();
          return;
        }
        const group = -terminationDetails.target;
        const cleanup = new AbortController();
        const cleanupTimer = setTimeout(
          () =>
            cleanup.abort(
              new Error("Process-group cleanup observation timed out"),
            ),
          1000,
        );
        const observeClosure = async () => {
          try {
            const live = await (
              adapters.groupHasLiveMembers ?? groupHasLiveMembers
            )(group, cleanup.signal);
            if (cleanup.signal.aborted) throw cleanup.signal.reason;
            if (live === false) terminationFailed = false;
            else if (live !== true)
              throw new Error("Unqualified process-group cleanup observation");
          } catch (error) {
            queryFailed = true;
            queryFailure = error;
          } finally {
            clearTimeout(cleanupTimer);
          }
          settle();
        };
        void observeClosure().catch((error: unknown) => {
          queryFailed = true;
          queryFailure = error;
          settle();
        });
      });
      failAfterSpawn = (error) => {
        failure ??= firstFailure(error as Error, "setup");
        killTree("setup");
      };
      timer = setTimeout(() => {
        failure ??= firstFailure(
          new Error("Saltbox Lint process timed out"),
          "timeout",
        );
        killTree("timeout");
      }, request.timeoutMs ?? 60000);
      signal.addEventListener("abort", abort, { once: true });
      child.stdin?.end(request.input ?? "", "utf8");
      if (signal.aborted) abort();
    } catch (error) {
      if (failAfterSpawn) failAfterSpawn(error);
      else reject(rejected(error, "setup"));
    }
  });
}
