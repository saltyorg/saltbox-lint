import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  captureWritableOwnershipPreconditions,
  reportWritableOwnershipFailure,
} from "../host/writable-ownership-failure.ts";

const prefix = "WRITABLE_OWNERSHIP_FAILURE ";

function failureRecord(
  state: Parameters<typeof reportWritableOwnershipFailure>[1],
) {
  const primary = new Error("primary product failure");
  const records: string[] = [];
  assert.throws(
    () =>
      reportWritableOwnershipFailure(primary, state, (s) => records.push(s)),
    (actual) => actual === primary,
  );
  assert.equal(records.length, 1);
  assert.ok(Buffer.byteLength(records[0]) < 1024);
  return JSON.parse(records[0].slice(prefix.length));
}

test("Fix All preconditions use only held public getters and retain booleans at the call", () => {
  const operations: string[] = [];
  const requestedURI = {
    toString() {
      operations.push("requested URI");
      return "private-requested-uri";
    },
  };
  let currentText = "private buffer \u{1f600}\r\n";
  let closed = false;
  let dirty = true;
  const document = {
    get uri() {
      operations.push("document.uri");
      return {
        toString() {
          operations.push("document URI");
          return "private-requested-uri";
        },
      };
    },
    getText() {
      operations.push("document.getText");
      return currentText;
    },
    get isClosed() {
      operations.push("document.isClosed");
      return closed;
    },
    get isDirty() {
      operations.push("document.isDirty");
      return dirty;
    },
    get version() {
      return assert.fail("version is outside the approved projection");
    },
  };
  const publicPreconditions = captureWritableOwnershipPreconditions(
    document,
    requestedURI,
    Buffer.from(currentText),
  );
  assert.deepEqual(operations, [
    "document.getText",
    "document.uri",
    "document URI",
    "requested URI",
    "document.isClosed",
    "document.isDirty",
  ]);
  currentText = "later text";
  closed = true;
  dirty = false;
  const record = failureRecord({
    control: "fixAll:retarget",
    completed: 5,
    settled: true,
    acceptedReady: false,
    publicPreconditions,
  });
  assert.equal(
    operations.length,
    6,
    "reporting does not resample the document",
  );
  assert.equal(record.precondition_stage, "fixAll:call");
  assert.equal(record.document_uri_equal, true);
  assert.equal(record.buffer_utf8_bytes_equal, true);
  assert.equal(record.document_closed, false);
  assert.equal(record.document_dirty, true);
  assert.equal(record.child_completion, "unknown");
  assert.equal(record.response_contract_valid, "unknown");
  assert.doesNotMatch(JSON.stringify(record), /private|later text/);
});

test("every public precondition boolean is bounded and independent of gate settlement", () => {
  for (let bits = 0; bits < 16; bits++) {
    const flags = Array.from({ length: 4 }, (_, i) => !!(bits & (1 << i)));
    for (const control of ["fixAll:stable", "fixAll:retarget"] as const) {
      const record = failureRecord({
        control,
        completed: control === "fixAll:stable" ? 4 : 5,
        settled: !!(bits & 1),
        acceptedReady: !!(bits & 2),
        publicPreconditions: {
          stage: "fixAll:call",
          documentURIEqual: flags[0],
          bufferUTF8BytesEqual: flags[1],
          documentClosed: flags[2],
          documentDirty: flags[3],
        },
      });
      assert.deepEqual(
        [
          record.document_uri_equal,
          record.buffer_utf8_bytes_equal,
          record.document_closed,
          record.document_dirty,
        ],
        flags,
      );
      assert.equal(record.expected_controls, 6);
      for (const [key, value] of Object.entries(record))
        if (key.startsWith("response_") || key === "child_completion")
          assert.equal(value, "unknown");
    }
  }
});

