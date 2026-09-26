// Native smoke probe intentionally uses only Node builtins; also runs in Alpine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const disk = readFileSync(path);
    const input = "emoji: ['🌨']\r\nlast: yes";
    const formatted = call(["format", "--stdin-filename", path, "-"], input);
    assert.equal(formatted.status, 0, formatted.stderr);
    const response = JSON.parse(formatted.stdout);
    assert.equal(response.status, "ready");
    let output = Buffer.from(input);
    let previous = output.length;
    for (const edit of response.edits.toReversed()) {
      assert.ok(edit.span.start >= 0 && edit.span.end >= edit.span.start);
      assert.ok(
        edit.span.end <= previous,
        "edits must be ordered and disjoint",
      );
      output = Buffer.concat([
        output.subarray(0, edit.span.start),
        Buffer.from(edit.text),
        output.subarray(edit.span.end),
      ]);
      previous = edit.span.start;
    }
    assert.equal(output.toString(), 'emoji:\r\n  - "🌨"\r\nlast: yes');
    const again = call(["format", "--stdin-filename", path, "-"], output);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).status, "unchanged");
    assert.deepEqual(
      readFileSync(path),
      disk,
      "format must not write the source",
    );

    const stdin = call(
      ["check", "--format", "json", "--stdin-filename", path, "-"],
      "value: true\r\n",
    );
    assert.equal(stdin.status, 0, stdin.stderr);
    assert.deepEqual(JSON.parse(stdin.stdout).diagnostics, []);
    assert.deepEqual(readFileSync(path), disk, "stdin must not overwrite disk");
    const missing = call(["check", join(directory, "missing.yml")]);
    assert.equal(missing.status, 2, missing.stderr);
    const invalid = call(["format", "--stdin-filename", path, "-"], "v: [\n");
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).status, "skipped");
    assert.deepEqual(JSON.parse(invalid.stdout).edits, []);

    const fixable = '# retained 😀\nv: "{{ a\n | combine(b) }}"\n';
    writeFileSync(path, fixable);
    const diff = call(["check", "--diff", path]);
    assert.equal(diff.status, 1, diff.stderr);
    assert.match(diff.stdout, /combine/);
    assert.equal(readFileSync(path, "utf8"), fixable, "diff must not write");
    const fixed = call(["check", "--fix", "--format", "json", path]);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.deepEqual(JSON.parse(fixed.stdout).diagnostics, []);
    assert.equal(
      readFileSync(path, "utf8"),
      '# retained 😀\nv: "{{ a\n       | combine(b) }}"\n',
    );
    const valid = readFileSync(path);
    const fixedAgain = call(["check", "--fix", "--format", "json", path]);
    assert.equal(fixedAgain.status, 0, fixedAgain.stderr);
    assert.deepEqual(
      readFileSync(path),
      valid,
      "fix must preserve valid bytes",
    );
    console.log(
      `PASS native ${target}: version, Unicode path, diagnostics, WASM highlighting, Unicode/CRLF formatting, stdin, errors, diff, fixes and idempotence`,
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
