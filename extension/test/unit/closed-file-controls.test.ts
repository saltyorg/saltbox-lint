import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  holdClosedFileEvents,
  observeClosedFileDeliveries,
} from "../support/closed-file-controls.ts";

const uri = (fsPath: string, scheme = "file") => ({
  scheme,
  fsPath,
  toString: () => pathToFileURL(fsPath).toString(),
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "saltbox-closed-callbacks-"));
  const cleanups: (() => void)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse())
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Closed callback fixture cleanup failed",
        {
          cause: failures[0],
        },
      );
  });
  const source = join(root, "source");
  const alias = join(root, "alias");
  await mkdir(source);
  await symlink(source, alias, "junction");
  const canonical = await realpath(source);
  return {
    root,
    source,
    alias,
    canonical,
    own: (cleanup: () => void) => cleanups.push(cleanup),
  };
}

test("held callbacks recognize two created physical leaves through a real directory alias", async (t) => {
  const { alias, canonical, own } = await fixture(t);
  const first = uri(join(alias, "closed-one.yml"));
  const second = uri(join(alias, "closed-two.yml"));
  const held = holdClosedFileEvents([first, second]);
  own(() => held.release());
  assert.equal(held.ready(), false);
  await writeFile(first.fsPath, "one");
  await writeFile(second.fsPath, "two");
  const callbacks: string[] = [];
  const canonicalFirst = uri(join(canonical, "closed-one.yml"));
  assert.notEqual(canonicalFirst.toString(), first.toString());
  assert.equal(
    held.hold(canonicalFirst, () => callbacks.push(canonicalFirst.toString())),
    true,
  );
  assert.equal(held.ready(), false);
  assert.equal(
    held.hold(second, () => callbacks.push(second.toString())),
    true,
  );
  assert.equal(held.ready(), true);
  assert.equal(callbacks.length, 0);
  held.release();
  assert.deepEqual(callbacks, [canonicalFirst.toString(), second.toString()]);
  held.release();
  assert.equal(
    held.hold(first, () => callbacks.push("late")),
    false,
  );
  assert.equal(callbacks.length, 2);
});

test("held callbacks reject non-file URIs and preserve the exact admitted leaf", async (t) => {
  const { source, alias, canonical, own } = await fixture(t);
  const target = uri(join(alias, "expected.yml"));
  await writeFile(target.fsPath, "same bytes");
  await writeFile(join(source, "other.yml"), "same bytes");
  const held = holdClosedFileEvents([target]);
  own(() => held.release());
  for (const event of [
    uri(join(canonical, "expected.yml"), "untitled"),
    uri(join(canonical, "other.yml")),
  ]) {
    assert.equal(
      held.hold(event, () => assert.fail("unrelated callback held")),
      false,
    );
    assert.equal(held.ready(), false);
  }
});

test("retargeted and deleted held files fail the awaited readiness control", async (t) => {
  const { root, alias, canonical, own } = await fixture(t);
  const target = uri(join(alias, "expected.yml"));
  await writeFile(target.fsPath, "same bytes");
  const held = holdClosedFileEvents([target]);
  own(() => held.release());
  const replacement = join(root, "replacement");
  await mkdir(replacement);
  await writeFile(join(replacement, "expected.yml"), "same bytes");
  await rm(alias, { recursive: true });
  await symlink(replacement, alias, "junction");
  assert.equal(
    held.hold(uri(join(canonical, "expected.yml")), () => {}),
    true,
  );
  assert.throws(() => held.ready(), /callback control failed/);
  assert.throws(() => held.ready(), /callback control failed/);
  const deleted = holdClosedFileEvents([target]);
  own(() => deleted.release());
  await rm(target.fsPath);
  assert.equal(
    deleted.hold(target, () => {}),
    true,
  );
  assert.throws(() => deleted.ready(), /callback control failed/);
});

test("releasing held callbacks settles every admitted callback despite an earlier throw", async (t) => {
  const { alias, own } = await fixture(t);
  const target = uri(join(alias, "expected.yml"));
  await writeFile(target.fsPath, "bytes");
  const held = holdClosedFileEvents([target]);
  own(() => held.release());
  const fault = new Error("listener failure");
  let joined = false;
  held.hold(target, () => {
    throw fault;
  });
  held.hold(target, () => {
    joined = true;
  });
  assert.throws(
    () => held.release(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, fault);
      assert.deepEqual(error.errors, [fault]);
      return true;
    },
  );
  assert.equal(joined, true);
  held.release();
});

