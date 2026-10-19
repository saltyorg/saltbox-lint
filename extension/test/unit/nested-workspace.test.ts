import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type * as vscode from "vscode";
import { fixtureUri } from "../support/navigation-fixture.ts";

const bundle = await build({
  entryPoints: ["test/host/nested-workspace.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "saltbox-workspace-change-"));
  const folder = { uri: fixtureUri(root), name: "target", index: 0 };
  const other = { uri: fixtureUri(tmpdir()), name: "other", index: 1 };
  const listeners = new Set<
    (event: vscode.WorkspaceFoldersChangeEvent) => void
  >();
  let update = () => true;
  let disposalError: Error | undefined;
  let calls = 0;
  const emit = (
    added: vscode.WorkspaceFolder[],
    removed: vscode.WorkspaceFolder[],
  ) => {
    for (const listener of listeners) listener({ added, removed });
  };
  t.after(async () => {
    emit([folder], [folder]);
    await turn();
    assert.equal(
      listeners.size,
      0,
      "every admitted workspace listener is released",
    );
    await rm(root, { recursive: true });
  });
  const workspace = {
    workspaceFolders: [folder],
    onDidChangeWorkspaceFolders(
      listener: (event: vscode.WorkspaceFoldersChangeEvent) => void,
    ) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
          if (disposalError) throw disposalError;
        },
      };
    },
    updateWorkspaceFolders() {
      calls++;
      return update();
    },
  };
  const module = {
    exports: {} as Pick<
      typeof import("../host/nested-workspace.ts"),
      "changeWorkspace"
    >,
  };
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    process,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    require: (name: string) =>
      name === "vscode" ? { workspace } : require(name),
  });
  return {
    target: folder.uri,
    listeners,
    change: module.exports.changeWorkspace,
    setUpdate(value: () => boolean) {
      update = value;
    },
    setDisposalError(error: Error) {
      disposalError = error;
    },
    calls: () => calls,
    targetEvent: (remove = false) =>
      emit(remove ? [] : [folder], remove ? [folder] : []),
    unrelatedEvent: () => emit([other], []),
    addedEvent: () => emit([folder], []),
  };
}

test("workspace mutation joins only its matching addition event", async (t) => {
  const f = await fixture(t);
  let settled = false;
  const pending = f
    .change(1, 0, f.target, new AbortController().signal)
    .then(() => {
      settled = true;
    });
  f.unrelatedEvent();
  await turn();
  assert.equal(settled, false);
  f.targetEvent();
  await pending;
  assert.equal(f.calls(), 1);
  assert.equal(f.listeners.size, 0);
});

test("accepted workspace cancellation joins its actual event before rejecting", async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    reason = new Error("owned operation cancelled");
  let settled = false;
  const pending = f.change(1, 0, f.target, controller.signal);
  const rejected = assert
    .rejects(pending, (error) => error === reason)
    .then(() => {
      settled = true;
    });
  controller.abort(reason);
  f.unrelatedEvent();
  await turn();
  assert.equal(settled, false);
  assert.equal(f.listeners.size, 1);
  f.targetEvent();
  await rejected;
  assert.equal(f.listeners.size, 0);
});

test("already cancelled workspace mutation admits no listener or native update", async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    reason = new Error("cancelled before admission");
  controller.abort(reason);
  await assert.rejects(
    f.change(1, 0, f.target, controller.signal),
    (error) => error === reason,
  );
  assert.equal(f.calls(), 0);
  assert.equal(f.listeners.size, 0);
});

test("refused workspace mutation releases its listener", async (t) => {
  const f = await fixture(t);
  f.setUpdate(() => false);
  await assert.rejects(
    f.change(1, 0, f.target, new AbortController().signal),
    /workspace change refused/,
  );
  assert.equal(f.listeners.size, 0);
});

test("throwing workspace mutation retains the original error and releases its listener", async (t) => {
  const f = await fixture(t),
    reason = new Error("native update rejected");
  f.setUpdate(() => {
    throw reason;
  });
  await assert.rejects(
    f.change(1, 0, f.target, new AbortController().signal),
    (error) => error === reason,
  );
  assert.equal(f.listeners.size, 0);
});

test("workspace removal waits for the matching removal event", async (t) => {
  const f = await fixture(t);
  let settled = false;
  const pending = f
    .change(0, 1, undefined, new AbortController().signal)
    .then(() => {
      settled = true;
    });
  f.addedEvent();
  await turn();
  assert.equal(settled, false);
  f.targetEvent(true);
  await pending;
  assert.equal(f.listeners.size, 0);
});

test("workspace mutation retains its original error alongside listener disposal failure", async (t) => {
  const f = await fixture(t),
    original = new Error("native mutation failed"),
    cleanup = new Error("listener release failed");
  f.setUpdate(() => {
    throw original;
  });
  f.setDisposalError(cleanup);
  await assert.rejects(
    f.change(1, 0, f.target, new AbortController().signal),
    (failure) => {
      assert.ok(failure && typeof failure === "object");
      assert.equal(Reflect.get(failure, "cause"), original);
      const errors: unknown = Reflect.get(failure, "errors");
      assert.ok(Array.isArray(errors));
      assert.equal(errors[0], original);
      assert.equal(errors[1], cleanup);
      return true;
    },
  );
});

test("workspace completion rejects disposal failure without throwing through the event dispatcher", async (t) => {
  const f = await fixture(t),
    cleanup = new Error("listener release failed");
  f.setDisposalError(cleanup);
  const pending = assert.rejects(
    f.change(1, 0, f.target, new AbortController().signal),
    (failure) => failure === cleanup,
  );
  assert.doesNotThrow(() => f.targetEvent());
  await pending;
});

test("cancelled workspace receipt preserves cancellation and listener disposal errors", async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    original = new Error("owner cancelled"),
    cleanup = new Error("listener release failed");
  f.setDisposalError(cleanup);
  const pending = assert.rejects(
    f.change(1, 0, f.target, controller.signal),
    (failure) => {
      assert.ok(failure && typeof failure === "object");
      assert.equal(Reflect.get(failure, "cause"), original);
      const errors: unknown = Reflect.get(failure, "errors");
      assert.ok(Array.isArray(errors));
      assert.equal(errors[0], original);
      assert.equal(errors[1], cleanup);
      return true;
    },
  );
  controller.abort(original);
  f.targetEvent();
  await pending;
});
