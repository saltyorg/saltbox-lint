import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { smokeBinary } from "../scripts/test-binary.mjs";
import { stageBinary } from "../scripts/stage-binary.mjs";
import { ownedCommand } from "../scripts/owned-command.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
const binary = fileURLToPath(
  new URL(
    `../bin/saltbox-lint${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

test("staged CLI identifies the extension release and removes builder paths", async () => {
  await stageBinary();
  const version = await ownedCommand(binary, ["--version"], {
    phase: "staged CLI version",
    timeoutMs: 30000,
  });
  assert.equal(version.trim(), `saltbox-lint version ${manifest.version}`);
  const metadata = await ownedCommand("go", ["version", "-m", binary], {
    phase: "staged CLI build metadata",
    timeoutMs: 30000,
  });
  assert.match(metadata, /-trimpath=true/);
  assert.match(metadata, /CGO_ENABLED=0/);
  smokeBinary(binary, manifest.version, `${process.platform}-${process.arch}`);
});
