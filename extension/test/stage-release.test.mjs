import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const extension = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
const binary = fileURLToPath(
  new URL(
    `../bin/saltbox-lint${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

test("staged CLI identifies the extension release and removes builder paths", () => {
  const stage = spawnSync(process.execPath, ["scripts/stage-binary.mjs"], {
    cwd: extension,
    encoding: "utf8",
  });
  assert.equal(stage.status, 0, stage.stderr);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(
    version.stdout.trim(),
    `saltbox-lint version ${manifest.version}`,
  );
  const metadata = spawnSync("go", ["version", "-m", binary], {
    encoding: "utf8",
  });
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.match(metadata.stdout, /-trimpath=true/);
  assert.match(metadata.stdout, /CGO_ENABLED=0/);
});
