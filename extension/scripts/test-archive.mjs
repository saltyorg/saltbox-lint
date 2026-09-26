import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifest, targets, run, sha256 } from "./release-inputs.mjs";
import { readVSIX } from "./verify-package.mjs";
import { smokeBinary } from "./test-binary.mjs";

// Exercise the actual standalone distribution, not a freshly built substitute.
export async function smokeCLIArchive(directory, target, expectedBinary) {
  const [os, arch] = targets[target];
  const name = `saltbox-lint${os === "windows" ? ".exe" : ""}`;
  const filename = `saltbox-lint_${manifest.version}_${os}_${arch}.${os === "windows" ? "zip" : "tar.gz"}`;
  const archive = join(directory, filename);
  const checksum = readFileSync(join(directory, "checksums.txt"), "utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${filename}`));
  assert.ok(checksum, `Missing archive checksum: ${filename}`);
  assert.equal(sha256(readFileSync(archive)), checksum.split("  ")[0]);
  const temp = mkdtempSync(join(tmpdir(), "saltbox-native-archive-"));
  try {
    const executable = join(temp, name);
    if (os === "windows") {
      const entries = await readVSIX(archive);
      assert.ok(entries.has(name), `Missing archive executable: ${name}`);
      writeFileSync(executable, entries.get(name).bytes);
    } else {
      run("tar", ["-xzf", archive, "-C", temp]);
    }
    assert.equal(
      sha256(readFileSync(executable)),
      sha256(expectedBinary),
      "Standalone archive and VSIX must ship the same CLI",
    );
    smokeBinary(executable, manifest.version, target);
    console.log(`PASS standalone archive ${filename}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
