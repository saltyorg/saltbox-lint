import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { EditorIntegration } from "../../src/editor.ts";
import type { TextDocument } from "vscode";

const bundled = await build({
  entryPoints: ["src/editor.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "template-capability-api",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "template-capability-api",
        }));
        builder.onLoad(
          { filter: /.*/, namespace: "template-capability-api" },
          () => ({
            contents: "module.exports = globalThis.templateAPI",
            loader: "js",
          }),
        );
      },
    },
  ],
});

for (const native of ["posix", "windows"] as const) {
  test(`${native} canonical template capabilities preserve identity and block direct writes`, async () => {
    for (const scenario of [
      "regular",
      "narrow",
      "alias",
      "yaml",
      "narrow yaml",
    ] as const) {
      const fullRoot = native === "windows" ? "C:\\workspace" : "/workspace";
      const physical = (relative: string) =>
        `${fullRoot}${native === "windows" ? "\\" : "/"}${native === "windows" ? relative.replaceAll("/", "\\") : relative}`;
      const template = !scenario.includes("yaml");
      const narrowed =
        scenario === "narrow" ||
        scenario === "alias" ||
        scenario === "narrow yaml";
      const relative = template
        ? "roles/a/templates/config.yaml"
        : "roles/a/defaults/main.yml";
      const root = narrowed
        ? physical(template ? "roles/a/templates" : "roles/a/defaults")
        : fullRoot;
      const filename = physical(relative);
      const sourcePath = narrowed
        ? relative.slice(relative.lastIndexOf("/") + 1)
        : relative;
      const uriPath =
        scenario === "alias"
          ? "/workspace/readonly-alias/config.yaml"
          : `/workspace/${relative}`;
      const uri = {
        scheme: "file",
        path: uriPath,
        toString: () => `file://${uriPath}`,
      };
      const identity = Object.freeze({ root, filename, path: sourcePath });
      const before = JSON.stringify(identity);
      const document = {
        uri,
        languageId: "yaml",
        isClosed: false,
        version: 1,
        getText: () => "{{ value }}",
      } as unknown as TextDocument;
      const folder = { uri: { toString: () => "folder" } };
      const module = {
        exports: {} as { EditorIntegration: typeof EditorIntegration },
      };
      runInNewContext(bundled.outputFiles[0].text, {
        module,
        exports: module.exports,
        require: createRequire(import.meta.url),
        process,
        Buffer,
        AbortController,
        setTimeout,
        clearTimeout,
        templateAPI: {
          workspace: {
            isTrusted: true,
            getWorkspaceFolder: () => folder,
            textDocuments: [document],
          },
        },
      });
      let snapshots = 0;
      const editor = Object.assign(
        Object.create(module.exports.EditorIntegration.prototype) as Pick<
          EditorIntegration,
          "providerDocuments" | "isTemplate" | "writable" | "format" | "fixAll"
        >,
        {
          disposed: false,
          closedTabs: new Set(),
          roots: { get: () => root, refresh: async () => {} },
          sourceOwners: new Map([[uri.toString(), identity]]),
          rootRevisions: new Map(),
          documentRevisions: new WeakMap(),
          nextRevision: 0,
          snapshot: async () => {
            snapshots++;
            throw new Error(
              "read-only capability reached disk or subprocess work",
            );
          },
        },
      );
      assert.equal(
        editor.providerDocuments().includes(document),
        true,
        scenario,
      );
      assert.equal(editor.isTemplate(document), template, scenario);
      assert.equal(editor.writable(document), !template, scenario);
      if (template) {
        for (const mode of ["canonical", "lint-fixes"] as const)
          assert.equal(
            (await editor.format(document, mode)).length,
            0,
            scenario,
          );
        await editor.fixAll(document.uri);
        assert.equal(
          snapshots,
          0,
          "direct write guards run before source reads or process work",
        );
      }
      assert.equal(
        JSON.stringify(identity),
        before,
        "classification preserves canonical filename, source path and root",
      );
    }
  });
}
