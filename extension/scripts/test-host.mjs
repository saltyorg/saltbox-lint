import { hostInputs } from "./host-inputs.mjs";
import assert from "node:assert/strict";
import {
  runTests,
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import {
  cpSync,
  symlinkSync,
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
const { expectedVersion, mode } = hostInputs(process.env);
const root = resolve(".test-workspace");
rmSync(root, { recursive: true, force: true });
for (const name of ["one", "two"]) {
  mkdirSync(resolve(root, name, "roles/example/defaults"), { recursive: true });
  spawnSync("git", ["init", "-q", resolve(root, name)], { stdio: "inherit" });
  if (process.env.SALTBOX_TEST_MARKERS !== "1")
    writeFileSync(resolve(root, name, ".saltbox-lint"), "");
  writeFileSync(
    resolve(root, name, "roles/example/defaults/main.yml"),
    '---\nexample_value: "{{ value\n }}"\n',
  );
  writeFileSync(resolve(root, name, ".gitignore"), "ignored.yml\n");
  writeFileSync(resolve(root, name, "ignored.yml"), 'value: "{{ value\n }}"\n');
}
if (
  [
    "REGRESSIONS",
    "MARKERS",
    "PROFILE",
    "QUALIFICATION",
    "UNTRUSTED",
    "DISABLED",
    "ACTIVE_PROJECT",
    "SAVE_SCOPE",
    "DEPENDENCIES",
    "QUEUE",
  ].every((mode) => process.env[`SALTBOX_TEST_${mode}`] !== "1")
) {
  for (const name of ["one", "two"]) {
    for (const directory of [
      "navsource/tasks",
      "navsource/defaults",
      "navtarget/defaults",
      "navtarget/vars",
    ])
      mkdirSync(resolve(root, name, "roles", directory), { recursive: true });
    writeFileSync(
      resolve(root, name, "roles/navsource/tasks/main.yml"),
      "# 😀é\r\n- debug: {msg: \"😀 {{ lookup('role_var', '_port', role='navtarget') }}\"}\r\n",
    );
    writeFileSync(
      resolve(root, name, "roles/navsource/defaults/main.yml"),
      "navsource_role_port: 9876\n",
    );
    writeFileSync(
      resolve(root, name, "roles/navtarget/defaults/main.yml"),
      "# [untrusted](command:evil) **comment** <b>literal</b>\nnavtarget_role_port: " +
        (name === "one" ? "1234" : "84") +
        "\nnavtarget_name: navalias\nnavalias_port: 4321\n",
    );
    writeFileSync(
      resolve(root, name, "roles/navtarget/vars/main.yml"),
      "navtarget_role_port: 5678\n",
    );
  }
  mkdirSync(resolve(root, "one/roles/readonly/templates"), { recursive: true });
  for (const basename of ["config", "config.yaml", "config.j2"])
    writeFileSync(
      resolve(root, "one/roles/readonly/templates", basename),
      " \t😀\r\n{% raw -%}{{ {% unmatched{%- endraw %}\r\n{{ lookup('role_var', '_port', role='navtarget') }}  ",
    );
  mkdirSync(resolve(root, "one/roles/readonly-directory/tasks"), {
    recursive: true,
  });
  for (const basename of ["config", "config.yaml", "config.j2"])
    writeFileSync(
      resolve(root, "one/roles/readonly-directory/tasks", basename),
      " \t😀\r\n{% raw -%}{{ {% unmatched{%- endraw %}\r\n{{ lookup('role_var', '_port', role='navtarget') }}  ",
    );
  symlinkSync(
    resolve(root, "one/roles/readonly-directory/tasks"),
    resolve(root, "one/roles/readonly-directory/templates"),
    "junction",
  );
  mkdirSync(resolve(root, "one/roles/template-origin/templates"), {
    recursive: true,
  });
  mkdirSync(resolve(root, "one/roles/template-origin/tasks"), {
    recursive: true,
  });
  writeFileSync(
    resolve(root, "one/roles/template-origin/tasks/main.yml"),
    "- template: {src: alias.j2, variable_start_string: '[[', dest: /config}\n",
  );
  writeFileSync(
    resolve(root, "one/roles/readonly/templates/cross-role-config"),
    "literal {{ unfinished",
  );
  symlinkSync(
    resolve(root, "one/roles/readonly/templates/cross-role-config"),
    resolve(root, "one/roles/template-origin/templates/alias.j2"),
    "file",
  );
  writeFileSync(
    resolve(root, "one/roles/readonly/templates/.saltbox-lint"),
    "",
  );
  symlinkSync(
    resolve(root, "one/roles/readonly/templates"),
    resolve(root, "one/readonly-alias"),
    "junction",
  );
  mkdirSync(resolve(root, "one/roles/readonly/defaults"), { recursive: true });
  const reverseTemplateOwner = resolve(
    root,
    "one/roles/readonly/defaults/reverse.yml",
  );
  writeFileSync(
    reverseTemplateOwner,
    "readonly_role_value: \"{{ value\n }}\"\nlookup: \"{{ lookup('role_var', '_port', role='navtarget') }}\"\n",
  );
  for (const spelling of [
    "one/reverse-alias.j2",
    "one/roles/readonly/templates/reverse.yaml",
  ])
    symlinkSync(reverseTemplateOwner, resolve(root, spelling), "file");
  writeFileSync(resolve(root, "one/standalone.j2"), "{{ value");
  writeFileSync(
    resolve(root, "one/roles/readonly/templates/closed-config.yaml"),
    "{{ unfinished",
  );
  writeFileSync(
    resolve(root, "one/roles/readonly/templates/watch-config"),
    "{{ value",
  );
  // Normal mode edits this buffer without changing role membership mid-test.
  // The runner owns the saved fixture for the entire host session.
  mkdirSync(resolve(root, "one/roles/example/tasks"), { recursive: true });
  writeFileSync(
    resolve(root, "one/roles/example/tasks/safe-rule-fixes.yml"),
    "####################\n# Title: Example 🌨\n# Author(s): salty\n# URL: https://example.com\n# GNU General Public License v3.0\n---\n[]\n",
  );
}
if (
  process.env.SALTBOX_TEST_SAVE_SCOPE === "1" &&
  process.env.SALTBOX_TEST_QUEUE !== "1" &&
  process.env.SALTBOX_TEST_ACTIVE_PROJECT !== "1"
) {
  writeFileSync(resolve(root, "one/other.yml"), 'value: "{{ other\n }}"\n');
}
if (process.env.SALTBOX_TEST_ACTIVE_PROJECT === "1") {
  // Late-save cache checks need a role with no pending context peers.
  mkdirSync(resolve(root, "one/roles/late/defaults"), { recursive: true });
  writeFileSync(
    resolve(root, "one/roles/late/defaults/main.yml"),
    'value: "{{ initial\n }}"\n',
  );
  for (const name of ["one", "two"]) {
    writeFileSync(resolve(root, name, "README.md"), "Project context\n");
    writeFileSync(
      resolve(root, name, "roles/example/defaults/saved.yml"),
      'value: "{{ saved\n }}"\n',
    );
  }
  writeFileSync(
    resolve(root, "one/roles/example/defaults/closed.yml"),
    'value: "{{ closed\n }}"\n',
  );
  for (const name of [
    "related.yml",
    "related-closed.yml",
    "a-related.yml",
    "z-gate.yml",
  ])
    writeFileSync(
      resolve(root, "one/roles/example/defaults", name),
      "################################\n# Settings\n################################\nfirst: 1\n" +
        "################################\n# Settings\n################################\nsecond: 2\n",
    );
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
if (process.env.SALTBOX_TEST_QUEUE === "1") {
  for (const folder of ["one", "two"])
    for (let index = 0; index < 46; index++)
      writeFileSync(
        resolve(root, folder, `queue-${index}.yml`),
        'value: "{{ value\n }}"\n',
      );
}
if (process.env.SALTBOX_TEST_DEPENDENCIES === "1") {
  const defaults = readFileSync(
    resolve("../lint/testdata/traefik/api.good.yml"),
    "utf8",
  );
  const header = defaults.split("---\n")[0] + "---\n";
  const template = readFileSync(
    resolve("../lint/testdata/traefik/renderer.good.j2"),
    "utf8",
  );
  for (const name of ["one", "two"]) {
    mkdirSync(resolve(root, name, "roles/invalid/defaults"), {
      recursive: true,
    });
    writeFileSync(
      resolve(root, name, "roles/invalid/defaults/main.yml"),
      Buffer.from([0xff, 0x0a]),
    );
    mkdirSync(resolve(root, name, "roles/example/tasks"), { recursive: true });
    mkdirSync(resolve(root, name, "roles/example/templates"), {
      recursive: true,
    });
    writeFileSync(
      resolve(root, name, "roles/example/defaults/main.yml"),
      defaults,
    );
    writeFileSync(
      resolve(root, name, "roles/example/tasks/main.yml"),
      header +
        '- name: Render configuration\n  ansible.builtin.template:\n    src: router.conf\n    dest: /traefik/router.yml\n    mode: "0644"\n',
    );
    mkdirSync(resolve(root, name, "roles/example/tasks/first-open"), {
      recursive: true,
    });
    writeFileSync(
      resolve(root, name, "roles/example/tasks/first-open/ignored.yml"),
      readFileSync(resolve(root, name, "roles/example/tasks/main.yml")),
    );
    writeFileSync(
      resolve(root, name, "roles/example/templates/router.conf"),
      template,
    );
    mkdirSync(resolve(root, name, "resources/tasks/docker"), {
      recursive: true,
    });
    writeFileSync(
      resolve(root, name, "resources/tasks/docker/read.yml"),
      '- debug: {msg: "{{ _docker_vars._docker_memory | default(0) }}"}\n',
    );
    writeFileSync(
      resolve(root, name, "resources/tasks/docker/policy.yml"),
      "- set_fact:\n    _docker_vars: \"{{ lookup('docker_vars', specs={'_docker_memory': {'omit': true}}) }}\"\n",
    );
    writeFileSync(
      resolve(root, name, ".gitignore"),
      "ignored.yml\nroles/example/tasks/admitted.yml\n",
    );
    writeFileSync(
      resolve(root, name, "roles/example/tasks/admitted.yml"),
      header + '- debug: {msg: "{{ value\n }}"}\n',
    );
    mkdirSync(resolve(root, name, "roles/unrelated/defaults"), {
      recursive: true,
    });
    writeFileSync(
      resolve(root, name, "roles/unrelated/defaults/main.yml"),
      header + 'unrelated_value: "{{ other\n }}"\n',
    );
  }
}
const workspace = resolve(root, "test.code-workspace");
writeFileSync(
  workspace,
  JSON.stringify({
    folders: [{ path: "one" }, { path: "two" }],
    settings: {
      "files.autoSave": "off",
      "editor.formatOnSave": false,
      ...(process.env.SALTBOX_TEST_ACTIVE_PROJECT === "1"
        ? {}
        : { "saltboxLint.activeProjectOnly": false }),
    },
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
    contributes: {
      languages: [{ id: "ansible", aliases: ["Ansible"] }],
      ...(process.env.SALTBOX_TEST_SAVE_SCOPE === "1"
        ? {
            configuration: JSON.parse(
              readFileSync(resolve("package.json"), "utf8"),
            ).contributes.configuration,
          }
        : {}),
    },
  }),
);
let executable = process.env.VSCODE_EXECUTABLE_PATH;
if (vsix && !executable)
  executable = await downloadAndUnzipVSCode(expectedVersion);
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
const binaryName =
  "saltbox-lint" + (process.platform === "win32" ? ".exe" : "");
const realCLI = vsix
  ? readdirSync(extensionsDir)
      .map((directory) => join(extensionsDir, directory, "bin", binaryName))
      .find((filename) => existsSync(filename))
  : resolve("bin", binaryName);
if (process.env.SALTBOX_TEST_SAVE_SCOPE === "1") {
  assert.ok(
    realCLI && existsSync(realCLI),
    "recording proxy requires the real platform CLI",
  );
  console.log(`Save-scope component host uses real CLI: ${realCLI}`);
}
const options = {
  vscodeExecutablePath: executable,
  version: expectedVersion,
  extensionDevelopmentPath:
    vsix || process.env.SALTBOX_TEST_SAVE_SCOPE === "1"
      ? controller
      : process.env.SALTBOX_TEST_MARKERS === "1"
        ? [resolve("."), controller]
        : resolve("."),
  extensionTestsEnv: {
    SALTBOX_TEST_EXPECTED_VSCODE_VERSION: expectedVersion,
    SALTBOX_TEST_HOST_MODE: mode,
    SALTBOX_TEST_INSTALLED_CLI_PATH: realCLI,
    SALTBOX_TEST_EXTENSIONS_DIR: extensionsDir,
    SALTBOX_TEST_REAL_CLI:
      process.env.SALTBOX_TEST_SAVE_SCOPE === "1" ? realCLI : "",
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
