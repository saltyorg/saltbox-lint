import assert from "node:assert/strict";
import { test } from "node:test";
import { navigationEqualityProjection } from "../host/navigation-equality-projection.ts";

function completed(original?: Buffer, restoration?: Buffer) {
  const facts = navigationEqualityProjection(original);
  facts.controlStarted("manual_impact_failure");
  facts.controlReturned("manual_impact_failure");
  facts.controlStarted("manual_marker_refresh");
  if (restoration) {
    facts.restorationHeld(restoration);
    facts.restorationWriteStarted();
    facts.restorationWriteReturned();
  }
  facts.controlReturned("manual_marker_refresh");
  facts.cleanObserved(true);
  return facts;
}

test("existing fixture buffers distinguish restored input and changed disk with a clean buffer", () => {
  const original = Buffer.from("PRIVATE_ORIGINAL_CONTENT");
  const restored = Buffer.from("PRIVATE_RESTORATION_CONTENT");
  const disk = Buffer.from("PRIVATE_DISK_CONTENT");
  const facts = completed(original, restored);
  const result = disk.equals(original);
  facts.diskObserved(disk, result);
  assert.deepEqual(facts.snapshot(), {
    fixture: "navtarget_defaults",
    manual_impact_failure: "returned",
    manual_marker_refresh: "returned",
    restoration_stage: "write_returned",
    restoration_matches_original: false,
    target_buffer_clean: true,
    disk_matches_original: false,
    disk_matches_restoration: false,
  });
  assert.throws(() => assert.equal(result, true), assert.AssertionError);
});

test("matching original and restoration inputs leave the original assertion passing", () => {
  const bytes = Buffer.from("PRIVATE_EQUAL_CONTENT");
  const facts = completed(bytes, bytes);
  const result = bytes.equals(bytes);
  facts.diskObserved(bytes, result);
  const snapshot = facts.snapshot();
  assert.equal(snapshot.restoration_matches_original, true);
  assert.equal(snapshot.disk_matches_original, true);
  assert.equal(snapshot.disk_matches_restoration, true);
  assert.equal(result, true);
});

test("absent buffers and unreached stages remain explicitly unknown", () => {
  const facts = navigationEqualityProjection();
  assert.deepEqual(
    Object.values(facts.snapshot()).slice(1),
    Array(7).fill("unknown"),
  );
  facts.controlStarted("manual_impact_failure");
  facts.diskObserved(Buffer.from("PRIVATE_UNKNOWN"), false);
  assert.equal(facts.snapshot().disk_matches_original, "unknown");
  assert.equal(facts.snapshot().disk_matches_restoration, "unknown");
  assert.equal(facts.snapshot().restoration_matches_original, "unknown");
  assert.equal(facts.snapshot().manual_marker_refresh, "unknown");
});

test("primary failures retain identity when projection or diagnostic output fails", () => {
  const primary = new Error("PRIVATE_PRIMARY_MESSAGE");
  const facts = completed(Buffer.from("PRIVATE"));
  assert.throws(
    () =>
      facts.rethrow(primary, () => {
        throw new Error("output failed");
      }),
    (error) => error === primary,
  );
  facts.snapshot = () => {
    throw new Error("projection failed");
  };
  assert.throws(
    () =>
      facts.rethrow(primary, () => {
        throw new Error("must not replace primary");
      }),
    (error) => error === primary,
  );
});

test("failure output contains only bounded fixed IDs, stages and tri-states", () => {
  const original = Buffer.from("PRIVATE_ORIGINAL_BYTES");
  const restoration = Buffer.from("PRIVATE_RESTORE_BYTES");
  const facts = completed(original, restoration);
  facts.controlStarted("manual_marker_refresh");
  const primary = new Error("PRIVATE_ERROR_CONTENT");
  const messages: string[] = [];
  assert.throws(
    () => facts.rethrow(primary, (message) => messages.push(message)),
    (error) => error === primary,
  );
  assert.equal(messages.length, 1);
  const text = messages[0];
  assert.ok(Buffer.byteLength(text) <= 1024);
  assert.ok(!text.includes("PRIVATE"));
  assert.ok(!/path|hash|content|stderr|identity|revision|bytes/iu.test(text));
  const evidence = JSON.parse(
    text.slice("NAVIGATION_EQUALITY ".length),
  ) as Record<string, unknown>;
  assert.equal(evidence.manual_marker_refresh, "failed");
  assert.ok(
    Object.values(evidence).every(
      (value) =>
        typeof value === "boolean" ||
        [
          "navtarget_defaults",
          "returned",
          "failed",
          "started",
          "unknown",
          "write_returned",
          "held",
          "write_started",
        ].includes(value as string),
    ),
  );
});

