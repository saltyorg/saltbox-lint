import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function unavailable(error: unknown) {
  return {
    state: "unavailable",
    error: error instanceof Error ? error.name : "unknown error",
  };
}

export function shippedProduct(appRoot: string) {
  try {
    const product: Record<string, unknown> = JSON.parse(
      readFileSync(join(appRoot, "product.json"), "utf8"),
    );
    const metadata: Record<string, string> = {};
    for (const key of [
      "version",
      "commit",
      "date",
      "quality",
      "nameShort",
      "applicationName",
    ])
      if (typeof product[key] === "string") metadata[key] = product[key];
    return { state: "available", metadata };
  } catch (error) {
    return unavailable(error);
  }
}

export function fileIdentity(filename: string | undefined) {
  if (!filename) return { state: "unavailable", error: "path not provided" };
  try {
    const bytes = readFileSync(filename);
    return {
      state: "available",
      path: filename,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return { path: filename, ...unavailable(error) };
  }
}

export function editorAcceptance(facts: {
  expectedVersion: string | undefined;
  actualVersion: string;
  platform: string;
  arch: string;
  mode: string | undefined;
  appRoot: string;
  controllerPath: string;
  cliPath: string | undefined;
  proxyPath: string | undefined;
}) {
  assert.ok(
    facts.expectedVersion,
    "host runner must provide expected editor version",
  );
  assert.ok(facts.mode, "host runner must provide mode association");
  assert.equal(
    facts.actualVersion,
    facts.expectedVersion,
    "actual public vscode.version must match expected editor version",
  );
  return {
    schemaVersion: 1,
    expectedVersion: facts.expectedVersion,
    actualVersion: facts.actualVersion,
    platform: facts.platform,
    arch: facts.arch,
    target: `${facts.platform}-${facts.arch}`,
    mode: facts.mode,
    appRoot: facts.appRoot,
    product: shippedProduct(facts.appRoot),
    controller: fileIdentity(facts.controllerPath),
    cli: fileIdentity(facts.cliPath),
    proxy: fileIdentity(facts.proxyPath),
  };
}
