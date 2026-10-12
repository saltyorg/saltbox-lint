import { spawn } from "node:child_process";
import {
  processSupervisorEnvironment,
  reserveProcess,
} from "./process-reservation.ts";
import type {
  ProcessFailureCategory,
  ProcessFailureObserver,
} from "./process-failure.ts";
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
/** Own the process tree until exit, including descendants retaining output pipes. */
export function runProcess(
  request: ProcessRequest,
  signal: AbortSignal,
  observeFailure?: ProcessFailureObserver,
  lifecycle?: ProcessLifecycleObserver,
): Promise<string> {
  if (signal.aborted)
    return runOwnedProcess(request, signal, observeFailure, lifecycle);
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
    );
  return runOwnedProcess(request, signal, observeFailure, lifecycle);
}

async function runReservedProcess(
  request: ProcessRequest,
  signal: AbortSignal,
  supervisor: string,
  observeFailure?: ProcessFailureObserver,
  lifecycle?: ProcessLifecycleObserver,
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
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        // Commands without a source snapshot need no parent-owned input pipe.
        // A fast child may close stdin before even an empty end reaches it.
        stdio: [
          request.input === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
        env: {
          ...process.env,
          ...request.env,
          SALTBOX_LINT_EDITOR_PROCESS: "1",
        },
      });
      created?.(child.pid);
      const output: Buffer[] = [];
      child.once("spawn", () => observe(() => lifecycle?.spawned?.(child.pid)));
      const errors: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let failureCategory: ProcessFailureCategory | undefined;
      let terminationFailed = false;
      let terminationFailure: unknown;
      const firstFailure = (error: Error, category: ProcessFailureCategory) => {
        failureCategory = category;
        return error;
      };
      const killTree = () => {
        if (!child.pid) return;
        try {
          // Windows editor invocations self-assign to a kill-on-close Job before CLI work.
          if (process.platform === "win32") child.kill();
          else process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH" &&
            !terminationFailed
          ) {
            terminationFailed = true;
            terminationFailure = error;
          }
        }
      };
      const abort = () => {
        failure ??= firstFailure(new Error("Canceled"), "cancelled");
        killTree();
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      child.on("error", (error) => {
        failure ??= firstFailure(error, "spawn");
      });
      child.stdin?.on("error", (error) => {
        failure ??= firstFailure(error, "stdin");
        killTree();
      });
      const collect = (chunks: Buffer[], data: Buffer) => {
        bytes += data.length;
        if (bytes > (request.maxBytes ?? 64 * 1024 * 1024)) {
          failure ??= firstFailure(
            new Error("Saltbox Lint output exceeds limit"),
            "output-limit",
          );
          killTree();
        } else chunks.push(data);
      };
      child.stdout!.on("data", (data) => collect(output, data));
      child.stderr!.on("data", (data) => collect(errors, data));
      // 'exit' precedes 'close': kill remaining descendants before waiting for their pipes.
      child.once("exit", killTree);
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
        if (failure && terminationFailed)
          reject(
            rejected(
              new AggregateError(
                [failure, terminationFailure],
                "Process and process-group cleanup failed",
                { cause: failure },
              ),
              failureCategory!,
            ),
          );
        else if (failure) reject(rejected(failure, failureCategory!));
        else if (terminationFailed)
          reject(rejected(terminationFailure, "termination"));
        else resolve(outputText);
      });
      failAfterSpawn = (error) => {
        failure ??= firstFailure(error as Error, "setup");
        killTree();
      };
      timer = setTimeout(() => {
        failure ??= firstFailure(
          new Error("Saltbox Lint process timed out"),
          "timeout",
        );
        killTree();
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
