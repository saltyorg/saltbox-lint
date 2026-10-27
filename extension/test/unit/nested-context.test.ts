import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ProcessRequest } from "../../src/process.ts";
import type { AnalysisRecord } from "../../src/protocol.ts";
import { hash } from "../../src/protocol.ts";
import {
  withNavigationFixture,
  type NavigationFixture,
} from "../support/navigation-fixture.ts";
import { fileClock, settleFiles } from "../support/file-clock.ts";

// The marked parent root analyzes its source together with a target declared
// below a nested workspace folder. VS Code's getWorkspaceFolder returns the
// innermost folder for that target, but the parent's results still depend on it.
async function wire(
  request: ProcessRequest,
  f: NavigationFixture,
): Promise<string> {
  if (request.args[0] === "--version") return "fixture backend\n";
  if (request.args[0] === "rules")
    return JSON.stringify({ schema_version: 1, rules: [] });
  assert.equal(request.args[0], "check");
  const slash = (filename: string) =>
    relative(f.root, filename).replaceAll("\\", "/");
  const source = slash(f.source),
    target = slash(f.target);
  const selected =
    request.input !== undefined
      ? [slash(request.args[request.args.indexOf("--stdin-filename") + 1])]
      : request.args.slice(request.args.indexOf("--") + 1);
  const paths = selected.includes(".") ? [source, target] : selected;
  const targetBytes = await readFile(f.target);
  const sources: AnalysisRecord["sources"] = [];
  for (const path of paths) {
    const bytes =
      request.input !== undefined
        ? Buffer.from(request.input)
        : await readFile(join(f.root, ...path.split("/")));
    sources.push({
      path,
      source_sha256: hash(bytes),
      files: [
        { path, sha256: hash(bytes), state: "read" },
        ...(path === source
          ? [
              {
                path: target,
                sha256: hash(targetBytes),
                state: "read" as const,
              },
            ]
          : []),
      ],
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

test(
  "saving below a nested workspace folder invalidates the containing parent root",
  { timeout: 60000 },
  async () => {
    const timer = fileClock();
    const requests: ProcessRequest[] = [];
    let fixture!: NavigationFixture;
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
        const nested = join(f.root, "roles", "target");
        f.setWorkspaceFolders([f.root, nested]);
        await settleFiles(f.editor, timer);
        await f.editor.check(f.document.asDocument(), true);
        await settleFiles(f.editor, timer);
        const source = f.document.asDocument();
        assert.equal(f.editor.status(source).state, "current");
        const sourceChecks = () =>
          requests.filter(
            (request) =>
              request.args[0] === "check" &&
              request.args.includes(f.source) &&
              request.input !== undefined,
          ).length;
        const before = sourceChecks();
        await writeFile(f.target, "target_role_port: 43\n");
        f.editor.saved(f.targetDocument.asDocument());
        await settleFiles(f.editor, timer);
        assert.equal(
          sourceChecks(),
          before + 1,
          "the parent root rechecks its source after the nested dependency changed",
        );
        assert.equal(f.editor.status(source).state, "current");
      },
      operations,
    );
  },
);
