// Native smoke probe intentionally uses only Node builtins; also runs in Alpine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    const sarif = call([
      "check",
      "--root",
      directory,
      "--format",
      "sarif",
      "--color",
      "always",
      path,
    ]);
    assert.equal(sarif.status, 1, sarif.stderr);
    assert.equal(sarif.stderr, "");
    assert.ok(!sarif.stdout.includes("\x1b"));
    const sarifReport = JSON.parse(sarif.stdout);
    assert.equal(sarifReport.version, "2.1.0");
    const sarifRun = sarifReport.runs[0];
    assert.equal(sarifRun.tool.driver.version, version);
    assert.equal(sarifRun.columnKind, "utf16CodeUnits");
    assert.deepEqual(
      sarifRun.results.map((result) => result.ruleId),
      JSON.parse(check.stdout).diagnostics.map((d) => d.rule_id),
    );
    for (const result of sarifRun.results) {
      assert.equal(
        sarifRun.tool.driver.rules[result.ruleIndex].id,
        result.ruleId,
      );
      assert.equal(
        decodeURIComponent(
          result.locations[0].physicalLocation.artifactLocation.uri,
        ),
        "unicode 😀.yml",
      );
      assert.match(
        result.partialFingerprints["saltboxLintContext/v1"],
        /^[a-f0-9]{64}$/,
      );
      assert.ok(!Object.hasOwn(result, "fixes"));
    }
    assert.equal(
      call(["check", "--root", directory, "--format", "sarif", path]).stdout,
      sarif.stdout,
    );
    const sarifDiff = call(["check", "--format", "sarif", "--diff", path]);
    assert.equal(sarifDiff.status, 2);
    assert.equal(sarifDiff.stdout, "");
    const sarifClean = call(
      [
        "check",
        "--root",
        directory,
        "--format",
        "sarif",
        "--stdin-filename",
        path,
        "-",
      ],
      "value: true\r\n",
    );
    assert.equal(sarifClean.status, 0, sarifClean.stderr);
    assert.deepEqual(JSON.parse(sarifClean.stdout).runs[0].results, []);
    const sarifParse = call(
      [
        "check",
        "--root",
        directory,
        "--format",
        "sarif",
        "--stdin-filename",
        path,
        "-",
      ],
      "value: [\n",
    );
    assert.equal(sarifParse.status, 1, sarifParse.stderr);
    assert.equal(
      JSON.parse(sarifParse.stdout).runs[0].results[0].ruleId,
      "yaml-syntax",
    );
    const metadata = call(["rules", "--format", "json", "--color", "always"]);
    assert.equal(metadata.status, 0, metadata.stderr);
    assert.equal(metadata.stderr, "");
    assert.ok(!metadata.stdout.includes("\x1b"));
    const registry = JSON.parse(metadata.stdout);
    assert.equal(registry.schema_version, 1);
    assert.ok(
      registry.rules.some((rule) => rule.id === "jinja-layout" && rule.fixable),
    );
    assert.deepEqual(
      registry.rules.map((rule) => rule.id),
      registry.rules.map((rule) => rule.id).toSorted(),
    );
    const explanation = call([
      "explain",
      path,
      "--format",
      "json",
      "--color",
      "always",
    ]);
    assert.equal(explanation.status, 0, explanation.stderr);
    assert.equal(explanation.stderr, "");
    assert.ok(!explanation.stdout.includes("\x1b"));
    const observed = JSON.parse(explanation.stdout);
    assert.equal(observed.schema_version, 1);
    assert.equal(observed.source.source_kind, "generic");
    assert.ok(observed.applicable_policies.includes("jinja-layout"));
    assert.ok(
      observed.fix_decisions.some(
        (decision) =>
          decision.rule_id === "jinja-layout" && decision.state === "available",
      ),
    );
    const explainedBuffer = call(
      ["explain", "-", "--stdin-filename", path, "--format", "json"],
      "value: [\n",
    );
    assert.equal(explainedBuffer.status, 0, explainedBuffer.stderr);
    assert.equal(
      JSON.parse(explainedBuffer.stdout).source.parse_state,
      "parse-error",
    );
    assert.equal(
      readFileSync(path, "utf8"),
      'value: "{{ value\n }}"\n',
      "help and explanations cannot write source",
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
    for (const project of ["saltbox", "sandbox"]) {
      const root = join(directory, `${project} root 🌨`);
      mkdirSync(join(root, "roles"), { recursive: true });
      writeFileSync(join(root, `${project}.yml`), "---\n[]\n");
      const args = [
        "scaffold",
        "role",
        "native_example",
        "--root",
        root,
        "--title",
        "Native fixture 🌨",
        "--url",
        "https://example.com/fixture",
      ];
      if (project === "saltbox") args.push("--author", "fixture contributor");
      const preview = call(args);
      assert.equal(preview.status, 0, preview.stderr);
      assert.equal(preview.stderr, "");
      assert.match(preview.stdout, /Preview only\./);
      assert.match(preview.stdout, /roles\/native_example\/defaults\/main.yml/);
      assert.match(preview.stdout, /roles\/native_example\/tasks\/main.yml/);
      assert.equal(call(args).stdout, preview.stdout);
      const rolePath = join(root, "roles", "native_example");
      assert.equal(
        existsSync(rolePath),
        false,
        "preview must not create a role",
      );
      const created = call([...args, "--write"]);
      assert.equal(created.status, 0, created.stderr);
      assert.equal((created.stderr.match(/Created:/g) ?? []).length, 5);
      const defaults = readFileSync(join(rolePath, "defaults", "main.yml"));
      const tasks = readFileSync(join(rolePath, "tasks", "main.yml"));
      assert.ok(preview.stdout.includes(defaults.toString()));
      assert.ok(preview.stdout.includes(tasks.toString()));
      if (project === "sandbox")
        assert.match(defaults.toString(), /# Author\(s\): salty\n/);
      const checked = call([
        "check",
        "--root",
        root,
        "--format",
        "json",
        rolePath,
      ]);
      assert.equal(checked.status, 0, checked.stderr);
      assert.deepEqual(JSON.parse(checked.stdout), {
        schema_version: 2,
        diagnostics: [],
        fixes: [],
      });
      const refused = call([...args, "--write"]);
      assert.equal(refused.status, 2);
      assert.equal(refused.stdout, "");
      assert.deepEqual(
        readFileSync(join(rolePath, "defaults", "main.yml")),
        defaults,
      );
      assert.deepEqual(
        readFileSync(join(rolePath, "tasks", "main.yml")),
        tasks,
      );
      const invalidName = [...args];
      invalidName[2] = "../escape";
      assert.equal(call([...invalidName, "--write"]).status, 2);
      const aliasRoot = join(directory, `${project} directory alias root`);
      const outside = join(directory, `${project} outside`);
      mkdirSync(aliasRoot);
      mkdirSync(outside);
      writeFileSync(join(aliasRoot, `${project}.yml`), "[]\n");
      // Junctions need no Windows developer-mode or symlink privilege. They
      // exercise physical directory ownership on every packaged Windows CLI.
      symlinkSync(
        outside,
        join(aliasRoot, "roles"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const aliasArgs = [...args];
      aliasArgs[4] = aliasRoot;
      assert.equal(
        call(aliasArgs).status,
        2,
        "directory aliases cannot own roles",
      );
      assert.equal(call([...aliasArgs, "--write"]).status, 2);
      assert.equal(existsSync(join(outside, "native_example")), false);
    }
    const scaffoldHelp = call(["scaffold", "role", "--help"]);
    assert.equal(scaffoldHelp.status, 0, scaffoldHelp.stderr);
    assert.match(scaffoldHelp.stdout, /--write/);
    assert.match(scaffoldHelp.stdout, /never executed/);
    console.log(
      `PASS native ${target}: version, registry, explanations, SARIF, Unicode path, diagnostics, WASM highlighting, Unicode/CRLF formatting, stdin, errors, diff, fixes, idempotence and validated role creation`,
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
