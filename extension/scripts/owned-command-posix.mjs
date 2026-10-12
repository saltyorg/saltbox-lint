// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{command: string, args: string[], cwd: string}} GuardianPayload
 * @typedef {'stop' | 'owner-loss'} GuardianStopReason
 * @typedef {{beforeReady?: () => Promise<void>, stopCurrentGroup?: (reason: GuardianStopReason) => void}} GuardianOptions
 * @typedef {{stop: () => void}} GuardianControl
 * @typedef {{message: string, code?: string, syscall?: string, path?: string}} GuardianError
 */

/** @param {unknown} error @returns {GuardianError} */
function errorRecord(error) {
  if (!(error instanceof Error))
    return { message: "guardian operation failed" };
  return {
    message: error.message,
    ...("code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
    ...("syscall" in error && typeof error.syscall === "string"
      ? { syscall: error.syscall }
      : {}),
    ...("path" in error && typeof error.path === "string"
      ? { path: error.path }
      : {}),
  };
}

/** Install lifetime control before readiness or payload admission. Native exit owns teardown. */
/** @param {GuardianOptions} [options] @returns {Promise<GuardianControl>} */
export async function runPosixGuardian({
  beforeReady,
  stopCurrentGroup = () => process.kill(0, "SIGKILL"),
} = {}) {
  assert.ok(process.platform === "linux" || process.platform === "darwin");
  assert.ok(
    process.send,
    "POSIX command guardian requires its parent IPC channel",
  );
  let ready = false;
  let admitted = false;
  let sealed = false;
  /** @param {object} message @returns {Promise<void>} */
  const send = (message) =>
    new Promise((resolveSent, reject) => {
      if (!process.send || !process.connected) {
        reject(new Error("guardian owner channel is closed"));
        return;
      }
      /** @param {Error | null} error */
      const completed = (error) => (error ? reject(error) : resolveSent());
      process.send(message, completed);
    });
  /** @param {GuardianStopReason} reason */
  const stop = (reason) => {
    sealed = true;
    try {
      // 0 addresses this live process's CURRENT group, never a recorded PID.
      stopCurrentGroup(reason);
    } catch (error) {
      if (process.connected) {
        send({ type: "stop-error", error: errorRecord(error) }).catch(() => {});
      }
    }
  };
  /** @param {object} message */
  const report = (message) => {
    send(message).catch(() => stop("owner-loss"));
  };
  process.on("disconnect", () => stop("owner-loss"));
  process.on("message", (message) => {
    try {
      assert.ok(message && typeof message === "object" && "type" in message);
      if (message.type === "stop") {
        assert.deepEqual(Object.keys(message), ["type"]);
        stop("stop");
        return;
      }
      assert.equal(message.type, "start");
      assert.deepEqual(Object.keys(message).sort(), ["payload", "type"]);
      assert.ok(
        ready && !admitted && !sealed,
        "guardian payload admission is sealed",
      );
      assert.ok(
        "payload" in message &&
          message.payload &&
          typeof message.payload === "object",
      );
      const payload = message.payload;
      assert.deepEqual(Object.keys(payload).sort(), ["args", "command", "cwd"]);
      assert.ok("command" in payload && typeof payload.command === "string");
      assert.ok("cwd" in payload && typeof payload.cwd === "string");
      assert.ok(
        "args" in payload &&
          Array.isArray(payload.args) &&
          payload.args.every((argument) => typeof argument === "string"),
      );
      admitted = true;
      const child = spawn(payload.command, payload.args, {
        cwd: payload.cwd,
        env: process.env,
        shell: false,
        detached: false,
        // Payload stdin retains the former ignored-input/EOF contract. Output
        // inherits the exact guardian descriptors, including blocked pipes.
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", (error) =>
        report({ type: "payload-error", error: errorRecord(error) }),
      );
      child.once("close", (code, signal) => {
        report({ type: "payload-exit", code, signal });
        // Keep the group leader alive until the live parent orders group stop.
      });
    } catch (error) {
      report({ type: "guardian-error", error: errorRecord(error) });
      sealed = true;
    }
  });
  if (!process.connected) {
    stop("owner-loss");
    return { stop: () => stop("stop") };
  }
  try {
    await beforeReady?.();
    if (!sealed && process.connected) {
      ready = true;
      await send({ type: "ready" });
    }
  } catch (error) {
    report({ type: "guardian-error", error: errorRecord(error) });
    stop("owner-loss");
  }
  return { stop: () => stop("stop") };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runPosixGuardian();
