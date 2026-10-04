import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Release probes own only the process they start and its descendants. Keep the
// deadline active until stdio closes, since a descendant can retain its pipes.
export function ownedCommand(command, args, { phase, timeoutMs, ...options }) {
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
      // Retain ownership of the output pipes even when forwarding build logs,
      // so descendant pipes must close before this command can finish.
      stdio: [windows ? "pipe" : "ignore", "pipe", "pipe"],
      shell: false,
      detached: !windows,
      windowsHide: true,
    });
    const identity = `${phase}: ${JSON.stringify([command, ...args])} (owned ${windows ? "Job launcher " : ""}PID ${child.pid ?? "not started"})`;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure;
    let cleanupTimer;
    let reapTimer;
    let settled = false;
    let cleanupStarted = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(cleanupTimer);
      clearTimeout(reapTimer);
      child.stdin?.destroy();
      if (error) reject(error);
      else resolveResult(stdout);
    };
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH")
          failure = new Error(
            `${identity}: owned group cleanup failed: ${error}`,
            { cause: failure ?? error },
          );
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
          finish(
            new Error(`${identity}: stdio did not close after owned cleanup`, {
              cause: failure,
            }),
          );
        }, 5000);
      }, 7000);
    };
    const deadline = setTimeout(() => {
      failure = new Error(`${identity}: timed out after ${timeoutMs}ms`);
      cleanup();
    }, timeoutMs);
    const collect = (data, stream) => {
      outputBytes += Buffer.byteLength(data);
      // Preserve spawnSync's previous default capture bound.
      if (outputBytes > 1024 * 1024) {
        failure ??= new Error(`${identity}: output exceeds 1 MiB`);
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
    if (inherited) {
      child.stdout.pipe(process.stdout, { end: false });
      child.stderr.pipe(process.stderr, { end: false });
    } else {
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
      if (!windows) killGroup();
    });
    child.once("close", (code, signal) => {
      if (failure) finish(failure);
      else if (code !== 0)
        finish(new Error(`${identity}: exited ${code ?? signal}\n${stderr}`));
      else finish();
    });
  });
}
