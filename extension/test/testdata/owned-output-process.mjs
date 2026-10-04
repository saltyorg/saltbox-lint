import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { Worker } from "node:worker_threads";

const [record, parentToken, fd] = process.argv.slice(2);
const token = randomBytes(32).toString("hex");
const server = createServer((socket) => socket.end(token + "\n"));
server.listen(0, "127.0.0.1", () => {
  writeFileSync(
    record + ".writer.tmp",
    JSON.stringify({ pid: process.pid, port: server.address().port, token }),
  );
  renameSync(record + ".writer.tmp", record + ".writer");
  const writer = new Worker(
    new URL("owned-output-writer.mjs", import.meta.url),
    { workerData: { record, token: parentToken, fd: Number(fd) } },
  );
  writer.once("error", () => process.exit(7));
  writer.once("exit", (code) => process.exit(code));
});
