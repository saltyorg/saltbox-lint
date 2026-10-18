import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function inspectAdmission(
  work: Promise<void>,
  admission: Promise<void>,
  release: () => void,
  inspect: () => Promise<void>,
) {
  const outcome = work.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const failures: unknown[] = [];
  try {
    await Promise.race([
      admission,
      outcome.then((result) => {
        if (!result.ok) throw result.error;
        throw new Error("Close settled before discard admission");
      }),
    ]);
    await inspect();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
    const result = await outcome;
    if (!result.ok && !failures.includes(result.error))
      failures.push(result.error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Held tab test failed", {
      cause: failures[0],
    });
}

async function tabHost(dirty = false) {
  const uri = (name: string) => ({
    scheme: "file",
    fsPath: "/fixture/" + name,
    toString: () => "file:///fixture/" + name,
  });
  class TextInput {
    readonly uri: ReturnType<typeof uri>;
    constructor(value: ReturnType<typeof uri>) {
      this.uri = value;
    }
  }
  class OtherInput {}
  const owned = { uri: uri("actual.yml"), isDirty: dirty };
  const foreign = { uri: uri("foreign.yml"), isDirty: false };
  type Tab = { input: unknown; label: string; isActive: boolean; group: Group };
  type Group = {
    viewColumn: number;
    isActive: boolean;
    activeTab?: Tab;
    tabs: Tab[];
  };
  let group: Group = { viewColumn: 1, isActive: true, tabs: [] };
  const make = (document: typeof owned): Tab => ({
    input: new TextInput(document.uri),
    label: document.uri.fsPath,
    isActive: document === owned,
    group,
  });
  group.tabs = [make(owned), make(foreign)];
  group.activeTab = group.tabs[0];
  const listeners = new Set<(event: { closed: Tab[] }) => void>();
  const activeListeners = new Set<() => void>();
  const groupListeners = new Set<(event: { closed: Group[] }) => void>();
  const calls: string[] = [];
  const receipts: string[] = [];
  const subscribe = <T>(set: Set<T>, listener: T) => {
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  };
  const remove = (tab: Tab, modelOnly: boolean) => {
    assert.ok(
      group.tabs.includes(tab),
      "only fresh SDK tab snapshots may close",
    );
    const survivors = group.tabs.filter((item) => item !== tab);
    group = { ...group, tabs: [] };
    group.tabs = survivors.map((item) => ({ ...item, group }));
    group.activeTab = group.tabs.find((item) => item.isActive);
    if (modelOnly)
      for (const listener of groupListeners) listener({ closed: [] });
    else for (const listener of listeners) listener({ closed: [tab] });
  };
  const api = {
    TabInputText: TextInput,
    TabInputTextDiff: OtherInput,
    TabInputNotebook: OtherInput,
    TabInputNotebookDiff: OtherInput,
    TabInputCustom: OtherInput,
    TabInputWebview: OtherInput,
    TabInputTerminal: OtherInput,
    Disposable: {
      from: (...items: { dispose(): unknown }[]) => ({
        dispose: () => {
          for (const item of items) item.dispose();
        },
      }),
    },
    workspace: { textDocuments: [owned, foreign] },
    window: {
      activeTextEditor: { document: owned },
      tabGroups: {
        get all() {
          return [group];
        },
        onDidChangeTabs: (listener: (event: { closed: Tab[] }) => void) =>
          subscribe(listeners, listener),
        onDidChangeTabGroups: (
          listener: (event: { closed: Group[] }) => void,
        ) => subscribe(groupListeners, listener),
        close: async (tab: Tab) => {
          assert.ok(listeners.size > 0);
          assert.ok(tab.input instanceof TextInput);
          calls.push("close " + tab.input.uri.fsPath);
          remove(tab, true);
          return true;
        },
      },
      onDidChangeActiveTextEditor: (listener: () => void) =>
        subscribe(activeListeners, listener),
      showTextDocument: async (document: typeof owned) => {
        calls.push("show " + document.uri.fsPath);
        api.window.activeTextEditor.document = document;
        group.activeTab = group.tabs.find(
          (tab) =>
            tab.input instanceof TextInput && tab.input.uri === document.uri,
        );
        for (const listener of activeListeners) listener();
        return { document };
      },
    },
    commands: {
      executeCommand: async (_command: string) => {
        assert.ok(listeners.size > 0);
        const tab = group.activeTab;
        assert.ok(tab);
        assert.ok(tab.input instanceof TextInput);
        calls.push("discard " + tab.input.uri.fsPath);
        owned.isDirty = false;
        remove(tab, false);
      },
    },
  };
  const bundle = await build({
    entryPoints: ["test/support/editor-tabs.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "error",
    plugins: [
      {
        name: "instance-public-sdk",
        setup(builder) {
          builder.onResolve({ filter: /^vscode$/ }, () => ({
            path: "vscode",
            namespace: "private-sdk",
          }));
          builder.onLoad({ filter: /.*/, namespace: "private-sdk" }, () => ({
            contents: "module.exports = globalThis.api",
            loader: "js",
          }));
        },
      },
    ],
  });
  const module = {
    exports: {} as {
      closeEditorTabs(
        signal: AbortSignal,
        uris?: readonly ReturnType<typeof uri>[],
      ): Promise<void>;
    },
  };
  runInNewContext(bundle.outputFiles[0].text, {
    api,
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    console: {
      log: (line: string) => receipts.push(line),
      error: () => {},
    },
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    AbortController,
  });
  return {
    owned,
    foreign,
    api,
    calls,
    receipts,
    TextInput,
    close: module.exports.closeEditorTabs,
    remaining: () => group.tabs,
    subscriptions: () =>
      listeners.size + groupListeners.size + activeListeners.size,
  };
}

test("the real public adapter closes only captured actual URIs through fresh model-only snapshots", async () => {
  const host = await tabHost();
  await host.close(new AbortController().signal, [host.owned.uri]);
  assert.deepEqual(host.calls, ["close /fixture/actual.yml"]);
  assert.deepEqual(
    host.remaining().map((tab) => {
      assert.ok(tab.input instanceof host.TextInput);
      return tab.input.uri.toString();
    }),
    [host.foreign.uri.toString()],
  );
  assert.equal(host.subscriptions(), 0);
  const receipt = JSON.parse(
    host.receipts[0].slice("SALTBOX_EDITOR_TABS ".length),
  );
  assert.equal(receipt.before.length, 1);
  assert.deepEqual(receipt.before[0].uris, [host.owned.uri.toString()]);
  assert.deepEqual(receipt.after, []);
  assert.equal(receipt.joined, true);
});

test("requested alias spelling cannot silently substitute for an actual model URI", async () => {
  const host = await tabHost();
  const requested = {
    ...host.owned.uri,
    toString: () => "file:///fixture/alias.yml",
  };
  await host.close(new AbortController().signal, [requested]);
  assert.deepEqual(host.calls, []);
  assert.equal(host.remaining().length, 2);
  assert.equal(host.subscriptions(), 0);
  const receipt = JSON.parse(
    host.receipts[0].slice("SALTBOX_EDITOR_TABS ".length),
  );
  assert.deepEqual(receipt.before, []);
});

test("dirty selected closure observes the event but still joins the admitted discard command", async () => {
  const host = await tabHost(true);
  const original = host.api.commands.executeCommand;
  const entered = deferred(),
    release = deferred();
  host.api.commands.executeCommand = async (command) => {
    await original(command);
    entered.resolve();
    await release.promise;
  };
  let settled = false;
  const pending = host
    .close(new AbortController().signal, [host.owned.uri])
    .then(() => {
      settled = true;
    });
  await inspectAdmission(
    pending,
    entered.promise,
    release.resolve,
    async () => {
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(host.remaining().length, 1);
    },
  );
  assert.deepEqual(host.calls, [
    "show /fixture/actual.yml",
    "discard /fixture/actual.yml",
  ]);
  assert.equal(host.subscriptions(), 0);
});

test("an actual show failure before discard admission is handled and joined", async () => {
  const host = await tabHost(true);
  const original = new Error("show rejected before discard");
  host.api.window.showTextDocument = async () => {
    throw original;
  };
  const admission = deferred();
  let released = false;
  await assert.rejects(
    inspectAdmission(
      host.close(new AbortController().signal, [host.owned.uri]),
      admission.promise,
      () => {
        released = true;
      },
      async () => assert.fail("unadmitted operation cannot be inspected"),
    ),
    (error: unknown) => error === original,
  );
  assert.equal(released, true);
  assert.equal(host.subscriptions(), 0);
  assert.deepEqual(host.receipts, []);
});

test("a refused selected tab close rejects and disposes every public listener", async () => {
  const host = await tabHost();
  host.api.window.tabGroups.close = async () => false;
  await assert.rejects(
    host.close(new AbortController().signal, [host.owned.uri]),
    /Owned tab close was refused/,
  );
  assert.equal(host.remaining().length, 2);
  assert.equal(host.subscriptions(), 0);
  assert.deepEqual(host.receipts, []);
});

test("selecting one side of a dirty diff cannot discard another resource", async () => {
  const host = await tabHost();
  host.foreign.isDirty = true;
  host.remaining()[0].input = Object.assign(new host.api.TabInputTextDiff(), {
    original: host.owned.uri,
    modified: host.foreign.uri,
  });
  await assert.rejects(
    host.close(new AbortController().signal, [host.owned.uri]),
    /Owned fixture tab contains another dirty resource/,
  );
  assert.equal(host.foreign.isDirty, true);
  assert.deepEqual(host.calls, []);
  assert.equal(host.subscriptions(), 0);
  assert.deepEqual(host.receipts, []);
});
