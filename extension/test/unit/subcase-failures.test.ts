import assert from "node:assert/strict";
import { test } from "node:test";
import { SubcaseFailures } from "../support/subcase-failures.ts";
import { withTestResources } from "../support/test-resources.ts";

function failureGraph(error: unknown, seen = new Set<unknown>()): Set<unknown> {
  if (seen.has(error)) return seen;
  seen.add(error);
  if (error instanceof Error) {
    if ("cause" in error) failureGraph(error.cause, seen);
    if (error instanceof AggregateError) {
      const children: readonly unknown[] = error.errors;
      for (const child of children) failureGraph(child, seen);
    }
  }
  return seen;
}

test("named failures retain each original fault object and metadata", () => {
  const failures = new SubcaseFailures();
  assert.equal(failures.hasFailures, false);
  failures.throwIfAny("no cases failed");
  const first = Object.assign(new Error("first body fault"), { code: "EIO" });
  const second = new Error("second body fault");
  failures.record("first scenario", first);
  assert.equal(failures.hasFailures, true);
  failures.record("second scenario", second);
  assert.throws(
    () => failures.throwIfAny("two cases failed"),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "two cases failed");
      const children: readonly unknown[] = error.errors;
      assert.equal(children.length, 2);
      for (const [index, original] of [first, second].entries()) {
        const child = children[index];
        assert.ok(child instanceof Error);
        assert.equal(child.cause, original);
        assert.match(
          child.message,
          index === 0 ? /first scenario/ : /second scenario/,
        );
      }
      assert.equal(first.code, "EIO");
      assert.equal(failures.hasFailures, true);
      return true;
    },
  );
});

test("named scenario aggregate retains actual resource body and cleanup failures", async () => {
  const failures = new SubcaseFailures();
  const body = new Error("scenario body fault");
  const cleanup = new Error("scenario cleanup fault");
  let original: unknown;
  try {
    await withTestResources({ cleanupTimeoutMs: 5000 }, async (owner) => {
      owner.defer("throwing cleanup", () => {
        throw cleanup;
      });
      await owner.operation("throwing body", async () => {
        throw body;
      });
    });
  } catch (error) {
    original = error;
    failures.record("body and cleanup scenario", error);
  }
  assert.ok(original instanceof AggregateError);
  assert.throws(
    () => failures.throwIfAny("scenario failed"),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const graph = failureGraph(error);
      assert.ok(graph.has(original));
      assert.ok(graph.has(body));
      assert.ok(graph.has(cleanup));
      assert.equal(error.cause instanceof Error && error.cause.cause, original);
      return true;
    },
  );
});

test("outer cohort cleanup retains previously recorded subcase failures", async () => {
  const subcase = new Error("earlier subcase fault");
  const cleanup = new Error("later cohort cleanup fault");
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 5000 }, async (owner) => {
      owner.defer("cohort cleanup", () => {
        throw cleanup;
      });
      const failures = new SubcaseFailures();
      failures.record("earlier scenario", subcase);
      failures.throwIfAny("cohort failed");
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const graph = failureGraph(error);
      assert.ok(graph.has(subcase));
      assert.ok(graph.has(cleanup));
      return true;
    },
  );
});

test("later cohort rejection retains prior named fault and independent cleanup without re-recording its aggregate", async () => {
  const prior = new Error("prior named fault");
  const later = new Error("later body rejection");
  const cleanup = new Error("independent cleanup fault");
  let terminal: AggregateError | undefined;
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 5000 }, async (owner) => {
      owner.defer("independent cohort cleanup", () => {
        throw cleanup;
      });
      const failures = new SubcaseFailures();
      try {
        failures.record("prior scenario", prior);
        await owner.operation("later cohort setup", async () => {
          throw later;
        });
      } catch (error) {
        assert.equal(error, later);
        failures.record("cohort body/setup", error);
      }
      try {
        failures.throwIfAny("cohort failed");
      } catch (error) {
        assert.ok(error instanceof AggregateError);
        terminal = error;
        const children: readonly unknown[] = error.errors;
        assert.equal(children.length, 2);
        for (const [index, original] of [prior, later].entries()) {
          const child = children[index];
          assert.ok(child instanceof Error);
          assert.equal(child.cause, original);
        }
        throw error;
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(terminal instanceof AggregateError);
      const graph = failureGraph(error);
      for (const original of [prior, later, cleanup, terminal])
        assert.ok(graph.has(original));
      const named: readonly unknown[] = terminal.errors;
      assert.equal(named.length, 2);
      for (const child of named) {
        assert.ok(child instanceof Error);
        assert.notEqual(
          child.cause,
          terminal,
          "terminal aggregate is outside the cohort catch",
        );
      }
      return true;
    },
  );
});
