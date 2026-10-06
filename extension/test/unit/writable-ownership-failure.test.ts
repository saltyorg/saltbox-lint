import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reportWritableOwnershipFailure } from "../host/writable-ownership-failure.ts";

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
          const prefix = "WRITABLE_OWNERSHIP_FAILURE ";
          assert.ok(records[0].startsWith(prefix));
          assert.deepEqual(JSON.parse(records[0].slice(prefix.length)), {
            control: state.control,
            completed_controls: completed,
            expected_controls: 6,
            pending_settled: settled,
            accepted_ready: acceptedReady,
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
