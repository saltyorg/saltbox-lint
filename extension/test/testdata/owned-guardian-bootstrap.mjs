// @ts-check
import assert from "node:assert/strict";
import { connect } from "node:net";
import { runPosixGuardian } from "../../scripts/owned-command-posix.mjs";

const input = JSON.parse(
  process.env.SALTBOX_GUARDIAN_BOOTSTRAP_CONTROL ?? "null",
);
assert.ok(
  input && typeof input.port === "number" && typeof input.token === "string",
);
await runPosixGuardian({
  beforeReady: () =>
    new Promise(() => {
      const socket = connect({ host: "127.0.0.1", port: input.port }, () => {
        socket.write(
          JSON.stringify({
            token: input.token,
            pid: process.pid,
            group: process.pid,
          }) + "\n",
        );
      });
      let buffer = "";
      // This separate authenticated lifetime lets the regression safely clean a
      // deliberately broken guardian, without signaling a recorded numeric PID.
      socket.on("data", (data) => {
        buffer += data;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const control = JSON.parse(buffer.slice(0, newline));
        if (control.token === input.token && control.stop === true)
          process.kill(0, "SIGKILL");
      });
      socket.on("close", () => process.kill(0, "SIGKILL"));
      socket.on("error", () => process.kill(0, "SIGKILL"));
    }),
});
