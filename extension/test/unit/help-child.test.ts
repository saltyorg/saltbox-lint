import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpChildMatcher } from "../host/help-child.ts";

test("installed help interception follows executable identity across path spellings", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "saltbox-help-identity-"));
  try {
    const root = join(temporary, "installed");
    await mkdir(root);
    const name = "saltbox-lint" + (process.platform === "win32" ? ".exe" : "");
    const executable = join(root, name);
    const foreign = join(root, "foreign");
    await writeFile(executable, "installed fixture");
    await writeFile(foreign, "foreign fixture");
    const alias = join(temporary, "alias");
    await symlink(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const matches = helpChildMatcher(executable);
    assert.equal(matches(executable, ["--version"]), true);
    assert.equal(
      matches(join(alias, name), ["--version"]),
      true,
      "same installed child reaches interception through an OS path alias",
    );
    assert.equal(
      matches(join(alias, name), ["rules", "--format", "json"]),
      true,
    );
    if (process.platform === "win32") {
      assert.match(executable, /^[a-z]:/i);
      // VS Code Extension.extensionPath preserves the drive letter, but
      // ExtensionContext.asAbsolutePath uses Uri.fsPath's lowercase drive.
      const lowerDrive = executable[0].toLowerCase() + executable.slice(1);
      const upperDrive = executable[0].toUpperCase() + executable.slice(1);
      assert.notEqual(lowerDrive, upperDrive);
      assert.equal(
        helpChildMatcher(upperDrive)(lowerDrive, ["--version"]),
        true,
      );
      assert.equal(
        helpChildMatcher(lowerDrive)(upperDrive, ["rules", "--format", "json"]),
        true,
      );
    }
    for (const args of [
      undefined,
      [],
      ["check"],
      ["--version", "extra"],
      ["rules"],
      ["rules", "--format", "text"],
    ])
      assert.equal(matches(executable, args), false);
    assert.equal(matches(foreign, ["--version"]), false);
    assert.equal(matches(join(root, "missing"), ["--version"]), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
