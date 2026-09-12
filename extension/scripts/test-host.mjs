import assert from "node:assert/strict";
import {
  runTests,
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import {
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
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
if (process.env.SALTBOX_TEST_REGRESSIONS === "1") {
  for (const name of [
    "independent.yml",
    "pending.yml",
    "two-tabs.yml",
    "closed.yml",
    "refresh.yml",
  ])
    writeFileSync(resolve(root, "one", name), '---\nvalue: "{{ value\n }}"\n');
  mkdirSync(resolve(root, "one/roles/example/tasks"), { recursive: true });
  writeFileSync(
    resolve(root, "one/roles/example/tasks/main.yml"),
    '################################\n# Settings\n################################\nvalue: "{{ a\n | f }}"\n',
  );
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
const vsix = process.env.SALTBOX_TEST_VSIX;
const extensionsDir = mkdtempSync(join(tmpdir(), "saltbox-installed-"));
const controller = mkdtempSync(join(tmpdir(), "saltbox-controller-"));
writeFileSync(
  join(controller, "package.json"),
  JSON.stringify({
    name: "saltbox-lint-test-controller",
    publisher: "local-test",
    version: "0.0.0",
    engines: { vscode: "^1.100.0" },
  }),
);
let executable = process.env.VSCODE_EXECUTABLE_PATH;
if (vsix && !executable)
  executable = await downloadAndUnzipVSCode(
    process.env.VSCODE_VERSION ?? "1.137.0",
  );
function cli(args) {
  const [command, ...prefix] = resolveCliArgsFromVSCodeExecutablePath(
    executable,
    { reuseMachineInstall: true },
  );
  const result = spawnSync(
    command,
    [
      ...prefix,
      "--no-sandbox",
      "--user-data-dir",
      userData,
      "--extensions-dir",
      extensionsDir,
      ...args,
    ],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 90000,
    },
  );
  if (result.error) throw result.error;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0)
    throw new Error(`VS Code CLI exited ${result.status}`);
  return result.stdout;
}
if (vsix) {
  cli(["--install-extension", resolve(vsix), "--force"]);
  assert.match(
    cli(["--list-extensions", "--show-versions"]),
    /^saltyorg\.saltbox-lint@/m,
  );
}
const options = {
  vscodeExecutablePath: executable,
  version: process.env.VSCODE_VERSION ?? "1.137.0",
  extensionDevelopmentPath: vsix ? controller : resolve("."),
  extensionTestsEnv: {
    SALTBOX_TEST_EXTENSIONS_DIR: extensionsDir,
    SALTBOX_TEST_FIXTURE_PATH: resolve(
      "bin/process-fixture" + (process.platform === "win32" ? ".exe" : ""),
    ),
  },
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
    ...(process.env.SALTBOX_TEST_LOGS ? ["--log", "trace"] : []),
    ...(vsix ? ["--extensions-dir", extensionsDir] : ["--disable-extensions"]),
    ...(process.env.SALTBOX_TEST_DISABLED === "1"
      ? ["--disable-extension", "saltyorg.saltbox-lint"]
      : []),
  ],
};
try {
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
        env: { ...process.env, ...options.extensionTestsEnv },
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
} finally {
  if (vsix) cli(["--uninstall-extension", "saltyorg.saltbox-lint"]);
  rmSync(extensionsDir, { recursive: true, force: true });
  rmSync(controller, { recursive: true, force: true });
  if (process.env.SALTBOX_TEST_LOGS && existsSync(join(userData, "logs")))
    cpSync(join(userData, "logs"), process.env.SALTBOX_TEST_LOGS, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  rmSync(userData, { recursive: true, force: true });
}
