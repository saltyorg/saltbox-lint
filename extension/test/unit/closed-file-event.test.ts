import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  classifyClosedFileEvent,
  observeClosedFileEvent,
} from "../support/closed-file-event.ts";
import { TestResources, withTestResources } from "../support/test-resources.ts";
import { ownJoinedResource } from "../support/host-resources.ts";

const originalHash = createHash("sha256")
  .update("original source")
  .digest("hex");

function uri(fsPath: string) {
  return { scheme: "file", fsPath, toString: () => pathToFileURL(fsPath).href };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "saltbox-closed-event-"));
  const resources = new TestResources({ cleanupTimeoutMs: 15000 });
  resources.defer("fixture removal", () =>
    rm(root, { recursive: true, force: true }),
  );
  t.after(() => resources.close());
  const physical = join(root, "physical");
  const alias = join(root, "alias");
  await mkdir(physical);
  await writeFile(join(physical, "closed.yaml"), "original source");
  await symlink(physical, alias, "junction");
  const publicURI = uri(join(alias, "closed.yaml"));
  const owner = await realpath(publicURI.fsPath);
  return { root, physical, publicURI, owner, resources };
}
function control() {
  let listener!: (event: ReturnType<typeof uri>) => void;
  let expire!: () => void;
  let disposals = 0,
    deadlinesCanceled = 0;
  return {
    expectedSha256: originalHash,
    subscribe(callback: typeof listener) {
      listener = callback;
      return {
        dispose() {
          disposals++;
        },
      };
    },
    scheduleDeadline(callback: () => void, milliseconds: number) {
      assert.equal(milliseconds, 10000);
      expire = callback;
      return () => {
        deadlinesCanceled++;
      };
    },
    emit(event: ReturnType<typeof uri>) {
      listener(event);
    },
    expire() {
      expire();
    },
    counts() {
      return { disposals, deadlinesCanceled };
    },
  };
}

function failureTree(error: unknown, found = new Set<unknown>()): Set<unknown> {
  if (found.has(error)) return found;
  found.add(error);
  if (error instanceof Error && error.cause !== undefined)
    failureTree(error.cause, found);
  if (error instanceof AggregateError)
    for (const child of error.errors) failureTree(child, found);
  return found;
}

for (const spelling of ["public", "native"] as const) {
  test(`closed-file event accepts its captured ${spelling} spelling with exact physical owner`, async (t) => {
    const f = await fixture(t),
      c = control();
    const observer = observeClosedFileEvent(
      f.publicURI,
      f.owner,
      c.subscribe,
      c,
    );
    ownJoinedResource(f.resources, "closed-file event", observer);
    const event = spelling === "public" ? f.publicURI : uri(f.owner);
    if (spelling === "native")
      assert.notEqual(event.toString(), f.publicURI.toString());
    const ready = observer.changed();
    c.emit(event);
    c.expire();
    await ready;
    observer.dispose();
    await observer.join();
    c.emit(uri(join(f.root, "missing.yaml")));
    assert.deepEqual(c.counts(), { disposals: 1, deadlinesCanceled: 1 });
  });
}

test("callbacks before the mutation or with other bytes cannot satisfy the intended write", async (t) => {
  const f = await fixture(t),
    c = control();
  const intended = "new intended source bytes";
  const observer = observeClosedFileEvent(
    f.publicURI,
    f.owner,
    (listener) => {
      const subscription = c.subscribe(listener);
      listener(uri(f.owner));
      return subscription;
    },
    {
      ...c,
      expectedSha256: createHash("sha256").update(intended).digest("hex"),
    },
  );
  ownJoinedResource(f.resources, "closed-file event", observer);
  let completed = false;
  const ready = f.resources
    .operation("intended watcher generation", () => observer.changed())
    .then(() => {
      completed = true;
    });
  ready.catch(() => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    completed,
    false,
    "subscription-time callback still sees original bytes",
  );
  await writeFile(f.publicURI.fsPath, "other new bytes");
  c.emit(uri(f.owner));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    completed,
    false,
    "another generation cannot satisfy the intended write",
  );
  await writeFile(f.publicURI.fsPath, intended);
  c.emit(uri(f.owner));
  await ready;
  assert.equal(completed, true);
});

test("a matching callback's byte-read failure retains its actual cause", async (t) => {
  const f = await fixture(t),
    c = control(),
    fault = new Error("saved bytes unavailable");
  const observer = observeClosedFileEvent(f.publicURI, f.owner, c.subscribe, {
    ...c,
    readBytes() {
      throw fault;
    },
  });
  ownJoinedResource(f.resources, "closed-file event", observer);
  const ready = assert.rejects(
    observer.changed(),
    (error: unknown) => error instanceof Error && error.cause === fault,
  );
  c.emit(f.publicURI);
  c.expire();
  await ready;
});

