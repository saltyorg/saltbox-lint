// @ts-check
import { renameSync, writeFileSync, writeSync } from "node:fs";
import assert from "node:assert/strict";
import { workerData } from "node:worker_threads";

/** @type {unknown} */
const input = workerData;
assert.ok(input && typeof input === "object");
assert.ok("record" in input && typeof input.record === "string");
assert.ok("token" in input && typeof input.token === "string");
assert.ok("fd" in input && typeof input.fd === "number");
const { record, token, fd } = input;
/** @param {boolean} pending */
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
