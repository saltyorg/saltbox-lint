// @ts-check
import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { runPosixGuardian } from "../../scripts/owned-command-posix.mjs";

const filename = process.env.SALTBOX_TEST_GUARDIAN_RECORD;
const token = process.env.SALTBOX_TEST_GUARDIAN_NONCE;
assert.ok(filename && token && /^[a-f0-9]{64}$/.test(token));
let refusing = true;
let pendingStop = false;
let refusals = 0;
/** @type {import("../../scripts/owned-command-posix.mjs").GuardianControl | undefined} */
let control;
const release = () => {
  refusing = false;
  if (control) control.stop();
  else pendingStop = true;
};
const server = createServer((socket) => {
  let request = "";
  socket.on("error", () => socket.destroy());
  socket.on("data", (bytes) => {
    request += bytes.toString("ascii");
    if (request.length > 80) {
      socket.destroy();
      return;
    }
    if (!request.endsWith("\n")) return;
    if (request === `probe ${token}\n`) {
      socket.end(token + "\n");
      return;
    }
    if (request !== `release ${token}\n`) {
      socket.end("invalid credential\n");
      return;
    }
    // Finish the authenticated acknowledgement before stopping our own group.
    socket.once("close", release);
    socket.end(token + "\n");
  });
});

control = await runPosixGuardian({
  beforeReady: async () => {
    /** @type {Promise<void>} */
    const listening = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(
      filename + ".tmp",
      JSON.stringify({ pid: process.pid, port: address.port, token }),
    );
    renameSync(filename + ".tmp", filename);
  },
  stopCurrentGroup(reason) {
    if (refusing && reason === "stop") {
      writeFileSync(
        filename + ".refused.tmp",
        JSON.stringify({ pid: process.pid, token, refusals: ++refusals }),
      );
      renameSync(filename + ".refused.tmp", filename + ".refused");
      throw Object.assign(new Error("kill EPERM control"), {
        code: "EPERM",
        syscall: "kill",
      });
    }
    process.kill(0, "SIGKILL");
  },
});
if (pendingStop) control.stop();
