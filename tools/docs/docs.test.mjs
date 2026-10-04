import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anchors, checkDocument, maintainedDocuments, root } from "./check.mjs";
import { checkPlatforms, platformDocument } from "./platforms.mjs";

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "saltbox-docs-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  mkdirSync(join(path, "docs"));
  return path;
}

test("relative, encoded, reference and repository links resolve offline", (t) => {
  const path = fixture(t);
  writeFileSync(
    join(path, "docs", "target (guide).md"),
    '# Install CLI\n\n# Install CLI\n\n<a id="manual"></a>\n',
  );
  writeFileSync(
    join(path, "docs", "source.md"),
    [
      "# Source",
      "[inline](target%20%28guide%29.md#install-cli)",
      "[angle](<target (guide).md#install-cli-1>)",
      "[reference][target] and [target][] and [target] and [`target`][target]",
      "[target]: <target (guide).md#manual>",
      "[repository](https://github.com/saltyorg/saltbox-lint/blob/main/docs/target%20%28guide%29.md#install-cli)",
      "[external](https://invalid.example/not-checked)",
      "[published](https://github.com/saltyorg/saltbox-lint/blob/v0.1.0/no-local-file.md)",
      '<a href="target%20%28guide%29.md#manual">HTML</a>',
      "```md",
      "[example](missing.md)",
      "```",
      "`[inline example](missing.md)`",
    ].join("\n"),
  );
  assert.deepEqual(checkDocument(path, "docs/source.md"), []);
});

test("missing files, anchors, reference definitions and escaping paths fail", (t) => {
  const path = fixture(t);
  writeFileSync(join(path, "docs", "target.md"), "# Target\n");
  writeFileSync(
    join(path, "docs", "source.md"),
    [
      "[missing](missing.md)",
      "[fragment](target.md#absent)",
      "[unknown][absent]",
      "[`unknown`][absent]",
      "[escape](../../outside.md)",
      "[repository](https://github.com/saltyorg/saltbox-lint/tree/main/absent)",
    ].join("\n"),
  );
  const failures = checkDocument(path, "docs/source.md");
  assert.equal(failures.length, 6);
  assert.match(failures.join("\n"), /missing anchor #absent/);
  assert.match(failures.join("\n"), /path escapes repository/);
  assert.match(failures.join("\n"), /missing-reference:absent/);
});

test("anchor subset ignores fenced headings and supports duplicate headings", () => {
  assert.deepEqual(
    [
      ...anchors(
        "# Hello, `world`!\n# Hello, `world`!\n~~~md\n# Hidden\n~~~\n<a id='explicit'></a>\n",
      ),
    ],
    ["hello-world", "hello-world-1", "explicit"],
  );
});

test("duplicate heading anchors avoid existing numeric suffixes", () => {
  assert.deepEqual(
    [...anchors("# Same\n# Same-1\n# Same\n")],
    ["same", "same-1", "same-2"],
  );
});

test("freshness checks never rewrite stale generated documents", (t) => {
  const path = join(fixture(t), "platforms.md");
  writeFileSync(path, "stale\n");
  assert.throws(() => checkPlatforms(path), /stale/);
  assert.equal(readFileSync(path, "utf8"), "stale\n");
  const expected = platformDocument({ "win32-arm64": ["windows", "arm64"] });
  assert.match(expected, /saltbox-lint_VERSION_windows_arm64.zip/);
  assert.match(expected, /saltbox-lint-VERSION-win32-arm64.vsix/);
  writeFileSync(path, expected);
  checkPlatforms(path, expected);
});

test("maintained public documents resolve and never link private task documents", () => {
  const documents = maintainedDocuments();
  for (const document of documents) {
    const text = readFileSync(join(root, document), "utf8");
    assert.doesNotMatch(text, /(?:\/opt\/dev\/codex-docs|file:\/\/)/, document);
    assert.deepEqual(checkDocument(root, document), [], document);
  }
});

test("standalone and VSIX documentation links work in their packaged trees", (t) => {
  const path = fixture(t);
  const cli = join(path, "cli");
  const vsix = join(path, "vsix");
  mkdirSync(cli);
  mkdirSync(vsix);
  // Mirrors README/LICENSE archive inputs and the VSIX documentation allowlist.
  for (const name of ["README.md", "LICENSE"])
    cpSync(join(root, name), join(cli, name));
  for (const name of ["README.md", "CHANGELOG.md", "PRIVACY.md", "SUPPORT.md"])
    cpSync(join(root, "extension", name), join(vsix, name));
  cpSync(join(root, "LICENSE"), join(vsix, "LICENSE"));
  // Repository-hosted URLs are checked against the real checkout, not these
  // package roots; local relative paths must resolve in the installed package.
  for (const [base, names] of [
    [cli, ["README.md"]],
    [vsix, ["README.md", "CHANGELOG.md", "PRIVACY.md", "SUPPORT.md"]],
  ]) {
    for (const name of names) {
      const source = readFileSync(join(base, name), "utf8");
      writeFileSync(
        join(base, name),
        source.replaceAll(
          "https://github.com/saltyorg/saltbox-lint/",
          "https://repository.example/",
        ),
      );
      assert.deepEqual(checkDocument(base, name), [], `${base}/${name}`);
    }
  }
});
