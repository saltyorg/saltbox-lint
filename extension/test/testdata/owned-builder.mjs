import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const [mode, record] = process.argv.slice(2);
const token = randomBytes(32).toString("hex");
for (const name of ["stdout", "stderr"])
  process[name].on("error", () => process.exit(7));
const server = createServer((socket) => {
  if (mode === "output-tree" || mode === "output-exit") {
    socket.once("data", (data) => {
      const output = data.toString().trim();
      if (output === "exit") process.exit(0);
      else if (process.platform === "win32") {
        // Windows inherited pipes block synchronous writes. Keep this control
        // endpoint responsive while an owned worker performs the real write.
        const writer = new Worker(
          new URL("owned-output-writer.mjs", import.meta.url),
          { workerData: { record, token, fd: output === "stdout" ? 1 : 2 } },
        );
        writer.once("error", () => process.exit(7));
        writer.once("exit", (code) => {
          if (code !== 0) process.exit(7);
        });
      } else {
        const status = (pending) => {
          writeFileSync(
            record + ".pending.tmp",
            JSON.stringify({ token, pending }),
          );
          renameSync(record + ".pending.tmp", record + ".pending");
        };
        process[output].write(Buffer.alloc(16 * 1024 * 1024, "x"), () =>
          status(false),
        );
        status(true);
      }
    });
  }
  if (mode === "exit" || mode === "error-exit") {
    socket.once("data", () => process.exit(mode === "error-exit" ? 7 : 0));
  }
  socket.end(token + "\n");
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(
    record + ".tmp",
    JSON.stringify({ pid: process.pid, port: server.address().port, token }),
  );
  renameSync(record + ".tmp", record);
  if (
    ["tree", "exit", "error-exit", "output-tree", "output-exit"].includes(mode)
  )
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "child", record + ".child"],
      {
        stdio: "inherit",
      },
    );
});
