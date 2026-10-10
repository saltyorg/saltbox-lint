import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fixtureFailureRecords,
  reportFixtureFailures,
} from "../host/fixture-failure-log.ts";

const record = {
  stage: "readiness-rename",
  error_class: "errno",
  errno: 32,
  pid: 123,
  operation: "format",
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");

test("fixture evidence retains only fixed stages, classes and numeric errno", () => {
  assert.deepEqual(fixtureFailureRecords(bytes(record)), [record]);
  const invalid = [
    { ...record, stage: "/private/source" },
    { ...record, error_class: "secret-token" },
    { ...record, errno: "private path" },
    { ...record, errno: -1 },
    { ...record, errno: 1.5 },
    { ...record, errno: Number.MAX_SAFE_INTEGER + 1 },
    { ...record, token: "credential" },
    { ...record, pid: "private pid" },
    { ...record, pid: 0 },
    { ...record, operation: "private argument" },
    { ...record, operation: ["format"] },
    { stage: "readiness-write", error_class: "errno" },
    { ...record, error_class: "other" },
    [record],
    null,
  ];
  for (const value of invalid)
    assert.deepEqual(fixtureFailureRecords(bytes(value)), []);
  assert.deepEqual(fixtureFailureRecords(Buffer.from("incomplete {")), []);
  assert.deepEqual(fixtureFailureRecords(Buffer.alloc(4097)), []);
  assert.equal(
    fixtureFailureRecords(
      Buffer.from((JSON.stringify(record) + "\n").repeat(33)),
    ).length,
    32,
  );
});

test("bounded fixture log reporting preserves an earlier failure when evidence is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "saltbox-fixture-failure-"));
  try {
    const filename = join(directory, "failures.jsonl");
    const emitted: unknown[] = [];
    const emit = (value: unknown) => emitted.push(value);
    reportFixtureFailures(filename, emit);
    assert.deepEqual(emitted, []);
    writeFileSync(filename, bytes(record));
    reportFixtureFailures(filename, emit);
    assert.deepEqual(emitted, [record]);
    writeFileSync(filename, bytes({ ...record, operation: "check" }));
    reportFixtureFailures(filename, emit, "format");
    assert.deepEqual(emitted, [record]);
    writeFileSync(filename, bytes(record));
    assert.doesNotThrow(() =>
      reportFixtureFailures(filename, () => {
        throw new Error("evidence output failed");
      }),
    );
    writeFileSync(filename, Buffer.alloc(4097));
    reportFixtureFailures(filename, emit);
    assert.deepEqual(emitted, [record]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