test("restoration equality failure stays unknown and cannot change the control outcome", () => {
  const original = Buffer.from("PRIVATE");
  const restoration = Buffer.from("PRIVATE");
  restoration.equals = () => {
    throw new Error("equality failed");
  };
  const facts = completed(original, restoration);
  assert.equal(facts.snapshot().restoration_matches_original, "unknown");
  assert.equal(facts.snapshot().manual_marker_refresh, "returned");
});

for (const diskChoice of ["original", "restoration"] as const) {
  test(`same disk result distinguishes equality with ${diskChoice} when inputs differ`, () => {
    const original = Buffer.from("PRIVATE_ORIGINAL");
    const restoration = Buffer.from("PRIVATE_RESTORATION");
    const disk = diskChoice === "original" ? original : restoration;
    const facts = completed(original, restoration);
    const result = disk.equals(original);
    facts.diskObserved(disk, result);
    assert.equal(
      facts.snapshot().disk_matches_original,
      diskChoice === "original",
    );
    assert.equal(
      facts.snapshot().disk_matches_restoration,
      diskChoice === "restoration",
    );
    assert.equal(facts.snapshot().restoration_matches_original, false);
  });
}

test("failure before restoration returns preserves its entered stage and unknown disk facts", () => {
  const bytes = Buffer.from("PRIVATE");
  const facts = navigationEqualityProjection(bytes);
  facts.controlStarted("manual_marker_refresh");
  facts.restorationHeld(bytes);
  facts.restorationWriteStarted();
  const primary = new Error("PRIVATE_RESTORE_FAILURE");
  assert.throws(
    () => facts.rethrow(primary, () => {}),
    (error) => error === primary,
  );
  const snapshot = facts.snapshot();
  assert.equal(snapshot.manual_marker_refresh, "failed");
  assert.equal(snapshot.restoration_stage, "write_started");
  assert.equal(snapshot.restoration_matches_original, true);
  assert.equal(snapshot.target_buffer_clean, "unknown");
  assert.equal(snapshot.disk_matches_original, "unknown");
  assert.equal(snapshot.disk_matches_restoration, "unknown");
});

test("unexpected snapshot fields and oversized values cannot reach failure output", () => {
  const facts = navigationEqualityProjection();
  const hostile = "PRIVATE".repeat(10000);
  Object.assign(facts, {
    snapshot: () => ({
      fixture: hostile,
      manual_impact_failure: hostile,
      manual_marker_refresh: hostile,
      restoration_stage: hostile,
      restoration_matches_original: hostile,
      target_buffer_clean: hostile,
      disk_matches_original: hostile,
      disk_matches_restoration: hostile,
      path: hostile,
      stderr: hostile,
    }),
  });
  const messages: string[] = [];
  const primary = new Error(hostile);
  assert.throws(
    () => facts.rethrow(primary, (message) => messages.push(message)),
    (error) => error === primary,
  );
  assert.equal(messages.length, 1);
  assert.ok(Buffer.byteLength(messages[0]) <= 1024);
  assert.ok(!/PRIVATE|path|stderr/u.test(messages[0]));
  const evidence = JSON.parse(
    messages[0].slice("NAVIGATION_EQUALITY ".length),
  ) as Record<string, unknown>;
  assert.equal(evidence.fixture, "navtarget_defaults");
  assert.deepEqual(Object.values(evidence).slice(1), Array(7).fill("unknown"));
});
