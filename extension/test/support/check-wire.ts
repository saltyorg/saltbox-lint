import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { ProcessRequest } from "../../src/process.ts";
import { hash, type AnalysisRecord } from "../../src/protocol.ts";

/** Scripted producer protocol with real source bytes at its filesystem boundary. */
export async function checkWire(
  request: ProcessRequest,
  fixture: { root: string; source: string; target: string },
): Promise<string> {
  if (request.args[0] === "--version") return "fixture backend\n";
  if (request.args[0] === "rules")
    return JSON.stringify({ schema_version: 1, rules: [] });
  assert.equal(request.args[0], "check");
  const source = relative(fixture.root, fixture.source).replaceAll("\\", "/");
  const target = relative(fixture.root, fixture.target).replaceAll("\\", "/");
  const selected =
    request.input !== undefined
      ? [
          relative(
            fixture.root,
            request.args[request.args.indexOf("--stdin-filename") + 1],
          ).replaceAll("\\", "/"),
        ]
      : request.args.slice(request.args.indexOf("--") + 1);
  const paths = selected.includes(".") ? [source, target] : selected;
  const sources: AnalysisRecord["sources"] = [];
  for (const path of paths) {
    assert.ok([source, target].includes(path));
    const bytes =
      request.input ??
      (await readFile(path === source ? fixture.source : fixture.target));
    const digest = hash(bytes);
    sources.push({
      path,
      source_sha256: digest,
      files: [{ path, sha256: digest, state: "read" }],
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
      root: fixture.root,
      generation: hash("generation"),
      complete: true,
      sources,
    },
  });
}
