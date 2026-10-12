import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { build } from "esbuild";
import type { TextDocument } from "vscode";
import type { runManualMarkerRefresh } from "../host/navigation.ts";

const bundled = await build({
  entryPoints: ["test/host/navigation.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "marker-fixture-io",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "marker-fixture-io",
        }));
        builder.onResolve({ filter: /\/editor\.ts$/ }, () => ({
          path: "editor",
          namespace: "marker-fixture-io",
        }));
        builder.onLoad(
          { filter: /.*/, namespace: "marker-fixture-io" },
          ({ path }) => ({
            contents:
              path === "editor"
                ? "export const EditorIntegration = globalThis.markerIO.EditorIntegration"
                : "module.exports = globalThis.markerIO.vscode",
            loader: "js",
          }),
        );
      },
    },
  ],
});

test("manual marker cleanup disposes its adapter and preserves both failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "saltbox-marker-failure-"));
  const primary = new Error("controlled manual impact failure");
  const cleanup = Object.assign(
    new Error("controlled marker removal failure"),
    {
      code: "EPERM",
    },
  );
  let disposed = false;
  let impacts = 0;
  let removals = 0;
  const document = {
    uri: { toString: () => "source" },
    getText: () => "lookup('role_var', '_port')",
    positionAt: () => ({}),
  };
  const vscode = {
    workspace: {
      getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
      createFileSystemWatcher() {},
    },
    window: {
      showTextDocument: async () => ({ selection: undefined }),
    },
    commands: { executeCommand: async () => undefined },
    Selection: class {},
  };
  const originalRequire = createRequire(import.meta.url);
  const require = (id: string) => {
    if (id === "vscode") return vscode;
    if (id === "node:module") return { createRequire: () => require };
    if (id === "node:fs") {
      const fs = originalRequire(id) as typeof import("node:fs");
      return {
        ...fs,
        unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
          if (++removals === 2) throw cleanup;
          return fs.unlinkSync(...args);
        },
      };
    }
    return originalRequire(id) as unknown;
  };
  const module = {
    exports: {} as {
      runManualMarkerRefresh: typeof runManualMarkerRefresh;
    },
  };
  try {
    writeFileSync(join(root, ".saltbox-lint"), "");
    runInNewContext(bundled.outputFiles[0].text, {
      module,
      exports: module.exports,
      require,
      __filename: import.meta.filename,
      process,
      setTimeout,
      markerIO: {
        vscode,
        EditorIntegration: class {
          navigation = {
            impact: async () => {
              if (++impacts === 2) {
                writeFileSync(join(root, ".saltbox-lint"), "");
                throw primary;
              }
              return {};
            },
          };
          dispose() {
            disposed = true;
          }
        },
      },
    });
    let failure: unknown;
    try {
      await module.exports.runManualMarkerRefresh(
        document as unknown as TextDocument,
      );
    } catch (error) {
      failure = error;
    }
    assert.equal(disposed, true, "cleanup errors cannot skip adapter disposal");
    assert.ok(failure && typeof failure === "object" && "errors" in failure);
    const errors = failure.errors as Error[];
    assert.equal(errors.length, 2);
    assert.equal(errors[0].cause, primary);
    assert.equal(errors[1].cause, cleanup);
    assert.match(errors[0].message, /replacement=removed.*marker=file/);
    assert.match(
      errors[1].message,
      /cleanup.*replacement=removed.*marker=file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  "waits for a pending context mutation before restoration",
  "closes admission before an outstanding context read returns",
  "restores context and propagates a rejected mutation",
] as const) {
  test(`manual marker cleanup ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "saltbox-marker-context-"));
    const source = join(root, "roles/navsource/tasks/main.yml");
    const context = join(root, "roles/navtarget/defaults/main.yml");
    mkdirSync(join(source, ".."), { recursive: true });
    mkdirSync(join(context, ".."), { recursive: true });
    writeFileSync(source, "lookup('role_var', '_port')");
    const contextBytes = Buffer.from("navtarget_role_port: 8080\n");
    writeFileSync(context, contextBytes);
    writeFileSync(join(root, ".saltbox-lint"), "");
    const contextFilename = realpathSync.native(context);
    const marker = join(root, ".saltbox-lint");
    const primary = new Error("controlled context command failure");
    const mutationFailure = new Error("controlled context mutation failure");
    const holdRead = scenario.includes("outstanding context read");
    const rejectMutation = scenario.includes("rejected mutation");
    let enter!: () => void;
    let releaseRead!: () => void;
    let releaseWrite!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let holdContextRead = false;
    let restorationWrites = 0;
    let refreshes = 0;
    let disposed = false;
    let impacts = 0;
    let backgroundRead: Promise<unknown> | undefined;
    const promises = {
      ...fsPromises,
      readFile: async (...args: Parameters<typeof fsPromises.readFile>) => {
        if (holdContextRead && args[0] === contextFilename) {
          enter();
          await readReleased;
        }
        return Reflect.apply(fsPromises.readFile, fsPromises, args);
      },
      writeFile: async (...args: Parameters<typeof fsPromises.writeFile>) => {
        if (args[0] === contextFilename) {
          if (
            Buffer.isBuffer(args[1]) &&
            args[1].toString().endsWith("# changed query context\n")
          ) {
            enter();
            await writeReleased;
            await Reflect.apply(fsPromises.writeFile, fsPromises, args);
            if (rejectMutation) throw mutationFailure;
            return;
          }
          restorationWrites++;
        }
        return Reflect.apply(fsPromises.writeFile, fsPromises, args);
      },
    };
    const childProcess = {
      spawn: (_file: string | undefined, _argv: string[]) => {
        const child = new EventEmitter();
        queueMicrotask(() => {
          child.emit("close", 0);
        });
        return child;
      },
    };
    const uri = (filename: string) => ({
      fsPath: filename,
      toString: () => filename,
    });
    const document = {
      uri: uri(source),
      getText: () => "lookup('role_var', '_port')",
      positionAt: () => ({}),
    };
    const vscode = {
      workspace: {
        getWorkspaceFolder: () => ({ uri: uri(root) }),
        createFileSystemWatcher() {},
      },
      Uri: {
        joinPath: (base: { fsPath: string }, relative: string) =>
          uri(join(base.fsPath, relative)),
      },
      window: {
        activeTextEditor: { document },
        showTextDocument: async () => ({ selection: undefined }),
      },
      commands: { executeCommand: async () => undefined },
      Selection: class {},
    };
    const originalRequire = createRequire(import.meta.url);
    const require = (id: string): unknown => {
      if (id === "vscode") return vscode;
      if (id === "node:module") return { createRequire: () => require };
      if (id === "node:fs/promises") return promises;
      if (id === "node:child_process") return childProcess;
      return originalRequire(id) as unknown;
    };
    const module = {
      exports: {} as {
        runManualMarkerRefresh: typeof runManualMarkerRefresh;
      },
    };
    runInNewContext(bundled.outputFiles[0].text, {
      module,
      exports: module.exports,
      require,
      __filename: import.meta.filename,
      process,
      Buffer,
      setTimeout,
      markerIO: {
        vscode,
        EditorIntegration: class {
          navigation = {
            impact: async () => {
              // Initial admission and three rejection/restoration pairs
              // precede the context query.
              if (++impacts === 8) {
                const child = childProcess.spawn(
                  process.env.SALTBOX_TEST_INSTALLED_CLI_PATH,
                  ["query", "references", realpathSync.native(source)],
                );
                await once(child, "close");
                holdContextRead = holdRead;
                backgroundRead = promises.readFile(contextFilename).then(
                  () => undefined,
                  (error: unknown) => error,
                );
                await entered;
                throw primary;
              }
              try {
                const stat = lstatSync(marker);
                return stat.isFile() && !stat.isSymbolicLink() ? {} : undefined;
              } catch {
                return undefined;
              }
            },
          };
          refresh() {
            refreshes++;
          }
          dispose() {
            disposed = true;
          }
        },
      },
    });
    const running = module.exports
      .runManualMarkerRefresh(document as unknown as TextDocument)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    try {
      await entered;
      if (holdRead) {
        const failure = await running;
        assert.equal((failure as Error).cause, primary);
        assert.equal(disposed, true);
        releaseWrite();
        releaseRead();
        await backgroundRead;
        assert.deepEqual(
          await fsPromises.readFile(contextFilename),
          contextBytes,
          "a read finishing after cleanup cannot mutate restored context",
        );
        assert.equal(
          refreshes,
          0,
          "a late read cannot refresh the disposed adapter",
        );
      } else {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        assert.equal(
          restorationWrites,
          0,
          "restoration waits for the already admitted mutation to settle",
        );
        assert.equal(
          disposed,
          false,
          "cleanup still owns the pending mutation",
        );
        releaseWrite();
        const failure = await running;
        assert.equal(
          (failure as Error).cause,
          rejectMutation ? mutationFailure : primary,
        );
        assert.equal(
          await backgroundRead,
          rejectMutation ? mutationFailure : undefined,
        );
        assert.equal(restorationWrites, 1);
        assert.deepEqual(
          await fsPromises.readFile(contextFilename),
          contextBytes,
        );
        assert.equal(disposed, true);
      }
    } finally {
      releaseRead();
      releaseWrite();
      await running;
      await backgroundRead;
      await rm(root, { recursive: true, force: true });
    }
  });
}