test("UTF-8 byte equality never exports buffer or URI values", () => {
  for (const [text, bytes, bytesEqual] of [
    ["private text", Buffer.from("other text"), false],
    ["\ufffd", Buffer.from([255]), false],
    ["private \u{1f600}", Buffer.from("private \u{1f600}"), true],
  ] as const) {
    const captured = captureWritableOwnershipPreconditions(
      {
        uri: { toString: () => "private different URI" },
        getText: () => text,
        isClosed: false,
        isDirty: false,
      },
      { toString: () => "private requested URI" },
      bytes,
    );
    assert.equal(captured?.documentURIEqual, false);
    assert.equal(captured?.bufferUTF8BytesEqual, bytesEqual);
    const record = failureRecord({
      control: "fixAll:stable",
      completed: 4,
      settled: true,
      acceptedReady: false,
      publicPreconditions: captured,
    });
    assert.doesNotMatch(JSON.stringify(record), /private|other text|\ufffd/);
  }
});

test("failed public getters or equality leave preconditions unknown and preserve the product failure", () => {
  for (const operation of [
    "getText",
    "uri",
    "document URI",
    "requested URI",
    "isClosed",
    "isDirty",
    "bytes equality",
  ]) {
    const read = (name: string) => {
      if (name === operation) throw new Error("private getter failure");
    };
    const bytes =
      operation === "bytes equality"
        ? ([] as unknown as Buffer)
        : Buffer.from("private text");
    const captured = captureWritableOwnershipPreconditions(
      {
        get uri() {
          read("uri");
          return {
            toString() {
              read("document URI");
              return "private URI";
            },
          };
        },
        getText() {
          read("getText");
          return "private text";
        },
        get isClosed() {
          read("isClosed");
          return false;
        },
        get isDirty() {
          read("isDirty");
          return false;
        },
      },
      {
        toString() {
          read("requested URI");
          return "private URI";
        },
      },
      bytes,
    );
    assert.equal(captured, undefined);
    const record = failureRecord({
      control: "fixAll:retarget",
      completed: 5,
      settled: true,
      acceptedReady: false,
      publicPreconditions: captured,
    });
    for (const [key, value] of Object.entries(record))
      if (
        key.startsWith("document_") ||
        key.startsWith("buffer_") ||
        key === "precondition_stage"
      )
        assert.equal(value, "unknown");
  }
});

test("invalid or failing precondition bookkeeping never exports raw caller values", () => {
  const captured = captureWritableOwnershipPreconditions(
    {
      uri: { toString: () => "private URI" },
      getText: () => "private text",
      isClosed: false,
      isDirty: false,
    },
    { toString: () => "private URI" },
    Buffer.from("private text"),
  )!;
  for (const field of Object.keys(captured)) {
    const invalid = Object.assign({}, captured);
    Object.defineProperty(invalid, field, {
      value: "private raw value",
      configurable: true,
    });
    const record = failureRecord({
      control: "fixAll:stable",
      completed: 4,
      settled: false,
      acceptedReady: false,
      publicPreconditions: invalid,
    });
    assert.doesNotMatch(JSON.stringify(record), /private raw value/);
    Object.defineProperty(invalid, field, {
      configurable: true,
      get() {
        throw new Error("private bookkeeping failure");
      },
    });
    const failed = failureRecord({
      control: "fixAll:stable",
      completed: 4,
      settled: false,
      acceptedReady: false,
      publicPreconditions: invalid,
    });
    assert.equal(failed.precondition_stage, "unknown");
  }
  for (const control of ["canonical:stable", "lint-fixes:retarget"] as const)
    assert.equal(
      failureRecord({
        control,
        completed: 0,
        settled: false,
        acceptedReady: false,
        publicPreconditions: captured,
      }).precondition_stage,
      "unknown",
    );
});

