import { spawn } from "node:child_process";
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
}
/** Own the process tree until exit, including descendants retaining output pipes. */
export function runProcess(
  request: ProcessRequest,
  signal: AbortSignal,
  observeFailure?: ProcessFailureObserver,
): Promise<string> {
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
        env: { ...process.env, SALTBOX_LINT_EDITOR_PROCESS: "1" },
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let failureCategory: ProcessFailureCategory | undefined;
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
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            failure ??= firstFailure(error as Error, "termination");
        }
      };
      const abort = () => {
        failure ??= firstFailure(new Error("Canceled"), "cancelled");
        killTree();
      };
      const timer = setTimeout(() => {
        failure ??= firstFailure(
          new Error("Saltbox Lint process timed out"),
          "timeout",
        );
        killTree();
      }, request.timeoutMs ?? 60000);
      signal.addEventListener("abort", abort, { once: true });
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
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure) reject(rejected(failure, failureCategory!));
        else if (errors.length)
          reject(
            rejected(
              new Error(Buffer.concat(errors).toString("utf8").trim()),
              "stderr",
            ),
          );
        else if (!(request.successCodes ?? [0]).includes(code ?? -1))
          reject(
            rejected(
              new Error(`Saltbox Lint exited with status ${code}`),
              "exit-status",
            ),
          );
        else {
          try {
            resolve(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(output),
              ),
            );
          } catch {
            reject(
              rejected(new Error("Saltbox Lint returned invalid UTF8"), "utf8"),
            );
          }
        }
      });
      child.stdin?.end(request.input ?? "", "utf8");
      if (signal.aborted) abort();
    } catch (error) {
      reject(rejected(error, "setup"));
    }
  });
}
