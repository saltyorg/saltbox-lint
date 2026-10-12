import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runProfile } from "../host/profile.ts";
import type {
  runQualification,
  observeQualificationProcesses,
} from "../host/qualification.ts";
import { deferred } from "../support/navigation-fixture.ts";

const bundle = await build({
  stdin: {
    contents:
      'export { runProfile } from "./test/host/profile.ts"; export { runQualification, observeQualificationProcesses } from "./test/host/qualification.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

function contains(error: unknown, expected: Error): boolean {
  return (
    error === expected ||
    (error instanceof Error && contains(error.cause, expected)) ||
    (error instanceof AggregateError &&
      error.errors.some((part: unknown) => contains(part, expected)))
  );
}

function load(api: unknown, env: NodeJS.ProcessEnv = {}) {
  const module = {
    exports: {} as {
      runProfile: typeof runProfile;
      runQualification: typeof runQualification;
      observeQualificationProcesses: typeof observeQualificationProcesses;
    },
  };
  const nativeRequire = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name: string) => (name === "vscode" ? api : nativeRequire(name)),
    process: { ...process, platform: "linux", env },
    Buffer,
    AbortController,
    Error,
    AggregateError,
    setTimeout,
    clearTimeout,
    console,
    performance,
  });
  return module.exports;
}

function fixture(stage: "activation" | "write") {
  const entered = deferred<void>();
  const release = deferred<void>();
  const counts = { writes: 0, opens: 0, shows: 0, commands: 0 };
  const api = {
    extensions: {
      getExtension: () => ({
        extensionPath: "/installed",
        activate() {
          if (stage !== "activation") return Promise.resolve(undefined);
          entered.resolve();
          return release.promise;
        },
      }),
    },
    Uri: { joinPath: () => ({ fsPath: "/workspace/operator.yml" }) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
      fs: {
        writeFile() {
          counts.writes++;
          if (stage !== "write") return Promise.resolve(undefined);
          entered.resolve();
          return release.promise;
        },
      },
      openTextDocument() {
        counts.opens++;
        return Promise.resolve({});
      },
    },
    window: {
      showTextDocument() {
        counts.shows++;
        return Promise.resolve(undefined);
      },
    },
    commands: {
      executeCommand() {
        counts.commands++;
        return Promise.resolve(undefined);
      },
    },
  };
  return { ...load(api), entered, release, counts };
}

