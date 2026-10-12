import assert from "node:assert/strict";
import { test } from "node:test";
import type { CancellationToken } from "vscode";
import type { ProcessRequest } from "../../src/process.ts";
import {
  deferred,
  sourceText,
  withNavigationFixture,
} from "../support/navigation-fixture.ts";

function cancellation() {
  const listeners = new Set<() => void>();
  let canceled = false;
  return {
    token: {
      get isCancellationRequested() {
        return canceled;
      },
      onCancellationRequested(listener: () => void) {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
    } as CancellationToken,
    cancel() {
      canceled = true;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

test("a pre-cancelled navigation request never launches a backend", async () => {
  let calls = 0;
  const token = cancellation();
  token.cancel();
  await withNavigationFixture(
    {
      runProcess: async () => {
        calls++;
        return "{}";
      },
    },
    async (f) => {
      assert.equal(
        (
          await f.editor.navigation.definition(
            f.document.asDocument(),
            f.position,
            token.token,
          )
        ).length,
        0,
      );
      assert.equal(calls, 0);
      assert.equal(token.listeners.size, 0);
    },
  );
});

for (const trigger of [
  "token cancellation",
  "document close",
  "adapter disposal",
  "source edit",
] as const) {
  test(`navigation joins its admitted backend after ${trigger} before it settles`, async () => {
    const entered = deferred<AbortSignal>(),
      release = deferred<void>();
    const token = cancellation();
    let wire!: (request: ProcessRequest) => string;
    let settled = false;
    await withNavigationFixture(
      {
        runProcess: async (request, signal) => {
          entered.resolve(signal);
          await release.promise;
          return wire(request);
        },
      },
      async (f) => {
        wire = f.wire;
        const pending = f.resources.operation("owned definition", () =>
          f.editor.navigation.definition(
            f.document.asDocument(),
            f.position,
            token.token,
          ),
        );
        const observe = pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        try {
          const signal = await entered.promise;
          if (trigger === "token cancellation") token.cancel();
          if (trigger === "document close") {
            f.document.isClosed = true;
            f.editor.close(f.document.asDocument());
          }
          if (trigger === "adapter disposal") f.editor.dispose();
          if (trigger === "source edit") {
            f.document.edit(sourceText + "# new source\n");
            f.editor.change(f.document.asDocument());
          }
          assert.equal(
            signal.aborted,
            true,
            "the real scheduler cancels its admitted operation",
          );
          await Promise.resolve();
          assert.equal(
            settled,
            false,
            "cancellation cannot report completion before backend joining",
          );
        } finally {
          release.resolve();
        }
        assert.equal(
          (await pending).length,
          0,
          "late successful bytes cannot satisfy a revoked request",
        );
        await observe;
        await f.editor.join();
        assert.equal(token.listeners.size, 0);
      },
    );
  });
}

test("superseded definitions retain latest-source ownership and wait for the previous backend", async () => {
  const first = deferred<void>(),
    entered = deferred<void>();
  let wire!: (request: ProcessRequest) => string;
  const requests: ProcessRequest[] = [];
  const token = cancellation();
  await withNavigationFixture(
    {
      runProcess: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          entered.resolve();
          await first.promise;
        }
        return wire(request);
      },
    },
    async (f) => {
      wire = f.wire;
      const old = f.resources.operation("old definition", () =>
        f.editor.navigation.definition(
          f.document.asDocument(),
          f.position,
          token.token,
        ),
      );
      let replacement: Promise<unknown[]> | undefined;
      try {
        await entered.promise;
        f.document.edit(sourceText + "# current generation\n");
        f.editor.change(f.document.asDocument());
        replacement = f.resources.operation("replacement definition", () =>
          f.editor.navigation.definition(
            f.document.asDocument(),
            f.position,
            token.token,
          ),
        );
        await Promise.resolve();
        assert.equal(
          requests.length,
          1,
          "the same lane cannot launch another backend before old closure",
        );
      } finally {
        first.resolve();
      }
      assert.equal((await old).length, 0);
      assert.equal((await replacement!).length, 1);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].input, f.document.getText());
      assert.equal(token.listeners.size, 0);
    },
  );
});
