import { runTests } from "@vscode/test-electron";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(".test-workspace");
for (const name of ["one", "two"]) {
  mkdirSync(resolve(root, name, "roles/example/defaults"), { recursive: true });
  spawnSync("git", ["init", "-q", resolve(root, name)], { stdio: "inherit" });
  writeFileSync(
    resolve(root, name, "roles/example/defaults/main.yml"),
    '---\nexample_value: "{{ value\n }}"\n',
  );
  writeFileSync(resolve(root, name, ".gitignore"), "ignored.yml\n");
  writeFileSync(resolve(root, name, "ignored.yml"), 'value: "{{ value\n }}"\n');
}
const workspace = resolve(root, "test.code-workspace");
writeFileSync(
  workspace,
  JSON.stringify({
    folders: [{ path: "one" }, { path: "two" }],
    settings: { "files.autoSave": "off", "editor.formatOnSave": false },
  }),
);
const untrusted = process.env.SALTBOX_TEST_UNTRUSTED === "1";
const userData = mkdtempSync(join(tmpdir(), "saltbox-vscode-test-"));
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User/settings.json"),
  JSON.stringify({
    "security.workspace.trust.startupPrompt": "never",
    "telemetry.telemetryLevel": "off",
  }),
);
const options = {
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  version: process.env.VSCODE_VERSION ?? "1.137.0",
  extensionDevelopmentPath: resolve("."),
  extensionTestsPath: resolve("dist/test/host.js"),
  launchArgs: [
    workspace,
    "--no-sandbox",
    "--disable-gpu",
    ...(untrusted ? [] : ["--disable-workspace-trust"]),
    "--user-data-dir",
    userData,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-extensions",
  ],
};
if (untrusted) {
  if (!options.vscodeExecutablePath)
    throw new Error(
      "Restricted-workspace test requires VSCODE_EXECUTABLE_PATH",
    );
  // test-electron always adds --disable-workspace-trust; launch this one case directly.
  const result = spawnSync(
    options.vscodeExecutablePath,
    [
      ...options.launchArgs,
      `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
      `--extensionTestsPath=${options.extensionTestsPath}`,
      "--disable-updates",
    ],
    {
      env: process.env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
      timeout: 90000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Restricted-workspace test exited ${result.status}`);
} else await runTests(options);