test("qualification process observation ignores only native disappearance and propagates unknown read failures", async (context) => {
  const { observeQualificationProcesses: observe } = load({});
  const signal = new AbortController().signal;
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", undefined]) {
    await context.test(code ?? "unknown error", async () => {
      const failure = Object.assign(new Error("command line read failed"), {
        code,
      });
      const pending = observe("/installed/bin/saltbox-lint", signal, {
        readDirectory: async () => ["not-a-pid", "41", "42"],
        readCommandLine: async (filename) => {
          if (filename === "/proc/41/cmdline") throw failure;
          return "/installed/bin/saltbox-lint\0--version";
        },
      });
      if (code === "ENOENT" || code === "ESRCH")
        assert.deepEqual(Array.from(await pending), [42]);
      else await assert.rejects(pending, (error: unknown) => error === failure);
    });
  }
  const failure = new Error("process directory is unavailable");
  await assert.rejects(
    observe("/installed/bin/saltbox-lint", signal, {
      readDirectory: async () => {
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
});

test("qualification's closed-editor record waits for actual dirty-tab absence after public revert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-operator-closed-"));
  const destination = join(directory, "result.json");
  const parent = new AbortController();
  const discarded = deferred<void>();
  const listeners = new Set<(event: { closed: unknown[] }) => void>();
  let formatCalls = 0;
  let rawCloseCalls = 0;
  let discardCalls = 0;
  let settled = false;
  class URI {
    readonly fsPath: string;
    constructor(filename: string) {
      this.fsPath = filename;
    }
    toString() {
      return "file://" + this.fsPath;
    }
  }
  class TabInputText {
    readonly uri: URI;
    constructor(uri: URI) {
      this.uri = uri;
    }
  }
  class WorkspaceEdit {
    text = "";
    replace(_uri: unknown, _range: unknown, text: string) {
      this.text = text;
    }
  }
  const uri = new URI(join(directory, "qualification.yml"));
  const document = {
    uri,
    text: "value: initial\n",
    isDirty: false,
    getText() {
      return this.text;
    },
    positionAt(offset: number) {
      return { line: 0, character: offset };
    },
  };
  const group: {
    isActive: boolean;
    viewColumn: number;
    tabs: unknown[];
    activeTab?: unknown;
  } = { isActive: true, viewColumn: 1, tabs: [] };
  const tab = {
    group,
    input: new TabInputText(uri),
    label: "qualification.yml",
  };
  group.tabs = [tab];
  group.activeTab = tab;
  const event = (listener: (change: { closed: unknown[] }) => void) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  const api = {
    extensions: {
      getExtension: () => ({
        extensionPath: "/installed",
        activate: async () => undefined,
      }),
    },
    Uri: { joinPath: () => uri },
    TabInputText,
    Disposable: {
      from: (...items: { dispose(): unknown }[]) => ({
        dispose: () => items.forEach((item) => item.dispose()),
      }),
    },
    WorkspaceEdit,
    Range: class {},
    workspace: {
      workspaceFolders: [{ uri: new URI(directory) }],
      textDocuments: [document],
      fs: {
        writeFile: async (uri: URI, bytes: Uint8Array) =>
          writeFile(uri.fsPath, bytes),
      },
      openTextDocument: async () => document,
      applyEdit: async (edit: WorkspaceEdit) => {
        document.text = edit.text;
        document.isDirty = true;
        return true;
      },
    },
    window: {
      activeTextEditor: { document },
      tabGroups: {
        get all() {
          return group.tabs.length ? [group] : [];
        },
        onDidChangeTabs: event,
        onDidChangeTabGroups: event,
        async close() {
          rawCloseCalls++;
          return false;
        },
      },
      onDidChangeActiveTextEditor: event,
      showTextDocument: async () => ({ document }),
    },
    commands: {
      executeCommand: async (command: string) => {
        if (command === "workbench.action.revertAndCloseActiveEditor") {
          discardCalls++;
          discarded.resolve();
          return undefined;
        }
        if (command === "vscode.executeFormatDocumentProvider") {
          formatCalls++;
          return document.text.includes("canonical.yml") ||
            document.text.includes("skipped.yml")
            ? []
            : [{}];
        }
        return undefined;
      },
    },
  };
  const closeNativeTab = () => {
    document.isDirty = false;
    group.tabs = [];
    group.activeTab = undefined;
    // The minimum editor can report a group-only model change, with no closed
    // tab entry. The shared adapter must inspect actual current tab absence.
    for (const listener of listeners) listener({ closed: [] });
  };
  let outcome: Promise<unknown> | undefined;
  try {
    for (const name of [
      "diagnostic-heavy.yml",
      "flow-heavy.yml",
      "unicode.yml",
      "canonical.yml",
      "skipped.yml",
    ])
      await writeFile(join(directory, name), `# ${name}\nvalue: input\n`);
    const { runQualification } = load(api, {
      SALTBOX_QUALIFICATION_FIXTURES: directory,
      SALTBOX_QUALIFICATION_OUTPUT: destination,
    });
    outcome = runQualification(parent.signal, {
      readDirectory: async () => [],
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const boundary = await Promise.race([
      discarded.promise.then(() => "discard"),
      outcome.then(() => "completed"),
    ]);
    if (boundary === "completed") {
      const error = await outcome;
      if (error !== undefined) throw error;
    }
    assert.equal(
      boundary,
      "discard",
      "preserveFocus cannot replace actual dirty-tab closure",
    );
    assert.equal(formatCalls, 100);
    assert.equal(discardCalls, 1);
    assert.equal(rawCloseCalls, 0);
    assert.equal(group.tabs.length, 1);
    assert.equal(settled, false);
    assert.equal(
      existsSync(destination),
      false,
      "no final closed-editor record exists before native absence",
    );
    closeNativeTab();
    assert.equal(await outcome, undefined);
    const record = JSON.parse(await readFile(destination, "utf8")) as {
      samples: unknown[];
      resources: unknown[];
      finalChildren: number[];
    };
    assert.equal(record.samples.length, 100);
    assert.equal(record.resources.length, 20);
    assert.deepEqual(record.finalChildren, []);
    assert.equal(listeners.size, 0);
  } finally {
    closeNativeTab();
    parent.abort(new Error("operator fixture released"));
    await outcome;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["runProfile", "runQualification"] as const) {
  for (const stage of ["activation", "write"] as const) {
    test(`${mode} joins admitted ${stage} after parent cancellation and prevents the next SDK operation`, async () => {
      const f = fixture(stage);
      const parent = new AbortController();
      const reason = new Error("operator cancelled");
      let settled = false;
      const pending = f[mode](parent.signal);
      const outcome = pending.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await f.entered.promise;
        parent.abort(reason);
        await Promise.resolve();
        assert.equal(
          settled,
          false,
          "parent cancellation is not operation settlement",
        );
        f.release.resolve();
        assert.ok(
          contains(await outcome, reason),
          "the parent cancellation remains the primary cause",
        );
        assert.equal(f.counts.writes, stage === "write" ? 1 : 0);
        assert.equal(f.counts.opens, 0);
        assert.equal(f.counts.shows, 0);
        assert.equal(f.counts.commands, 0);
      } finally {
        f.release.resolve();
        parent.abort(reason);
        await outcome;
      }
    });
  }
}
