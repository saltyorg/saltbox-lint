import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const [mode, record] = process.argv.slice(2);
const token = randomBytes(32).toString("hex");
const server = createServer((socket) => {
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
  if (["tree", "exit", "error-exit"].includes(mode))
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "child", record + ".child"],
      {
        stdio: "inherit",
      },
    );
});
