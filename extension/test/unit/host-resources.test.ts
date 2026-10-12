import assert from "node:assert/strict";
import { test } from "node:test";
import { ownJoinedResource } from "../support/host-resources.ts";
import { TestResources, TestResourceError } from "../support/test-resources.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("producer cancellation precedes operation join and actual closure precedes restoration", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const work = deferred(),
    closed = deferred(),
    joining = deferred();
  const events: string[] = [];
  resources.defer("restore file", () => {
    events.push("restore");
  });
  ownJoinedResource(resources, "adapter", {
    dispose() {
      events.push("cancel");
      work.resolve();
    },
    async join() {
      joining.resolve();
      await closed.promise;
      events.push("closed");
    },
  });
  const pending = resources.operation("admitted write", async () => {
    await work.promise;
    events.push("write settled");
  });
  const completion = resources.close();
  await joining.promise;
  assert.deepEqual(events, ["cancel", "write settled"]);
  closed.resolve();
  await pending;
  await completion;
  assert.deepEqual(events, ["cancel", "write settled", "closed", "restore"]);
  assert.deepEqual(resources.snapshot().cleanups, []);
});

test("resources acquired under an already-canceled owner cancel immediately and join once", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  resources.cancel();
  let canceled = 0,
    joined = 0;
  const adapter = {
    dispose() {
      canceled++;
    },
    async join() {
      joined++;
    },
  };
  assert.equal(ownJoinedResource(resources, "adapter", adapter), adapter);
  assert.equal(canceled, 1);
  await resources.close();
  assert.equal(canceled, 1);
  assert.equal(joined, 1);
});

test("cancellation and join failures are both retained while restoration continues", async () => {
  const resources = new TestResources({ cleanupTimeoutMs: 1000 });
  const cancelFailure = new Error("cancel failed"),
    joinFailure = new Error("join failed");
  let restored = false,
    joined = false;
  resources.defer("restore", () => {
    restored = true;
  });
  ownJoinedResource(resources, "adapter", {
    dispose() {
      throw cancelFailure;
    },
    async join() {
      joined = true;
      throw joinFailure;
    },
  });
  await assert.rejects(resources.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    const resource: unknown = error.errors[0];
    assert.ok(resource instanceof TestResourceError);
    assert.ok(resource.cause instanceof AggregateError);
    assert.deepEqual(resource.cause.errors, [cancelFailure, joinFailure]);
    return true;
  });
  assert.equal(joined, true);
  assert.equal(restored, true);
});
