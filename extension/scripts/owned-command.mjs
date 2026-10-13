// @ts-check
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { groupHasLiveMembers } from "./owned-group.mjs";

/**
 * @typedef {import('node:child_process').SpawnOptions & {cwd?: string, phase: string, timeoutMs?: number, signal?: AbortSignal, returnExitCode?: boolean, captureOutput?: boolean, retainOutputOnError?: boolean, maxOutputBytes?: number}} OwnedCommandOptions
 * @typedef {Error & {exitCode?: number | null, stdout?: string, stderr?: string, ownershipReleased?: boolean}} CommandError
 * @typedef {{code: number | null, signal: NodeJS.Signals | null}} ClosedCommand
 * @typedef {{stdout: string, stderr: string}} CommandOutput
 * @typedef {{guardianPath?: string, sendMessage?: (child: import('node:child_process').ChildProcess, message: object, completed: (error: Error | null) => void) => void, onSpawn?: (child:import('node:child_process').ChildProcess)=>void}} OwnedCommandDependencies
 */

// Build checks and release probes own their command and its descendants. Keep
// the deadline active until captured stdio closes. Inherited output belongs to the
// owned child, so blocked writes and consumer errors cannot strand this owner.
/** @overload @param {string} command @param {string[]} args @param {OwnedCommandOptions & {returnExitCode: true, captureOutput?: false}} options @param {OwnedCommandDependencies} [dependencies] @returns {Promise<number | null>} */
/** @overload @param {string} command @param {string[]} args @param {OwnedCommandOptions & {captureOutput: true, returnExitCode?: false}} options @param {OwnedCommandDependencies} [dependencies] @returns {Promise<CommandOutput>} */
/** @overload @param {string} command @param {string[]} args @param {OwnedCommandOptions & {returnExitCode?: false, captureOutput?: false}} options @param {OwnedCommandDependencies} [dependencies] @returns {Promise<string>} */
/** @overload @param {string} command @param {string[]} args @param {OwnedCommandOptions} options @param {OwnedCommandDependencies} [dependencies] @returns {Promise<string | number | null | CommandOutput>} */
/** @param {string} command @param {string[]} args @param {OwnedCommandOptions & {captureOutput?: boolean}} options @param {OwnedCommandDependencies} [dependencies] @returns {Promise<string | number | null | CommandOutput>} */
export function ownedCommand(
  command,
  args,
  {
    phase,
    timeoutMs,
    signal,
    returnExitCode = false,
    captureOutput = false,
    retainOutputOnError = false,
    maxOutputBytes = 1024 * 1024,
    ...options
  },
  {
    guardianPath = fileURLToPath(
      new URL("owned-command-posix.mjs", import.meta.url),
    ),
    sendMessage = (child, message, completed) => {
      child.send(message, completed);
    },
    onSpawn,
  } = {},
) {
  return new Promise((resolveResult, reject) => {
    if (captureOutput && (returnExitCode || options.stdio === "inherit")) {
      reject(
        new Error(
          "Captured output requires captured pipes and the default exit result",
        ),
      );
      return;
    }
    const windows = process.platform === "win32";
    const specification = {
      command,
      args,
      cwd: resolve(options.cwd ?? process.cwd()),
    };
    const payload = Buffer.from(JSON.stringify(specification)).toString(
      "base64",
    );
    const launcher = windows ? "pwsh.exe" : process.execPath;
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
      : [guardianPath];
    const inherited = options.stdio === "inherit";
    /** @type {Exclude<import('node:child_process').StdioOptions, string>} */
    const stdio = [
      windows ? "pipe" : "ignore",
      inherited ? "inherit" : "pipe",
      inherited ? "inherit" : "pipe",
    ];
    if (!windows) stdio.push("ipc");
    const child = spawn(launcher, launchArgs, {
      ...options,
      // Never forward inherited logs through process.stdout/stderr. Node keeps
      // their blocked handles open even after destroy(). The owned group/Job
      // can terminate writers and their descendants without a pending owner write.
      stdio,
      shell: false,
      detached: !windows,
      windowsHide: true,
    });
    const identity = `${phase}: ${JSON.stringify([command, ...args])} (owned ${windows ? "Job launcher " : ""}PID ${child.pid ?? "not started"})`;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    /** @type {CommandError | undefined} */
    let failure;
    /** @type {CommandError | undefined} */
    let cleanupFailure;
    /** @type {NodeJS.Timeout | undefined} */
    let cleanupTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let reapTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let groupTimer;
    let groupGone = windows;
    const observation = new AbortController();
    /** @type {Promise<boolean> | undefined} */
    let activeObservation;
    /** @type {ClosedCommand | undefined} */
    let closed;
    /** @type {ClosedCommand | undefined} */
    let nativeExit;
    let ipcClosed = windows;
    /** @type {Set<import('node:stream').Readable | import('node:stream').Writable>} */
    const pendingStreams = new Set();
    /** @type {Promise<void>[]} */
    const streamClosures = [];
    /** @type {ClosedCommand | undefined} */
    let payloadStatus;
    /** @type {Set<Promise<void>>} */
    const controlWrites = new Set();
    let ready = false;
    let settled = false;
    let cleanupStarted = false;
    /** @param {string} message @param {unknown} [cause] */
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
    /** @param {CommandError} [error] */
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
      const settle = () => {
        error ??= failure;
        if (
          !error &&
          (windows ? closed : payloadStatus) &&
          (windows ? closed : payloadStatus)?.code !== 0 &&
          !(returnExitCode && (windows ? closed : payloadStatus)?.code !== null)
        ) {
          const { code, signal } = /** @type {ClosedCommand} */ (
            windows ? closed : payloadStatus
          );
          error = new Error(`${identity}: exited ${code ?? signal}\n${stderr}`);
          error.exitCode = code;
          error.stderr = stderr;
        }
        if (!error && !windows && !payloadStatus)
          error = new Error(
            `${identity}: guardian exited before payload completion (${closed?.code ?? closed?.signal})\n${stderr}`,
          );
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
        if (error) {
          // Callers may remove owned run directories only after the command tree
          // and stdio have closed without an inconclusive cleanup observation.
          error.ownershipReleased = Boolean(
            closed && groupGone && !cleanupFailure,
          );
        }
        if (error) reject(error);
        else if (closed)
          resolveResult(
            captureOutput
              ? { stdout, stderr }
              : returnExitCode
                ? ((windows ? closed : payloadStatus)?.code ?? null)
                : stdout,
          );
        else reject(new Error(`${identity}: missing native close result`));
      };
      // Cancellation must also join our short-lived read-only ps probe.
      Promise.allSettled([
        ...controlWrites,
        ...streamClosures,
        ...(activeObservation ? [activeObservation] : []),
      ]).then(settle, settle);
    };
    /** @param {object} message */
    const sendControl = (message) => {
      /** @type {Promise<void>} */
      const written = new Promise((resolveWritten) => {
        if (!child.connected) {
          resolveWritten();
          return;
        }
        let completed = false;
        /** @param {Error | null} error */
        const completion = (error) => {
          if (completed) return;
          completed = true;
          if (error) {
            if ("type" in message && message.type === "start") {
              failure ??= new Error(
                `${identity}: guardian control write failed`,
                { cause: error },
              );
              cleanup();
            } else if (child.exitCode === null && child.signalCode === null) {
              failCleanup("owned group control write failed", error);
            }
          }
          resolveWritten();
        };
        try {
          sendMessage(child, message, completion);
        } catch (error) {
          completion(
            error instanceof Error
              ? error
              : new Error("guardian control write failed", { cause: error }),
          );
        }
      });
      const joined = written.then(() => {
        controlWrites.delete(joined);
      });
      controlWrites.add(joined);
    };
    const complete = () => {
      if (!closed || !groupGone) return;
      finish(failure);
    };
    const joinNativeResources = () => {
      // Node24.20 can omit composite close after send() on a disconnected IPC
      // channel. These are the actual public native-exit and handle-close
      // receipts, independent of that notification's internal accounting.
      if (nativeExit && ipcClosed && pendingStreams.size === 0) {
        closed = nativeExit;
        complete();
      }
    };
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (!stream || stream.closed) continue;
      pendingStreams.add(stream);
      streamClosures.push(
        new Promise((resolveClosed) =>
          stream.once("close", () => {
            pendingStreams.delete(stream);
            resolveClosed();
            joinNativeResources();
          }),
        ),
      );
    }
    if (!windows)
      child.once("disconnect", () => {
        ipcClosed = true;
        joinNativeResources();
      });
    const observeGroup = async () => {
      // SIGKILL queues termination. Observe the owned group's disappearance
      // before settling inherited output, which has no captured EOF to join.
      try {
        if (!child.pid)
          throw new Error("owned command has no native process identity");
        activeObservation = groupHasLiveMembers(child.pid, observation.signal);
        const live = await activeObservation;
        if (settled) return;
        if (live)
          groupTimer = setTimeout(() => {
            observeGroup().catch((error) => {
              failCleanup(`owned group observation failed: ${error}`, error);
              cleanup();
            });
          }, 10);
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
      if (windows) child.stdin?.end("stop\n");
      else sendControl({ type: "stop" });
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
        cause: signal?.reason,
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
    /** @param {string} data @param {'stdout' | 'stderr'} stream */
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
      if (!("code" in error && error.code === "EPIPE"))
        failure ??= new Error(
          `${identity}: owned control pipe failed: ${error}`,
        );
    });
    if (!inherited) {
      child.stdout
        ?.setEncoding("utf8")
        .on("data", (data) => collect(data, "stdout"));
      child.stderr
        ?.setEncoding("utf8")
        .on("data", (data) => collect(data, "stderr"));
    }
    child.once("error", (error) => {
      failure ??= new Error(`${identity}: ${error.message}`, { cause: error });
      if (!child.pid) groupGone = true;
    });
    /** @param {unknown} message */
    const receiveGuardian = (message) => {
      try {
        if (!message || typeof message !== "object" || !("type" in message))
          throw new Error("invalid guardian message");
        if (message.type === "ready") {
          if (ready || Object.keys(message).length !== 1)
            throw new Error("duplicate guardian readiness");
          ready = true;
          if (!cleanupStarted)
            sendControl({ type: "start", payload: specification });
        } else if (message.type === "payload-exit") {
          if (
            payloadStatus ||
            !("code" in message) ||
            !("signal" in message) ||
            !(
              message.code === null ||
              (typeof message.code === "number" &&
                Number.isSafeInteger(message.code))
            ) ||
            !(message.signal === null || typeof message.signal === "string")
          )
            throw new Error("invalid payload status");
          payloadStatus = {
            code: message.code,
            signal: /** @type {NodeJS.Signals | null} */ (message.signal),
          };
          cleanup();
        } else {
          if (
            !("error" in message) ||
            !message.error ||
            typeof message.error !== "object" ||
            !("message" in message.error) ||
            typeof message.error.message !== "string"
          )
            throw new Error("invalid guardian failure");
          const cause = new Error(message.error.message);
          for (const key of ["code", "syscall", "path"]) {
            const value = Reflect.get(message.error, key);
            if (typeof value === "string")
              Object.assign(cause, { [key]: value });
          }
          if (message.type === "stop-error")
            failCleanup(`owned group cleanup failed: ${cause.message}`, cause);
          else if (
            message.type === "payload-error" ||
            message.type === "guardian-error"
          ) {
            failure ??= new Error(`${identity}: ${cause.message}`, { cause });
            cleanup();
          } else throw new Error("unexpected guardian message");
        }
      } catch (error) {
        failure ??= new Error(`${identity}: guardian protocol failed`, {
          cause: error,
        });
        cleanup();
      }
    };
    if (!windows) child.on("message", receiveGuardian);
    child.once("exit", (code, signal) => {
      nativeExit = { code, signal };
      joinNativeResources();
      if (!windows) {
        cleanup();
        observeGroup().catch((error) => {
          failCleanup(`owned group observation failed: ${error}`, error);
        });
      }
    });
    child.once("close", (code, signal) => {
      closed = { code, signal };
      complete();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    // Observe the actual owner only after every native lifetime fence is owned.
    // Windows may already have admitted its payload; this is a post-spawn seam.
    if (onSpawn) {
      try {
        onSpawn(child);
      } catch (error) {
        failure ??= new Error(`${identity}: owner observation failed`, {
          cause: error,
        });
        cleanup();
      }
    }
    if (signal?.aborted) onAbort();
  });
}
