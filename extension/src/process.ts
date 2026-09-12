import { spawn } from "node:child_process";
export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  input?: string;
  successCodes?: number[];
  timeoutMs?: number;
  maxBytes?: number;
}
/** Own the process tree until exit, including descendants retaining output pipes. */
export function runProcess(
  request: ProcessRequest,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error("Canceled"));
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SALTBOX_LINT_EDITOR_PROCESS: "1" },
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const killTree = () => {
      if (!child.pid) return;
      try {
        // Windows editor invocations self-assign to a kill-on-close Job before CLI work.
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          failure ??= error as Error;
      }
    };
    const abort = () => {
      failure ??= new Error("Canceled");
      killTree();
    };
    const timer = setTimeout(() => {
      failure ??= new Error("Saltbox Lint process timed out");
      killTree();
    }, request.timeoutMs ?? 60000);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
      killTree();
    });
    const collect = (chunks: Buffer[], data: Buffer) => {
      bytes += data.length;
      if (bytes > (request.maxBytes ?? 64 * 1024 * 1024)) {
        failure ??= new Error("Saltbox Lint output exceeds limit");
        killTree();
      } else chunks.push(data);
    };
    child.stdout.on("data", (data) => collect(output, data));
    child.stderr.on("data", (data) => collect(errors, data));
    // 'exit' precedes 'close': kill remaining descendants before waiting for their pipes.
    child.once("exit", killTree);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (errors.length)
        reject(new Error(Buffer.concat(errors).toString("utf8").trim()));
      else if (!(request.successCodes ?? [0]).includes(code ?? -1))
        reject(new Error(`Saltbox Lint exited with status ${code}`));
      else {
        try {
          resolve(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(output),
            ),
          );
        } catch {
          reject(new Error("Saltbox Lint returned invalid UTF8"));
        }
      }
    });
    child.stdin.end(request.input ?? "", "utf8");
    if (signal.aborted) abort();
  });
}
