import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import type { ProcessRequest } from "../../src/process.ts";
import type { AnalysisRecord } from "../../src/protocol.ts";
import { hash } from "../../src/protocol.ts";
import { prepareLiveBaseline } from "../support/live-controls.ts";
import {
  deferred,
  withNavigationFixture,
  type NavigationFixture,
} from "../support/navigation-fixture.ts";

function clock() {
  const timers: { perform(): void; active: boolean }[] = [];
  return {
    schedule(perform: () => void, milliseconds: number) {
      assert.equal(milliseconds, 100);
      const timer = { perform, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    deliver() {
      const pending = timers.filter((timer) => timer.active);
      for (const timer of pending) {
        timer.active = false;
        timer.perform();
      }
      return pending.length;
    },
    active: () => timers.filter((timer) => timer.active).length,
  };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function wire(
  request: ProcessRequest,
  f: NavigationFixture,
): Promise<string> {
  if (request.args[0] === "--version") return "fixture backend\n";
  if (request.args[0] === "rules")
    return JSON.stringify({ schema_version: 1, rules: [] });
  assert.equal(request.args[0], "check");
  const source = relative(f.root, f.source).replaceAll("\\", "/");
  const target = relative(f.root, f.target).replaceAll("\\", "/");
  const selected =
    request.input !== undefined
      ? [
          source ===
          relative(
            f.root,
            request.args[request.args.indexOf("--stdin-filename") + 1],
          ).replaceAll("\\", "/")
            ? source
            : target,
        ]
      : request.args.slice(request.args.indexOf("--") + 1);
  const paths = selected.includes(".") ? [source, target] : selected;
  const sources: AnalysisRecord["sources"] = [];
  for (const path of paths) {
    const bytes =
      request.input ?? (await readFile(path === source ? f.source : f.target));
    sources.push({
      path,
      source_sha256: hash(bytes),
      files: [{ path, sha256: hash(bytes), state: "read" }],
      identity: [],
      discovery: [],
      directories: [],
    });
  }
  return JSON.stringify({
    schema_version: 2,
    diagnostics: [],
    fixes: [],
    analysis: {
      schema_version: 1,
      root: f.root,
      generation: hash("generation"),
      complete: true,
      sources,
    },
  });
}
const operations = { acceptedOperations: ["check", "--version", "rules"] };

test("live measurement waits for queued startup admission before capturing its zero-typing baseline", async () => {
  const timer = clock();
  let fixture!: NavigationFixture;
  const requests: ProcessRequest[] = [];
  await withNavigationFixture(
    {
      schedule: timer.schedule,
      runProcess: async (request) => {
        requests.push(request);
        return wire(request, fixture);
      },
    },
    async (f) => {
      fixture = f;
      assert.ok(
        timer.active() > 0,
        "startup producer is queued without a native request yet",
      );
      let captured = false;
      const pending = prepareLiveBaseline(
        () => f.editor.join(),
        async () => {
          captured = true;
          return requests.length;
        },
      );
      try {
        await turn();
        assert.equal(
          captured,
          false,
          "closed requests alone do not establish completed startup work",
        );
      } finally {
        timer.deliver();
        await f.editor.join();
      }
      const baseline = await pending;
      assert.ok(baseline > 0);
      assert.ok(
        requests.some(
          (request) =>
            request.input === undefined && request.args[0] === "check",
        ),
        "queued workspace checks belong to the baseline",
      );
      for (let index = 0; index < 5; index++) {
        f.document.edit(`changed: ${index}\n`);
        f.editor.change(f.document.asDocument());
      }
      timer.deliver();
      await f.editor.join();
      assert.equal(
        requests.length,
        baseline,
        "default-off typing still launches zero additional requests",
      );
    },
    operations,
  );
});

for (const phase of ["saved rendering", "source synchronization"] as const) {
  test(`public join owns pending file admission and complete ${phase} after backend closure`, async () => {
    const timer = clock(),
      entered = deferred<void>(),
      release = deferred<void>();
    let fixture!: NavigationFixture;
    let armed = false,
      reads = 0,
      backendClosed = false;
    await withNavigationFixture(
      {
        schedule: timer.schedule,
        readFile: (async (...args: Parameters<typeof readFile>) => {
          if (
            armed &&
            args[0] === fixture.target &&
            ++reads === 2 &&
            phase === "saved rendering"
          ) {
            entered.resolve();
            await release.promise;
          }
          return Reflect.apply(readFile, undefined, args);
        }) as typeof readFile,
        stat: (async (...args: Parameters<typeof stat>) => {
          if (
            armed &&
            backendClosed &&
            args[0] === fixture.source &&
            phase === "source synchronization"
          ) {
            entered.resolve();
            await release.promise;
          }
          return Reflect.apply(stat, undefined, args);
        }) as typeof stat,
        runProcess: async (request) => {
          const result = await wire(request, fixture);
          if (
            armed &&
            request.args[0] === "check" &&
            request.input === undefined
          )
            backendClosed = true;
          return result;
        },
      },
      async (f) => {
        fixture = f;
        timer.deliver();
        await f.editor.join();
        f.targetDocument.isClosed = true;
        f.document.isDirty = true;
        await writeFile(f.target, "target_role_port: 43\n");
        armed = true;
        f.editor.removeFile(f.targetDocument.uri);
        assert.ok(timer.active() > 0);
        let joined = false;
        const pending = f.editor.join().then(() => {
          joined = true;
        });
        try {
          await turn();
          assert.equal(
            joined,
            false,
            "a queued timer is admitted work even before its backend exists",
          );
          assert.ok(timer.deliver() > 0);
          await entered.promise;
          assert.equal(backendClosed, true);
          await turn();
          assert.equal(
            joined,
            false,
            "native/backend closure does not establish the whole saved operation completed",
          );
        } finally {
          release.resolve();
          await pending;
        }
        assert.equal(joined, true);
        assert.equal(timer.active(), 0);
        assert.equal(
          f.editor.providerDocuments().includes(f.document.asDocument()),
          true,
        );
      },
      operations,
    );
  });
}

test("dispose seals queued background admission and join never resurrects a timer", async () => {
  const timer = clock();
  let calls = 0;
  await withNavigationFixture(
    {
      schedule: timer.schedule,
      runProcess: async () => {
        calls++;
        throw new Error("a disposed producer cannot run");
      },
    },
    async (f) => {
      assert.ok(timer.active() > 0);
      const pending = f.editor.join();
      f.editor.dispose();
      await pending;
      assert.equal(timer.deliver(), 0);
      await f.editor.join();
      assert.equal(calls, 0);
      assert.equal(timer.active(), 0);
      f.editor.checkBackground(f.document.asDocument());
      f.editor.open(f.document.asDocument());
      f.editor.saved(f.document.asDocument());
      f.editor.change(f.document.asDocument());
      f.editor.configureRoots();
      f.editor.refresh();
      await f.editor.checkWorkspace();
      await f.editor.check(f.document.asDocument());
      await f.editor.join();
      assert.equal(
        calls,
        0,
        "retired public callbacks cannot admit another backend or timer",
      );
      assert.equal(timer.active(), 0);
    },
    operations,
  );
});

test("join includes work admitted by a queued refresh and preserves handled background failure", async () => {
  const timer = clock();
  const entered = deferred<void>(),
    release = deferred<void>();
  const failure = new Error("controlled background rejection");
  let joined = false;
  await withNavigationFixture(
    {
      schedule: timer.schedule,
      runProcess: async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      },
    },
    async (f) => {
      const pending = f.editor.join().then(() => {
        joined = true;
      });
      try {
        timer.deliver();
        await entered.promise;
        await turn();
        assert.equal(joined, false);
      } finally {
        release.resolve();
        await pending;
      }
      assert.equal(joined, true);
      assert.ok(f.lines.some((line) => line === failure.message));
      assert.equal(timer.active(), 0);
    },
    operations,
  );
});
