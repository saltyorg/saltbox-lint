import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  writeFile,
  symlink,
  rename,
} from "node:fs/promises";
import { unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { Dependencies } from "../../src/dependencies.ts";
import { hash, type AnalysisRecord } from "../../src/protocol.ts";
import { observeAnalysis } from "../../src/observations.ts";

const bundled = await build({
  entryPoints: ["src/editor.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "alias-event-api",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "alias-event-api",
        }));
        builder.onLoad({ filter: /.*/, namespace: "alias-event-api" }, () => ({
          contents: "module.exports = globalThis.aliasAPI",
          loader: "js",
        }));
      },
    },
  ],
});

for (const mode of [
  "unchanged",
  "unchanged canonical",
  "retargeted",
  "missing",
  "escaped",
  "retargeted during read",
  "changed canonical bytes",
  "changed canonical inode",
] as const) {
  test(`source event ${mode} preserves only unchanged canonical observations`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "saltbox-alias-events-")),
    );
    const source = "roles/example/tasks/main.yml";
    const filename = join(root, source);
    const alternate = join(root, "other.yml");
    const alias = join(root, "alias.yml");
    const external = join(
      root,
      "..",
      "escaped-" + root.split(/[\\/]/).at(-1) + ".yml",
    );
    const text = "[]\n";
    const uri = (filename: string) => ({
      scheme: "file",
      fsPath: filename,
      path: filename,
      toString: () => "file://" + filename,
    });
    const folder = { uri: uri(root) };
    try {
      await mkdir(join(root, "roles/example/tasks"), { recursive: true });
      await writeFile(filename, text);
      await writeFile(alternate, "- debug: {}\n");
      await symlink(filename, alias, "file");
      const record: AnalysisRecord = {
        schema_version: 1,
        root,
        generation: hash("generation"),
        complete: true,
        sources: [
          {
            path: source,
            source_sha256: hash(text),
            files: [{ path: source, state: "read", sha256: hash(text) }],
            identity: [],
            discovery: [],
            directories: [],
          },
        ],
      };
      const graph = new Dependencies();
      const observed = await observeAnalysis(record);
      assert.equal(observed.changed.size, 0);
      assert.equal(
        graph.accept(
          folder.uri.toString(),
          record,
          graph.begin(),
          true,
          [],
          observed.fingerprints,
        ),
        true,
      );
      const before = graph.revision(folder.uri.toString(), source);
      const canceled: string[] = [];
      let queryRevocations = 0;
      let retargeted = false;
      const originalRequire = createRequire(import.meta.url);
      const require = (id: string): unknown => {
        if (id !== "node:fs") return originalRequire(id) as unknown;
        const fs = originalRequire(id) as typeof import("node:fs");
        return {
          ...fs,
          readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
            const bytes = Reflect.apply(fs.readFileSync, fs, args);
            if (mode === "retargeted during read" && !retargeted) {
              retargeted = true;
              unlinkSync(alias);
              symlinkSync(alternate, alias, "file");
            }
            return bytes;
          },
        };
      };
      const module = {
        exports: {} as {
          EditorIntegration: {
            prototype: { removeFile: (uri: unknown) => void };
          };
        },
      };
      runInNewContext(bundled.outputFiles[0].text, {
        module,
        exports: module.exports,
        require,
        process,
        console,
        Buffer,
        AbortController,
        setTimeout,
        clearTimeout,
        aliasAPI: {
          Uri: {
            file: uri,
            parse: (value: string) => uri(value.slice("file://".length)),
          },
          workspace: { getWorkspaceFolder: () => folder, textDocuments: [] },
        },
      });
      const editor = Object.assign(
        Object.create(module.exports.EditorIntegration.prototype),
        {
          roots: { folder: () => folder, get: () => root },
          disposed: false,
          sourceOwners: new Map([
            [uri(alias).toString(), { root, filename, path: source }],
          ]),
          dependencies: graph,
          nextRevision: 0,
          revokeQueries() {
            queryRevocations++;
          },
          updateStatus() {},
          lint: { cancel: (key: string) => canceled.push(key) },
          formatting: { cancel() {} },
          queueFile() {},
          queueCoverage() {},
          results: { hasCompleteScan: () => true },
        },
      );
      if (mode === "retargeted") {
        unlinkSync(alias);
        symlinkSync(alternate, alias, "file");
      }
      if (mode === "missing") unlinkSync(alias);
      if (mode === "escaped") {
        await writeFile(external, "outside root\n");
        unlinkSync(alias);
        symlinkSync(external, alias, "file");
      }
      if (mode === "changed canonical inode") {
        await writeFile(filename + ".tmp", text);
        await rename(filename + ".tmp", filename);
      }
      if (mode === "changed canonical bytes")
        await writeFile(filename, "- debug: {}\n");
      editor.removeFile(uri(mode === "unchanged canonical" ? filename : alias));
      if (mode === "unchanged" || mode === "unchanged canonical") {
        assert.equal(
          graph.revision(folder.uri.toString(), source),
          before,
          "unchanged alias keeps canonical dependency revision",
        );
        assert.deepEqual(
          canceled,
          [],
          "unchanged alias keeps pending canonical work",
        );
        assert.equal(queryRevocations, 0);
      } else {
        assert.ok(graph.revision(folder.uri.toString(), source) > before);
        assert.ok(canceled.includes(uri(alias).toString()));
        assert.equal(queryRevocations, 1);
        if (mode === "retargeted during read") assert.equal(retargeted, true);
      }
    } finally {
      await rm(external, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}
