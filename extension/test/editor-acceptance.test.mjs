import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { transform } from "esbuild";
import { editorAcceptance } from "./host/editor-acceptance.ts";
import { hostInputs } from "../scripts/host-inputs.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function withoutImports(source) {
  return source.replace(/^import[\s\S]*?;\n/gm, "");
}
export async function controller(source, expectedVersion, actualVersion) {
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  const events = [];
  const vscode = {
    version: actualVersion,
    env: { appRoot: "/unavailable-app-root" },
    extensions: {
      getExtension() {
        events.push("mode dispatched");
        return undefined;
      },
    },
  };
  await new AsyncFunction(
    "vscode",
    "assert",
    "editorAcceptance",
    "process",
    "console",
    "__filename",
    withoutImports(code).replace("export {\n  run\n};", "") + "\nawait run();",
  )(
    vscode,
    assert,
    editorAcceptance,
    {
      env: {
        SALTBOX_TEST_EXPECTED_VSCODE_VERSION: expectedVersion,
        SALTBOX_TEST_HOST_MODE: "disabled",
        SALTBOX_TEST_DISABLED: "1",
      },
      platform: "linux",
      arch: "x64",
    },
    { log: (record) => events.push(record) },
    "/unavailable-controller",
  );
  return events;
}

test("actual controller rejects a wrong public version before dispatch and records accepted runtime facts", async () => {
  const source = fs.readFileSync(
    new URL("./host/index.ts", import.meta.url),
    "utf8",
  );
  await assert.rejects(
    controller(source, "1.100.0", "1.137.0"),
    /actual public vscode.version/,
  );
  const events = await controller(source, "1.100.0", "1.100.0");
  assert.ok(events[0].startsWith("SALTBOX_EDITOR_ACCEPTANCE "));
  const record = JSON.parse(
    events[0].slice("SALTBOX_EDITOR_ACCEPTANCE ".length),
  );
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.expectedVersion, "1.100.0");
  assert.equal(record.actualVersion, "1.100.0");
  assert.equal(record.mode, "disabled");
  assert.equal(record.target, "linux-x64");
  assert.equal(record.product.state, "unavailable");
  assert.equal(events[1], "mode dispatched");
});

test("acceptance reads shipped product metadata without substituting requested identity", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "saltbox-editor-version-"),
  );
  try {
    await writeFile(
      path.join(directory, "product.json"),
      JSON.stringify({
        version: "1.100.0",
        commit: "shipped-commit",
        nameShort: "Code",
        secret: "not emitted",
      }),
    );
    const facts = {
      expectedVersion: "1.100.0",
      actualVersion: "1.100.0",
      platform: "darwin",
      arch: "x64",
      mode: "dependencies",
      appRoot: directory,
      controllerPath: path.join(directory, "product.json"),
      cliPath: undefined,
      proxyPath: undefined,
    };
    const record = editorAcceptance(facts);
    assert.deepEqual(record.product, {
      state: "available",
      metadata: {
        version: "1.100.0",
        commit: "shipped-commit",
        nameShort: "Code",
      },
    });
    assert.equal(record.controller.state, "available");
    assert.equal(record.cli.state, "unavailable");
    assert.throws(
      () => editorAcceptance({ ...facts, expectedVersion: undefined }),
      /provide expected/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native parent forwards both requested versions and every exact mode", async () => {
  const source = fs.readFileSync(
    new URL("../scripts/test-native-hosts.mjs", import.meta.url),
    "utf8",
  );
  const calls = [];
  const downloads = [];
  await new AsyncFunction(
    "downloadAndUnzipVSCode",
    "spawnSync",
    "resolve",
    "manifest",
    "process",
    withoutImports(source),
  )(
    async (version) => {
      downloads.push(version);
      return `/sdk/${version}`;
    },
    (_command, _args, options) => {
      calls.push(options);
      return { status: 0 };
    },
    path.resolve,
    { version: "0.1.0" },
    {
      platform: "darwin",
      arch: "x64",
      execPath: "node",
      env: { VSCODE_VERSION: "wrong inherited label" },
    },
  );
  assert.deepEqual(downloads, ["1.100.0", "1.137.0"]);
  assert.equal(calls.length, 20);
  for (const [index, call] of calls.entries()) {
    const expected = index < 10 ? "1.100.0" : "1.137.0";
    assert.equal(call.env.SALTBOX_TEST_EXPECTED_VSCODE_VERSION, expected);
    assert.equal(call.env.VSCODE_EXECUTABLE_PATH, `/sdk/${expected}`);
    assert.equal(hostInputs(call.env).expectedVersion, expected);
    assert.equal(hostInputs(call.env).mode, call.env.SALTBOX_TEST_HOST_MODE);
    assert.equal(call.timeout, 180000);
  }
  assert.equal(
    new Set(calls.slice(0, 10).map((call) => call.env.SALTBOX_TEST_HOST_MODE))
      .size,
    10,
  );
});

test("actual host runner forwards expected version and mode to controller options", async () => {
  const source = fs.readFileSync(
    new URL("../scripts/test-host.mjs", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(path.join(tmpdir(), "saltbox-host-wiring-"));
  try {
    for (const expectedVersion of ["1.100.0", "1.137.0"]) {
      let options;
      const names = [
        "hostInputs",
        "assert",
        "runTests",
        "downloadAndUnzipVSCode",
        "resolveCliArgsFromVSCodeExecutablePath",
        ...[
          "cpSync",
          "existsSync",
          "readdirSync",
          "readFileSync",
          "mkdirSync",
          "writeFileSync",
          "mkdtempSync",
          "rmSync",
        ],
        "tmpdir",
        "resolve",
        "join",
        "spawnSync",
        "process",
      ];
      const values = [
        hostInputs,
        assert,
        async (value) => {
          options = value;
        },
        () => {
          throw new Error("explicit executable must be retained");
        },
        () => {
          throw new Error("no VSIX CLI needed in wiring test");
        },
        ...[
          "cpSync",
          "existsSync",
          "readdirSync",
          "readFileSync",
          "mkdirSync",
          "writeFileSync",
          "mkdtempSync",
          "rmSync",
        ].map((name) => fs[name]),
        () => directory,
        (...args) => path.resolve(directory, ...args),
        path.join,
        () => ({ status: 0 }),
        {
          env: {
            VSCODE_EXECUTABLE_PATH: `/sdk/${expectedVersion}`,
            SALTBOX_TEST_EXPECTED_VSCODE_VERSION: expectedVersion,
            SALTBOX_TEST_HOST_MODE: "disabled",
            SALTBOX_TEST_DISABLED: "1",
            VSCODE_VERSION: "wrong inherited label",
          },
          platform: "linux",
        },
      ];
      await new AsyncFunction(...names, withoutImports(source))(...values);
      assert.equal(options.version, expectedVersion);
      assert.equal(options.vscodeExecutablePath, `/sdk/${expectedVersion}`);
      assert.equal(
        options.extensionTestsEnv.SALTBOX_TEST_EXPECTED_VSCODE_VERSION,
        expectedVersion,
      );
      assert.equal(
        options.extensionTestsEnv.SALTBOX_TEST_HOST_MODE,
        "disabled",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
