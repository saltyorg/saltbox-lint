// Native smoke probe intentionally uses only Node builtins; also runs in Alpine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export function smokeBinary(executable, version, target) {
  assert.equal(
    process.arch,
    target.split("-")[1],
    "native runner architecture must match VSIX",
  );
  assert.equal(
    process.platform,
    target.startsWith("alpine") ? "linux" : target.split("-")[0],
  );
  const directory = mkdtempSync(join(tmpdir(), "saltbox-native-"));
  const call = (args, input) =>
    spawnSync(executable, args, {
      cwd: directory,
      input,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 30000,
    });
  try {
    const reported = call(["--version"]);
    assert.equal(reported.status, 0, reported.stderr);
    assert.equal(reported.stdout.trim(), `saltbox-lint version ${version}`);
    const path = join(directory, "unicode 😀.yml");
    writeFileSync(path, 'value: "{{ value\n }}"\n');
    const check = call(["check", "--format", "json", path]);
    assert.equal(check.status, 1, check.stderr);
    assert.ok(
      JSON.parse(check.stdout).diagnostics.some(
        (d) => d.rule_id === "jinja-layout",
      ),
    );
    const colored = call([
      "check",
      "--format",
      "human",
      "--color",
      "always",
      path,
    ]);
    assert.equal(colored.status, 1, colored.stderr);
    assert.match(
      colored.stdout,
      /\x1b\[/,
      "embedded Nuri/Oniguruma highlighting must execute",
    );
    const format = call(
      ["format", "--stdin-filename", path, "-"],
      "value: [1,2]\n",
    );
    assert.equal(format.status, 0, format.stderr);
    const plan = JSON.parse(format.stdout);
    assert.equal(plan.status, "ready");
    assert.ok(plan.edits.length > 0);
    console.log(
      `PASS native ${target}: version, Unicode path, diagnostics, WASM highlighting, formatting`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  smokeBinary(resolve(process.argv[2]), process.argv[3], process.argv[4]);
