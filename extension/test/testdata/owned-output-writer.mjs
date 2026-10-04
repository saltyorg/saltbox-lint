import { renameSync, writeFileSync, writeSync } from "node:fs";
import { workerData } from "node:worker_threads";

const { record, token, fd } = workerData;
const status = (pending) => {
  writeFileSync(record + ".pending.tmp", JSON.stringify({ token, pending }));
  renameSync(record + ".pending.tmp", record + ".pending");
};
status(true);
const bytes = Buffer.alloc(16 * 1024 * 1024, "x");
let written = 0;
while (written < bytes.length) {
  const count = writeSync(fd, bytes, written, bytes.length - written);
  if (count === 0) throw new Error("Owned output write made no progress");
  written += count;
}
status(false);
