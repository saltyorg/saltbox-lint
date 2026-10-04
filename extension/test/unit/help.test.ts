import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { RuleHelp } from "../../src/help.ts";
import type { ProcessRequest } from "../../src/process.ts";

// Bundle the production owner with only editor APIs and process I/O replaced.
// Held promises prove admission and joining without timing assumptions.
const bundled = await build({
  entryPoints: ["src/help.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "help-io",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "help-io",
        }));
        builder.onResolve(
          { filter: /\/process\.ts$|^\.\/process\.ts$/ },
          () => ({
            path: "process",
            namespace: "help-io",
          }),
        );
        builder.onLoad({ filter: /.*/, namespace: "help-io" }, ({ path }) => ({
          contents:
            path === "process"
              ? "export const runProcess = globalThis.helpIO.runProcess"
              : "module.exports = globalThis.helpIO.vscode",
          loader: "js",
        }));
      },
    },
  ],
});
const rule = {
  id: "a-rule",
  summary: "Summary",
  explanation: "Explanation",
  source_kinds: ["generic"],
  scope: "file",
  good_example: "v: good",
  bad_example: "v: bad",
  fixable: true,
};
const registry = JSON.stringify({ schema_version: 1, rules: [rule] });
function latch<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const calls: {
    request: ProcessRequest;
    signal: AbortSignal;
    finish: ReturnType<typeof latch<string>>;
    joined: ReturnType<typeof latch<void>>;
  }[] = [];
  let next = latch<void>();
  const disposable = { dispose() {} };
  class MarkdownString {
    value = "";
    appendMarkdown(value: string) {
      this.value += value;
      return this;
    }
    appendText(value: string) {
      this.value += value;
      return this;
    }
  }
  const module = { exports: {} as { RuleHelp: typeof RuleHelp } };
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    AbortController,
    helpIO: {
      runProcess(request: ProcessRequest, signal: AbortSignal) {
        const finish = latch<string>();
        const joined = latch<void>();
        calls.push({ request, signal, finish, joined });
        next.resolve();
        next = latch<void>();
        return finish.promise.finally(() => joined.resolve());
      },
      vscode: {
        MarkdownString,
        EventEmitter: class {
          event = () => disposable;
          fire() {}
          dispose() {}
        },
        Disposable: { from: () => disposable },
        workspace: {
          registerTextDocumentContentProvider: () => disposable,
          openTextDocument: async (uri: unknown) => ({ uri }),
        },
        languages: { registerHoverProvider: () => disposable },
        Uri: {
          from: (uri: { path: string }) => ({ toString: () => uri.path }),
        },
        window: { showTextDocument: async () => undefined },
        commands: { executeCommand: async () => undefined },
        ViewColumn: { Beside: 2 },
      },
    },
  });
  return {
    calls,
    owner: (executable = "/cli/one") => new module.exports.RuleHelp(executable),
    async started(count: number) {
      while (calls.length < count) await next.promise;
      return calls[count - 1];
    },
  };
}

test("overlapping manual help shares pending version, registry and retries refresh", async () => {
  const f = fixture();
  const help = f.owner();
  try {
    const commands = Array.from({ length: 12 }, () => help.explain("a-rule"));
    assert.equal(f.calls.length, 1, "one unfinished version observation");
    assert.deepEqual(Array.from(f.calls[0].request.args), ["--version"]);
    f.calls[0].finish.resolve("v1");
    const rules = await f.started(2);
    assert.deepEqual(Array.from(rules.request.args), [
      "rules",
      "--format",
      "json",
    ]);
    rules.finish.resolve(registry);
    assert.ok((await Promise.all(commands)).every((value) => value?.value));
    const again = help.registry(true);
    const version = await f.started(3);
    version.finish.resolve("v1");
    await again;
    assert.equal(
      f.calls.length,
      3,
      "completed version refresh reuses registry",
    );
    const changed = help.registry(true);
    (await f.started(4)).finish.resolve("v2");
    (await f.started(5)).finish.resolve(registry);
    await changed;
    assert.equal(f.calls.length, 5, "changed version loads its own registry");
  } finally {
    help.dispose();
  }
});

test("version refresh queues behind earlier registry and executable owners stay independent", async () => {
  const f = fixture();
  const one = f.owner();
  const two = f.owner("/cli/two");
  try {
    const first = one.registry(true);
    f.calls[0].finish.resolve("v1");
    const oldRules = await f.started(2);
    const refreshed = one.registry(true);
    assert.equal(
      f.calls.length,
      2,
      "refresh cannot overlap held registry child",
    );
    assert.equal(
      oldRules.signal.aborted,
      false,
      "refresh retains earlier work",
    );
    const peer = two.registry(true);
    const peerVersion = await f.started(3);
    assert.equal(peerVersion.request.executable, "/cli/two");
    peerVersion.finish.resolve("v1");
    (await f.started(4)).finish.resolve(registry);
    await peer;
    oldRules.finish.resolve(registry);
    const newVersion = await f.started(5);
    assert.equal(newVersion.request.executable, "/cli/one");
    newVersion.finish.resolve("v2");
    (await f.started(6)).finish.resolve(registry);
    await Promise.all([first, refreshed]);
  } finally {
    one.dispose();
    two.dispose();
  }
});

test("failed version and registry observations remain retryable", async () => {
  const f = fixture();
  const help = f.owner();
  try {
    const failed = assert.rejects(help.registry(true), /version failed/);
    f.calls[0].finish.reject(new Error("version failed"));
    await failed;
    const invalid = assert.rejects(help.registry(), /registry/i);
    (await f.started(2)).finish.resolve("v1");
    (await f.started(3)).finish.resolve("{}");
    await invalid;
    const retry = help.registry();
    (await f.started(4)).finish.resolve(registry);
    await retry;
    assert.equal(f.calls.length, 4);
  } finally {
    help.dispose();
  }
});

test("disposing help cancels its active child, joins exit and prevents queued and late work", async () => {
  const f = fixture();
  const help = f.owner();
  const first = help.registry(true);
  f.calls[0].finish.resolve("v1");
  const active = await f.started(2);
  const queued = help.registry(true);
  assert.equal(
    f.calls.length,
    2,
    "disposal test retains queued refresh without launching it",
  );
  const outcomes = Promise.allSettled([first, queued]);
  let settled = false;
  void first
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  help.dispose();
  assert.equal(active.signal.aborted, true);
  assert.equal(settled, false, "active child is joined before request settles");
  active.finish.reject(new Error("Canceled"));
  assert.ok((await outcomes).every((outcome) => outcome.status === "rejected"));
  await assert.rejects(help.registry(true), /Canceled/);
  assert.equal(
    f.calls.length,
    2,
    "queued and late requests never launch children",
  );
});
