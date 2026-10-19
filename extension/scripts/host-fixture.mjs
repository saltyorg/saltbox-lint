// @ts-check
import {
  symlinkSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  cpSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, basename, dirname } from "node:path";
import {
  liveSource,
  liveContext,
  liveTemplate,
} from "../test/support/live-fixture.ts";

/** @typedef {import('./host-types.js').HostProfile} HostProfile */
/** @type {WeakMap<HostProfile, {dev: number, ino: number}>} */
const ownedProfiles = new WeakMap();

/** @param {string} directory @returns {HostProfile} */
export function hostProfilePaths(directory) {
  const root = resolve(directory);
  return Object.freeze({
    root,
    workspaceRoot: join(root, "workspace"),
    userData: join(root, "user-data"),
    extensionsDir: join(root, "extensions"),
    controller: join(root, "controller"),
  });
}

export function createHostProfile({
  workspaceBase = process.env.SALTBOX_TEST_WORKSPACE_BASE ?? tmpdir(),
} = {}) {
  mkdirSync(workspaceBase, { recursive: true });
  const profile = hostProfilePaths(
    mkdtempSync(join(workspaceBase, "saltbox-host-")),
  );
  const identity = lstatSync(profile.root);
  ownedProfiles.set(profile, { dev: identity.dev, ino: identity.ino });
  try {
    for (const directory of [
      profile.workspaceRoot,
      profile.userData,
      profile.extensionsDir,
      profile.controller,
    ])
      mkdirSync(directory);
    return profile;
  } catch (error) {
    try {
      rmSync(profile.root, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "host profile setup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * @param {HostProfile} profile
 * @param {{logsPath?: string, label?: string}} [options]
 */
export function cleanupHostProfile(
  profile,
  { logsPath, label = "profile" } = {},
) {
  const identity = ownedProfiles.get(profile);
  if (!identity)
    throw new Error("cleanup requires the exact profile created by this owner");
  if (existsSync(profile.root)) {
    const current = lstatSync(profile.root);
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new Error(
        "owned host profile directory identity changed before cleanup",
      );
  }
  const errors = [];
  if (logsPath && existsSync(join(profile.userData, "logs"))) {
    try {
      mkdirSync(logsPath, { recursive: true });
      cpSync(
        join(profile.userData, "logs"),
        join(logsPath, label + "-" + basename(profile.root)),
        { recursive: true, errorOnExist: true, force: false },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    const failure = Object.assign(
      new AggregateError(
        errors,
        "host log archival failed; original profile retained",
      ),
      { retainedProfile: profile.root },
    );
    throw failure;
  }
  try {
    rmSync(profile.root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    ownedProfiles.delete(profile);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, "host profile cleanup failed");
}

/**
 * @param {HostProfile} profile
 * @param {{env: NodeJS.ProcessEnv, extensionDirectory: string, command: import('./host-types.js').HostCommand}} options
 */
export async function populateHostFixture(
  profile,
  { env, extensionDirectory, command },
) {
  const root = profile.workspaceRoot;
  const enclosingRepository = env.SALTBOX_TEST_DEPENDENCIES === "1";
  if (enclosingRepository) {
    mkdirSync(root, { recursive: true });
    await command("git", ["init", "-q", root], {
      phase: "fixture git initialization",
      timeoutMs: 15000,
      stdio: "inherit",
    });
    // Administrative policy outside each source root is intentionally opaque
    // to its watchers. The first-open controls admit these files explicitly.
    writeFileSync(
      resolve(root, ".git/info/exclude"),
      ["one", "two"]
        .map((name) => `${name}/roles/example/tasks/first-open/first.yml\n`)
        .join(""),
    );
  }
  for (const name of ["one", "two"]) {
    mkdirSync(resolve(root, name, "roles/example/defaults"), {
      recursive: true,
    });
    if (!enclosingRepository)
      await command("git", ["init", "-q", resolve(root, name)], {
        phase: "fixture git initialization",
        timeoutMs: 15000,
        stdio: "inherit",
      });
    if (env.SALTBOX_TEST_MARKERS !== "1")
      writeFileSync(resolve(root, name, ".saltbox-lint"), "");
    writeFileSync(
      resolve(root, name, "roles/example/defaults/main.yml"),
      '---\nexample_value: "{{ value\n }}"\n',
    );
    writeFileSync(resolve(root, name, ".gitignore"), "ignored.yml\n");
    writeFileSync(
      resolve(root, name, "ignored.yml"),
      'value: "{{ value\n }}"\n',
    );
  }
  if (
    env.SALTBOX_TEST_HOST_MODE === "live-performance" ||
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
    ].every((mode) => env[`SALTBOX_TEST_${mode}`] !== "1")
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
    mkdirSync(resolve(root, "one/roles/readonly/templates"), {
      recursive: true,
    });
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
    mkdirSync(resolve(root, "one/roles/readonly/defaults"), {
      recursive: true,
    });
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
    env.SALTBOX_TEST_SAVE_SCOPE === "1" &&
    env.SALTBOX_TEST_QUEUE !== "1" &&
    env.SALTBOX_TEST_ACTIVE_PROJECT !== "1"
  ) {
    writeFileSync(resolve(root, "one/other.yml"), 'value: "{{ other\n }}"\n');
  }
  if (env.SALTBOX_TEST_ACTIVE_PROJECT === "1") {
    // The isolated late save must not depend on other declaration files.
    writeFileSync(resolve(root, "one/late.yml"), 'value: "{{ initial\n }}"\n');
    for (const name of ["one", "two"]) {
      writeFileSync(resolve(root, name, "README.md"), "Project context\n");
      writeFileSync(
        resolve(root, name, "roles/example/defaults/saved.yml"),
        'example_saved_value: "{{ saved\n }}"\n',
      );
    }
    writeFileSync(
      resolve(root, "one/roles/example/defaults/closed.yml"),
      'example_closed_value: "{{ closed\n }}"\n',
    );
    for (const name of [
      "related.yml",
      "related-closed.yml",
      "a-related.yml",
      "z-gate.yml",
    ]) {
      const prefix =
        "example_" + name.replace(/\.yml$/, "").replaceAll("-", "_");
      writeFileSync(
        resolve(root, "one/roles/example/defaults", name),
        "################################\n# Settings\n################################\n" +
          prefix +
          "_first: 1\n" +
          "################################\n# Settings\n################################\n" +
          prefix +
          "_second: 2\n",
      );
    }
  }
  if (env.SALTBOX_TEST_REGRESSIONS === "1") {
    for (const name of [
      "independent.yml",
      "pending.yml",
      "two-tabs.yml",
      "closed.yml",
      "refresh.yml",
    ])
      writeFileSync(
        resolve(root, "one", name),
        '---\nvalue: "{{ value\n }}"\n',
      );
    mkdirSync(resolve(root, "one/roles/example/tasks"), { recursive: true });
    writeFileSync(
      resolve(root, "one/roles/example/tasks/main.yml"),
      '################################\n# Settings\n################################\nvalue: "{{ a\n | f }}"\n',
    );
  }
  if (env.SALTBOX_TEST_QUEUE === "1") {
    for (const folder of ["one", "two"])
      for (let index = 0; index < 46; index++)
        writeFileSync(
          resolve(root, folder, `queue-${index}.yml`),
          'value: "{{ value\n }}"\n',
        );
  }
  if (env.SALTBOX_TEST_DEPENDENCIES === "1") {
    const defaults = readFileSync(
      resolve(extensionDirectory, "../lint/testdata/traefik/api.good.yml"),
      "utf8",
    );
    const header = defaults.split("---\n")[0] + "---\n";
    const template = readFileSync(
      resolve(extensionDirectory, "../lint/testdata/traefik/renderer.good.j2"),
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
      mkdirSync(resolve(root, name, "roles/example/tasks"), {
        recursive: true,
      });
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
        resolve(root, name, "roles/example/tasks/first-open/first.yml"),
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
  if (env.SALTBOX_TEST_HOST_MODE === "live-performance") {
    for (const [relative, contents] of Object.entries({
      "live-small.yml": liveSource(1),
      "roles/livecontext/tasks/main.yml": liveSource(1),
      "roles/livecontext/defaults/main.yml": liveContext(),
      "roles/readonly/templates/config.yaml": liveTemplate,
    })) {
      const filename = resolve(root, "one", relative);
      mkdirSync(dirname(filename), { recursive: true });
      writeFileSync(filename, contents);
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
        ...(env.SALTBOX_TEST_ACTIVE_PROJECT === "1"
          ? {}
          : { "saltboxLint.activeProjectOnly": false }),
      },
    }),
  );

  mkdirSync(join(profile.userData, "User"), { recursive: true });
  writeFileSync(
    join(profile.userData, "User/settings.json"),
    JSON.stringify({
      "security.workspace.trust.startupPrompt": "never",
      "telemetry.telemetryLevel": "off",
    }),
  );
  const manifest = JSON.parse(
    readFileSync(join(extensionDirectory, "package.json"), "utf8"),
  );
  writeFileSync(
    join(profile.controller, "package.json"),
    JSON.stringify({
      name: "saltbox-lint-test-controller",
      publisher: "local-test",
      version: "0.0.0",
      engines: { vscode: "^1.100.0" },
      contributes: {
        languages: [{ id: "ansible", aliases: ["Ansible"] }],
        ...(env.SALTBOX_TEST_SAVE_SCOPE === "1" ||
        env.SALTBOX_TEST_HOST_MODE === "live-performance"
          ? { configuration: manifest.contributes.configuration }
          : {}),
      },
    }),
  );
  return workspace;
}