test("ignore delivery requires a later physical callback with the intended current bytes", async (t) => {
  const { alias, canonical, own } = await fixture(t);
  const target = uri(join(alias, ".gitignore"));
  await writeFile(target.fsPath, "before\n");
  const delivery = observeClosedFileDeliveries((event) =>
    readFileSync(event.fsPath, "utf8"),
  );
  own(() => delivery.dispose());
  const canonicalEvent = uri(join(canonical, ".gitignore"));
  assert.notEqual(canonicalEvent.toString(), target.toString());
  delivery.delivered(canonicalEvent);
  const revoked = delivery.next(target, "revoked\n");
  assert.equal(revoked(), false);
  delivery.delivered(canonicalEvent);
  assert.equal(revoked(), false);
  await writeFile(target.fsPath, "revoked\n");
  delivery.delivered(uri(canonicalEvent.fsPath, "untitled"));
  assert.equal(revoked(), false);
  delivery.delivered(canonicalEvent);
  assert.equal(revoked(), true);
  const restored = delivery.next(target, "before\n");
  assert.equal(restored(), false);
  delivery.delivered(canonicalEvent);
  assert.equal(restored(), false);
  await writeFile(target.fsPath, "before\n");
  delivery.delivered(target);
  assert.equal(restored(), true);
  delivery.dispose();
  assert.throws(restored, /observer is closed/);
  assert.throws(() => delivery.next(target, "before\n"), /observer is closed/);
});

test("ignore delivery surfaces unexpected read and retarget errors without accepting readiness", async (t) => {
  const { root, alias, canonical, own } = await fixture(t);
  const target = uri(join(alias, ".gitignore"));
  await writeFile(target.fsPath, "same bytes");
  const fault = new Error("read failure");
  const failedRead = observeClosedFileDeliveries(() => {
    throw fault;
  });
  own(() => failedRead.dispose());
  const readReady = failedRead.next(target, "same bytes");
  failedRead.delivered(target);
  assert.throws(readReady, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, fault);
    return true;
  });
  const delivery = observeClosedFileDeliveries((event) =>
    readFileSync(event.fsPath, "utf8"),
  );
  own(() => delivery.dispose());
  const retargetReady = delivery.next(target, "same bytes");
  const replacement = join(root, "replacement");
  await mkdir(replacement);
  await writeFile(join(replacement, ".gitignore"), "same bytes");
  await rm(alias, { recursive: true });
  await symlink(replacement, alias, "junction");
  delivery.delivered(uri(join(canonical, ".gitignore")));
  assert.throws(retargetReady, /callback control failed/);
  assert.throws(retargetReady, /callback control failed/);
  const deletedReady = delivery.next(target, "same bytes");
  await rm(target.fsPath);
  delivery.delivered(target, "delete");
  assert.equal(deletedReady(), false);
  await writeFile(target.fsPath, "same bytes");
  delivery.delivered(target, "create");
  assert.equal(deletedReady(), true);
});

test("ignore delete and atomic absence cannot satisfy a write generation", async (t) => {
  const { alias, own } = await fixture(t);
  const target = uri(join(alias, ".gitignore"));
  await writeFile(target.fsPath, "old bytes");
  const delivery = observeClosedFileDeliveries((event) =>
    readFileSync(event.fsPath, "utf8"),
  );
  own(() => delivery.dispose());
  const ready = delivery.next(target, "new bytes");
  await rm(target.fsPath);
  delivery.delivered(target, "delete");
  assert.equal(ready(), false);
  delivery.delivered(target, "change");
  assert.equal(ready(), false);
  await writeFile(target.fsPath, "new bytes");
  delivery.delivered(target, "delete");
  assert.equal(ready(), false);
  delivery.delivered(target, "create");
  assert.equal(ready(), true);
  await rm(target.fsPath);
  delivery.delivered(target, "delete");
  assert.equal(
    ready(),
    true,
    "a completed generation remains a historical receipt",
  );
});

test("unconsumed failures survive callback release and delivery disposal", async (t) => {
  const { alias, own } = await fixture(t);
  const target = uri(join(alias, "expected.yml"));
  await writeFile(target.fsPath, "bytes");
  const held = holdClosedFileEvents([target]);
  own(() => held.release());
  let settled = false;
  held.hold(target, () => {
    settled = true;
  });
  await rm(target.fsPath);
  held.hold(target, () => assert.fail("missing-file callback was admitted"));
  assert.throws(() => held.release(), /Held closed file callbacks failed/);
  assert.equal(settled, true);
  held.release();

  await writeFile(target.fsPath, "bytes");
  const fault = new Error("unconsumed read failure");
  const delivery = observeClosedFileDeliveries(() => {
    throw fault;
  });
  own(() => delivery.dispose());
  delivery.next(target, "bytes");
  delivery.delivered(target);
  assert.throws(
    () => delivery.dispose(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, fault);
      assert.deepEqual(error.errors, [fault]);
      return true;
    },
  );
  delivery.dispose();
});