test("closed-file event rejects foreign roots, another leaf and non-file events without reading them", async (t) => {
  const f = await fixture(t),
    c = control();
  let canonicalReads = 0;
  const observer = observeClosedFileEvent(f.publicURI, f.owner, c.subscribe, {
    expectedSha256: originalHash,
    scheduleDeadline: c.scheduleDeadline,
    canonicalPath() {
      canonicalReads++;
      throw new Error("foreign event was read");
    },
  });
  ownJoinedResource(f.resources, "closed-file event", observer);
  const ready = observer.changed();
  const rejection = assert.rejects(ready, /event was not delivered/);
  for (const event of [
    uri(join(f.physical, "other.yaml")),
    uri(join(f.root, "closed.yaml")),
    uri(join(f.root, "physical-sibling", "closed.yaml")),
    { ...uri(f.owner), scheme: "untitled" },
  ])
    c.emit(event);
  c.expire();
  await rejection;
  assert.equal(canonicalReads, 0);
});

test("another alias leaf to the same physical file cannot satisfy exact closed-file readiness", async (t) => {
  const f = await fixture(t);
  const aliasLeaf = join(f.physical, "different.yaml");
  await symlink(f.owner, aliasLeaf);
  assert.equal(await realpath(aliasLeaf), f.owner);
  assert.equal(
    classifyClosedFileEvent(uri(aliasLeaf), f.publicURI, f.owner),
    "unrelated",
  );
});

test("a retargeted fixture cannot replace its captured physical owner", async (t) => {
  const f = await fixture(t),
    c = control();
  const other = join(f.root, "other.yaml");
  await writeFile(other, "original source");
  await rm(join(f.physical, "closed.yaml"));
  await symlink(other, join(f.physical, "closed.yaml"));
  const observer = observeClosedFileEvent(f.publicURI, f.owner, c.subscribe, c);
  ownJoinedResource(f.resources, "closed-file event", observer);
  const ready = observer.changed();
  const rejection = assert.rejects(ready, /owner changed/);
  c.emit(f.publicURI);
  await rejection;
});

test("a delayed event for the original file cannot bless a retargeted public parent", async (t) => {
  const f = await fixture(t);
  const other = join(f.root, "other-parent");
  await mkdir(other);
  await writeFile(join(other, "closed.yaml"), "original source");
  await rm(join(f.root, "alias"), { recursive: true, force: true });
  await symlink(other, join(f.root, "alias"), "junction");
  assert.equal(
    classifyClosedFileEvent(uri(f.owner), f.publicURI, f.owner),
    "retargeted",
  );
});

test("identity failure retains its original cause and observed URI instead of becoming a timeout", async (t) => {
  const f = await fixture(t),
    c = control(),
    fault = new Error("canonical path unavailable");
  const observer = observeClosedFileEvent(f.publicURI, f.owner, c.subscribe, {
    expectedSha256: originalHash,
    scheduleDeadline: c.scheduleDeadline,
    canonicalPath() {
      throw fault;
    },
  });
  ownJoinedResource(f.resources, "closed-file event", observer);
  const ready = observer.changed();
  const rejection = assert.rejects(ready, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, fault);
    assert.ok(error.message.includes(f.publicURI.toString()));
    return true;
  });
  c.emit(f.publicURI);
  c.expire();
  await rejection;
});

test("disposing before readiness settles admission and preserves a subscription disposal failure", async (t) => {
  const f = await fixture(t),
    c = control(),
    fault = new Error("subscription release denied");
  const observer = observeClosedFileEvent(
    f.publicURI,
    f.owner,
    () => ({
      dispose() {
        throw fault;
      },
    }),
    c,
  );
  ownJoinedResource(f.resources, "closed-file event", observer);
  const ready = assert.rejects(observer.changed(), /disposed before its event/);
  assert.throws(
    () => observer.dispose(),
    (error: unknown) => error === fault,
  );
  await ready;
  await observer.join();
  observer.dispose();
  assert.equal(c.counts().deadlinesCanceled, 1);
});