test("writable ownership failure reports bounded existing state and preserves the exact error", () => {
  const modes = ["canonical", "lint-fixes", "fixAll"] as const;
  let completed = 0;
  for (const mode of modes) {
    for (const retarget of [false, true]) {
      for (const settled of [false, true]) {
        for (const acceptedReady of [false, true]) {
          const error = new Error(
            "exact real formatter response reaches its credentialed gate",
          );
          const records: string[] = [];
          const state = {
            control: `${mode}:${retarget ? "retarget" : "stable"}` as const,
            completed,
            settled,
            acceptedReady,
            // Unexpected caller fields must never reach diagnostic output.
            path: "private-source-path",
            stderr: "private-child-stderr",
            credential: "private-fixture-credential",
          };
          assert.throws(
            () =>
              reportWritableOwnershipFailure(error, state, (record) => {
                records.push(record);
              }),
            (thrown) => thrown === error,
          );
          assert.equal(records.length, 1);
          assert.ok(Buffer.byteLength(records[0]) < 1024);
          assert.ok(records[0].startsWith(prefix));
          assert.deepEqual(JSON.parse(records[0].slice(prefix.length)), {
            control: state.control,
            completed_controls: completed,
            expected_controls: 6,
            pending_settled: settled,
            accepted_ready: acceptedReady,
            precondition_stage: "unknown",
            document_uri_equal: "unknown",
            buffer_utf8_bytes_equal: "unknown",
            document_closed: "unknown",
            document_dirty: "unknown",
            child_completion: "unknown",
            response_contract_valid: "unknown",
            response_schema_equal: "unknown",
            response_path_equal: "unknown",
            response_source_hash_equal: "unknown",
            response_ready: "unknown",
            response_unchanged: "unknown",
            response_skipped: "unknown",
            response_has_edits: "unknown",
          });
        }
      }
      completed++;
    }
  }
  assert.equal(completed, 6);
});

test("a failed evidence writer cannot replace the primary failure", () => {
  for (const error of [new Error("primary failure"), undefined, "failure"]) {
    let thrown = false;
    try {
      reportWritableOwnershipFailure(
        error,
        {
          control: "canonical:stable",
          completed: 0,
          settled: false,
          acceptedReady: false,
        },
        () => {
          throw new Error("evidence output failed");
        },
      );
    } catch (actual) {
      thrown = true;
      assert.equal(actual, error);
    }
    assert.equal(thrown, true);
  }
});

test("host wiring retains the original readiness deadline, six controls and child pass-through", () => {
  const host = readFileSync(
    new URL("../host/writable-ownership.ts", import.meta.url),
    "utf8",
  );
  assert.match(host, /const deadline = Date\.now\(\) \+ 10000;/);
  assert.match(
    host,
    /const modes = \["canonical", "lint-fixes", "fixAll"\] as const;/,
  );
  assert.match(host, /for \(const retarget of \[false, true\]\)/);
  assert.match(
    host,
    /const publicPreconditions =\s+mode === "fixAll"\s+\? captureWritableOwnershipPreconditions\(document, uri, bytes\)\s+: undefined;\s+const pending = \(\s+mode === "fixAll" \? editor\.fixAll\(uri\) : editor\.format\(document, mode\)/,
  );
  // Evidence collection adds no filesystem operation, API request or wait.
  const existingOperations = {
    mkdtemp: 1,
    readFile: 2,
    realpath: 2,
    rm: 6,
    symlink: 2,
    writeFile: 2,
    until: 3,
    fixAll: 1,
    format: 1,
    openTextDocument: 1,
    showTextDocument: 1,
    executeCommand: 1,
  };
  for (const [operation, count] of Object.entries(existingOperations))
    assert.equal(
      [...host.matchAll(new RegExp(`\\b${operation}\\s*\\(`, "g"))].length,
      count,
      operation,
    );
  const helper = readFileSync(
    new URL("../host/writable-ownership-failure.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    helper,
    /\b(?:import|require|await|async|process|setTimeout|fetch|addEventListener)\b|\.onDid|\.on\(/,
  );
  assert.match(
    host,
    /assert\.equal\(await fixtureRunning\(controlled\), true\);\s+acceptedReady = true;/,
  );
  assert.match(
    host,
    /catch \(error\) \{\s+reportWritableOwnershipFailure\(error,/,
  );
  const fixture = readFileSync(
    new URL("../testdata/process_fixture.go", import.meta.url),
    "utf8",
  );
  assert.match(fixture, /err := command\.Run\(\)/);
  assert.match(fixture, /os\.Stdout\.Write\(output\.Bytes\(\)\)/);
  assert.match(fixture, /os\.Exit\(exit\.ExitCode\(\)\)/);
});
