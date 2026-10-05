import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { SnapshotIndex, hash } from "../../src/protocol.ts";
import type { QueryReport } from "../../src/navigation-protocol.ts";
import type { validateNavigation } from "../../src/navigation.ts";
import type { Uri } from "vscode";

const bundled = await build({
  entryPoints: ["src/navigation.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "overlay-api",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "overlay-api",
        }));
        builder.onLoad({ filter: /.*/, namespace: "overlay-api" }, () => ({
          contents: "module.exports = globalThis.api",
          loader: "js",
        }));
      },
    },
  ],
});

test("verified reference aliases use buffer spans and decline foreign, stale or missing owners", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "saltbox-navigation-overlay-")),
  );
  const sourcePath = "roles/a/defaults/reverse.yml";
  const alias = "roles/a/templates/reverse.yaml";
  const foreign = "roles/a/templates/foreign.j2";
  const text = "{{ value }}\n{# dirty buffer #}";
  const digest = hash(text);
  const uri = (filename: string) => ({
    scheme: "file",
    fsPath: filename,
    toString: () => filename,
  });
  const module = {
    exports: {} as { validateNavigation: typeof validateNavigation },
  };
  class Range {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(a: number, b: number, c: number, d: number) {
      this.start = { line: a, character: b };
      this.end = { line: c, character: d };
    }
  }
  class Location {
    readonly uri: unknown;
    readonly range: Range;
    constructor(uri: unknown, range: Range) {
      this.uri = uri;
      this.range = range;
    }
  }
  runInNewContext(bundled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    Buffer,
    api: {
      Uri: { file: uri },
      Range,
      Location,
      workspace: { textDocuments: [] },
    },
  });
  const report: QueryReport = {
    schema_version: 1,
    root,
    path: sourcePath,
    source_sha256: digest,
    operation: "references",
    offset: 3,
    state: "none",
    reasons: [],
    coverage: { complete: false, reasons: ["static-reads-only"] },
    target_hashes: { [alias]: digest },
    locations: [
      {
        path: alias,
        span: { start: 3, end: 8 },
        line: 1,
        column: 4,
        text: "value",
        kind: "read",
      },
    ],
    declarations: [],
    completions: [],
    dependencies: {
      schema_version: 1,
      root,
      generation: digest,
      complete: true,
      sources: [
        {
          path: sourcePath,
          source_sha256: digest,
          files: [
            { path: sourcePath, sha256: digest, state: "read" },
            { path: alias, sha256: digest, state: "read" },
          ],
          identity: [],
          discovery: [],
          directories: [],
        },
      ],
    },
  };
  const originalURI = uri(join(root, "reverse-alias.j2")) as unknown as Uri;
  const validate = (paths?: ReadonlySet<string>) =>
    module.exports.validateNavigation(
      report,
      text,
      new SnapshotIndex(text),
      originalURI,
      paths,
    );
  try {
    await mkdir(join(root, "roles/a/defaults"), { recursive: true });
    await mkdir(join(root, "roles/a/templates"), { recursive: true });
    await writeFile(join(root, sourcePath), "saved contents");
    await symlink(join(root, sourcePath), join(root, alias), "file");
    assert.equal(
      await validate(),
      undefined,
      "an unobserved alias cannot bypass disk validation",
    );
    const answer = await validate(new Set([alias]));
    assert.ok(answer);
    const location = answer.locations.get(report.locations[0]);
    assert.equal(location?.uri, originalURI);
    assert.equal(location?.range.start.character, 3);
    assert.equal(location?.range.end.character, 8);
    report.target_hashes[alias] = hash("saved contents");
    assert.equal(
      await validate(new Set([alias])),
      undefined,
      "overlay target hashes must match the buffer",
    );
    report.target_hashes[alias] = digest;
    await writeFile(join(root, foreign), text);
    await rm(join(root, alias));
    await symlink(join(root, foreign), join(root, alias), "file");
    assert.equal(
      await validate(new Set([alias])),
      undefined,
      "identical contents do not confer source ownership",
    );
    await rm(join(root, alias));
    assert.equal(
      await validate(new Set([alias])),
      undefined,
      "a missing alias cannot retain ownership",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
