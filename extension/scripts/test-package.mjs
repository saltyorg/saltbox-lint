import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { root, manifest, targets, sha256 } from "./release-inputs.mjs";
import { readVSIX, verifyEntries } from "./verify-package.mjs";
import { smokeBinary } from "./test-binary.mjs";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
assert.ok(targets[target], `unsupported package target ${target}`);
const directory = resolve(process.argv[3] ?? join(root, "dist"));
const record = JSON.parse(readFileSync(join(directory, "vsix-artifacts.json")));
const artifact = record.packages.find((entry) => entry.target === target);
assert.ok(artifact);
const path = join(directory, artifact.filename);
assert.equal(sha256(readFileSync(path)), artifact.sha256);
const entries = await readVSIX(path);
const name = `saltbox-lint${target.startsWith("win32") ? ".exe" : ""}`;
const binary = entries.get(`extension/bin/${name}`).bytes;
assert.equal(sha256(binary), artifact.binary_sha256);
const { packages, ...source } = record;
verifyEntries(entries, target, source, binary);
const destination = join(directory, "package-test", target);
mkdirSync(destination, { recursive: true });
const executable = join(destination, name);
writeFileSync(executable, binary);
chmodSync(executable, 0o755);
if (!process.argv.includes("--extract-only"))
  smokeBinary(executable, manifest.version, target);
console.log(`PASS audited ${target} VSIX; extracted ${executable}`);