test("failed timer acquisition rolls back its listener and preserves both setup and disposal failures", async (t) => {
  const f = await fixture(t),
    setup = new Error("timer setup denied"),
    disposal = new Error("listener release denied");
  assert.throws(
    () =>
      observeClosedFileEvent(
        f.publicURI,
        f.owner,
        () => ({
          dispose() {
            throw disposal;
          },
        }),
        {
          expectedSha256: originalHash,
          scheduleDeadline() {
            throw setup;
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, setup);
      assert.deepEqual(error.errors, [setup, disposal]);
      return true;
    },
  );
});

test("deadline cancellation and subscription disposal errors are retained while readiness still joins", async (t) => {
  const f = await fixture(t);
  const timerFault = new Error("deadline cancellation failed");
  const listenerFault = new Error("subscription disposal failed");
  let listenerDisposed = false;
  const observer = observeClosedFileEvent(
    f.publicURI,
    f.owner,
    () => ({
      dispose() {
        listenerDisposed = true;
        throw listenerFault;
      },
    }),
    {
      expectedSha256: originalHash,
      scheduleDeadline() {
        return () => {
          throw timerFault;
        };
      },
    },
  );
  ownJoinedResource(f.resources, "closed-file event", observer);
  const ready = assert.rejects(observer.changed(), /disposed before its event/);
  assert.throws(
    () => observer.dispose(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [timerFault, listenerFault]);
      return true;
    },
  );
  await ready;
  await observer.join();
  assert.equal(listenerDisposed, true);
});

test("failed subscription acquisition preserves its error and never acquires a deadline", async (t) => {
  const f = await fixture(t);
  const fault = new Error("subscription acquisition failed");
  let timers = 0;
  assert.throws(
    () =>
      observeClosedFileEvent(
        f.publicURI,
        f.owner,
        () => {
          throw fault;
        },
        {
          expectedSha256: originalHash,
          scheduleDeadline() {
            timers++;
            return () => undefined;
          },
        },
      ),
    (error: unknown) => error === fault,
  );
  assert.equal(timers, 0);
});

for (const failure of ["identity", "deadline"] as const) {
  test(`unconsumed ${failure} failure is retained alongside the original disk-write failure`, async (t) => {
    const f = await fixture(t),
      c = control();
    const primary = new Error("disk write failed before consuming readiness");
    const identity = new Error("native identity unavailable");
    await assert.rejects(
      withTestResources({ cleanupTimeoutMs: 1000 }, async (owner) => {
        ownJoinedResource(
          owner,
          "closed-file event",
          observeClosedFileEvent(f.publicURI, f.owner, c.subscribe, {
            expectedSha256: originalHash,
            scheduleDeadline: c.scheduleDeadline,
            canonicalPath() {
              throw identity;
            },
          }),
        );
        if (failure === "identity") c.emit(f.publicURI);
        else c.expire();
        throw primary;
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        const errors = failureTree(error);
        assert.ok(errors.has(primary));
        if (failure === "identity") assert.ok(errors.has(identity));
        else
          assert.ok(
            [...errors].some(
              (value) =>
                value instanceof Error &&
                value.message.includes("event was not delivered"),
            ),
          );
        return true;
      },
    );
  });
}

test("consumed identity failure remains distinct from later subscription disposal failure", async (t) => {
  const f = await fixture(t),
    c = control();
  const identity = new Error("native identity failed");
  const disposal = new Error("subscription disposal failed");
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 1000 }, async (owner) => {
      const observer = ownJoinedResource(
        owner,
        "closed-file event",
        observeClosedFileEvent(
          f.publicURI,
          f.owner,
          (listener) => {
            c.subscribe(listener);
            return {
              dispose() {
                throw disposal;
              },
            };
          },
          {
            expectedSha256: originalHash,
            scheduleDeadline: c.scheduleDeadline,
            canonicalPath() {
              throw identity;
            },
          },
        ),
      );
      const ready = observer.changed();
      const handled = assert.rejects(
        ready,
        (error: unknown) => error instanceof Error && error.cause === identity,
      );
      c.emit(f.publicURI);
      await handled;
    }),
    (error: unknown) => {
      const errors = failureTree(error);
      assert.ok(errors.has(disposal));
      assert.equal(
        errors.has(identity),
        false,
        "consumed readiness failure is not reported as a second cleanup failure",
      );
      return true;
    },
  );
});

test("owned disk-write failure cancels and joins readiness before restoring bytes", async (t) => {
  const f = await fixture(t),
    c = control(),
    primary = new Error("disk write failed");
  let restored = false;
  await assert.rejects(
    withTestResources({ cleanupTimeoutMs: 1000 }, async (owner) => {
      owner.defer("disk restoration", () => {
        assert.deepEqual(c.counts(), { disposals: 1, deadlinesCanceled: 1 });
        restored = true;
      });
      const observer = ownJoinedResource(
        owner,
        "closed-file event",
        observeClosedFileEvent(f.publicURI, f.owner, c.subscribe, c),
      );
      const ready = owner.operation("watcher readiness", () =>
        observer.changed(),
      );
      ready.catch(() => undefined);
      throw primary;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.ok(error.errors.includes(primary));
      return true;
    },
  );
  assert.equal(restored, true);
});
