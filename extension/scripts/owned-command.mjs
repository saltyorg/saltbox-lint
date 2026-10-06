import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { groupHasLiveMembers } from "./owned-group.mjs";

// Build checks and release probes own their command and its descendants. Keep
// the deadline active until captured stdio closes. Inherited output belongs to the
// owned child, so blocked writes and consumer errors cannot strand this owner.
export function ownedCommand(
  command,
  args,
  {
    phase,
    timeoutMs,
    signal,
    returnExitCode = false,
    retainOutputOnError = false,
    maxOutputBytes = 1024 * 1024,
    ...options
  },
) {
  return new Promise((resolveResult, reject) => {
    const windows = process.platform === "win32";
    const payload = Buffer.from(
      JSON.stringify({
        command,
        args,
        cwd: resolve(options.cwd ?? process.cwd()),
      }),
    ).toString("base64");
    const launcher = windows ? "pwsh.exe" : command;
    const launchArgs = windows
      ? [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(new URL("owned-command-windows.ps1", import.meta.url)),
          payload,
        ]
      : args;
    const inherited = options.stdio === "inherit";
    const child = spawn(launcher, launchArgs, {
      ...options,
      // Never forward inherited logs through process.stdout/stderr. Node keeps
      // their blocked handles open even after destroy(). The owned group/Job
      // can terminate writers and their descendants without a pending owner write.
      stdio: [
        windows ? "pipe" : "ignore",
        inherited ? "inherit" : "pipe",
        inherited ? "inherit" : "pipe",
      ],
      shell: false,
      detached: !windows,
      windowsHide: true,
    });
    const identity = `${phase}: ${JSON.stringify([command, ...args])} (owned ${windows ? "Job launcher " : ""}PID ${child.pid ?? "not started"})`;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure;
    let cleanupFailure;
    let cleanupTimer;
    let reapTimer;
    let groupTimer;
    let groupKilled = false;
    let groupGone = windows;
    const observation = new AbortController();
    let activeObservation;
    let closed;
    let settled = false;
    let cleanupStarted = false;
    const failCleanup = (message, cause) => {
      const error = new Error(`${identity}: ${message}`, { cause });
      // The command's exit failure may arrive after cleanup starts. Keep
      // cleanup separate until the final command result is assembled.
      cleanupFailure = cleanupFailure
        ? new AggregateError(
            [cleanupFailure, error],
            `${cleanupFailure.message}; ${error.message}`,
            { cause: cleanupFailure },
          )
        : error;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(cleanupTimer);
      clearTimeout(reapTimer);
      clearTimeout(groupTimer);
      observation.abort();
      signal?.removeEventListener("abort", onAbort);
      child.stdin?.destroy();
      if (
        !error &&
        closed &&
        closed.code !== 0 &&
        !(returnExitCode && closed.code !== null)
      ) {
        const { code, signal } = closed;
        error = new Error(`${identity}: exited ${code ?? signal}\n${stderr}`);
        error.exitCode = code;
        error.stderr = stderr;
      }
      const primaryError = error;
      if (cleanupFailure) {
        error = error
          ? new AggregateError(
              [error, cleanupFailure],
              `${error.message}; ${cleanupFailure.message}`,
              { cause: error },
            )
          : cleanupFailure;
      }
      // Optional failure evidence uses the same bounded capture as successful
      // output. Preserve primary/cleanup causes and leave other callers' error
      // properties unchanged. Inherited stdio has no captured output.
      if (error && retainOutputOnError && !inherited) {
        error.stdout = stdout;
        error.stderr = stderr;
        if (primaryError?.exitCode !== undefined)
          error.exitCode = primaryError.exitCode;
      }
      const settle = () => {
        if (error) reject(error);
        else resolveResult(returnExitCode ? closed.code : stdout);
      };
      // Cancellation must also join our short-lived read-only ps probe.
      if (activeObservation) activeObservation.then(settle, settle);
      else settle();
    };
    const killGroup = () => {
      if (!child.pid || groupKilled) return;
      groupKilled = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH")
          failCleanup(`owned group cleanup failed: ${error}`, error);
      }
      observeGroup();
    };
    const complete = () => {
      if (!closed || !groupGone) return;
      finish(failure);
    };
    const observeGroup = async () => {
      // SIGKILL queues termination. Observe the owned group's disappearance
      // before settling inherited output, which has no captured EOF to join.
      try {
        activeObservation = groupHasLiveMembers(child.pid, observation.signal);
        const live = await activeObservation;
        if (settled) return;
        if (live) groupTimer = setTimeout(observeGroup, 10);
        else {
          groupGone = true;
          complete();
        }
      } catch (error) {
        if (!settled) {
          failCleanup(`owned group observation failed: ${error}`, error);
          cleanup();
        }
      } finally {
        activeObservation = undefined;
      }
    };
    const cleanup = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (windows) child.stdin.end("stop\n");
      else killGroup();
      cleanupTimer = setTimeout(() => {
        // On Windows this signals the exact launcher process handle. Closing
        // its Job handle kills all members even after the direct command exits.
        child.kill("SIGKILL");
        reapTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          failCleanup(
            `${groupGone ? "stdio did not close" : "owned group did not disappear"} after owned cleanup`,
          );
          finish(failure);
        }, 5000);
      }, 7000);
    };
    const onAbort = () => {
      failure ??= new Error(`${identity}: interrupted by owner`, {
        cause: signal.reason,
      });
      cleanup();
    };
    const deadline =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            failure ??= new Error(
              `${identity}: timed out after ${timeoutMs}ms`,
            );
            cleanup();
          }, timeoutMs);
    const collect = (data, stream) => {
      outputBytes += Buffer.byteLength(data);
      // Release callers retain their original bound. Source discovery opts in
      // to a larger explicit bound and never consumes a truncated result.
      if (outputBytes > maxOutputBytes) {
        const bound =
          maxOutputBytes === 1024 * 1024 ? "1 MiB" : `${maxOutputBytes} bytes`;
        failure ??= new Error(`${identity}: output exceeds ${bound}`);
        cleanup();
        return;
      }
      if (stream === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdin?.on("error", (error) => {
      if (error.code !== "EPIPE")
        failure ??= new Error(
          `${identity}: owned control pipe failed: ${error}`,
        );
    });
    if (!inherited) {
      child.stdout
        .setEncoding("utf8")
        .on("data", (data) => collect(data, "stdout"));
      child.stderr
        .setEncoding("utf8")
        .on("data", (data) => collect(data, "stderr"));
    }
    child.once("error", (error) =>
      finish(new Error(`${identity}: ${error.message}`, { cause: error })),
    );
    child.once("exit", () => {
      if (!windows) cleanup();
    });
    child.once("close", (code, signal) => {
      closed = { code, signal };
      complete();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
