import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
