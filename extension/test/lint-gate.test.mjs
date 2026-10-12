// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import config from "../eslint.config.mjs";
import { withTestResources } from "./support/test-resources.ts";

/**
 * @template T
 * @param {(directory: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withGateProject(body) {
  let directory = "";
  const value = await withTestResources(
    { cleanupTimeoutMs: 15_000 },
    async (resources) => {
      const root = await mkdtemp(join(tmpdir(), "saltbox-eslint-"));
      directory = join(root, "extension");
      await mkdir(directory);
      resources.defer("generated gate project", async () => {
        await rm(root, { recursive: true, force: true });
      });
      return await body(directory);
    },
  );
  await assert.rejects(access(directory), { code: "ENOENT" });
  return value;
}

/**
 * Preserve the real policy and project selection; only relocate its project root.
 * @param {string} directory
 * @param {string} [project]
 * @param {string[]} [files]
 * @returns {import("eslint").Linter.Config[]}
 */
function relocatedConfig(directory, project, files) {
  const entries = project
    ? config.filter((entry) => {
        const options = projectOptions(entry);
        return "project" in options && options.project === project;
      })
    : config;
  assert.ok(entries.length > 0, "the production typed policy must exist");
  return entries.map((entry) => ({
    ...entry,
    basePath: entry.basePath === ".." ? "." : "extension",
    ...(files ? { files } : {}),
    languageOptions: {
      ...entry.languageOptions,
      parserOptions: {
        ...projectOptions(entry),
        tsconfigRootDir: directory,
      },
    },
  }));
}

/** @param {import("eslint").Linter.Config} entry */
function projectOptions(entry) {
  const options = entry.languageOptions?.parserOptions;
  assert.ok(options && typeof options === "object");
  return options;
}

/** @param {string} directory @param {string[]} include */
async function writeBaseConfig(directory, include) {
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        typeRoots: [resolve("node_modules/@types")],
        types: ["node"],
      },
      include,
    }),
  );
}

/** @param {string} directory @returns {readonly ts.Diagnostic[]} */
function helperDiagnostics(directory) {
  const filename = join(directory, "tsconfig.helpers.json");
  const read = ts.readConfigFile(filename, ts.sys.readFile);
  assert.equal(
    read.error,
    undefined,
    "the real helper config must be readable",
  );
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, directory);
  assert.deepEqual(parsed.errors, [], "the real helper config must parse");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.getPreEmitDiagnostics(program);
}

test("typed correctness gate rejects async mistakes and unsafe assertion patterns", async () => {
  await withGateProject(async (directory) => {
    await writeBaseConfig(directory, ["*.ts"]);
    const prelude = `import { test as registeredTest } from "node:test";
declare function operation(): Promise<void>;
declare const optional: { value: string } | undefined;
declare function takesCallback(callback: () => void): void;
declare const other: string;
`;
    /** @type {[name: string, body: string, rule: string | null | undefined][]} */
    const files = [
      ["floating", "operation();", "no-floating-promises"],
      ["void-floating", "void operation();", "no-floating-promises"],
      ["misused", "takesCallback(async () => {});", "no-misused-promises"],
      ["await", "await 42;", "await-thenable"],
      [
        "optional",
        "const value = optional?.value!;",
        "no-non-null-asserted-optional-chain",
      ],
      [
        "confusing",
        "const equal = other! == other;",
        "no-confusing-non-null-assertion",
      ],
      [
        "local-test",
        "{ async function test() {} test(); }",
        "no-floating-promises",
      ],
      [
        "local-execute",
        "class Local { async execute() {} } new Local().execute();",
        "no-floating-promises",
      ],
      [
        "unused-disable",
        "// eslint-disable-next-line @typescript-eslint/no-floating-promises\nvoid 0;",
        null,
      ],
      [
        "valid",
        "await operation(); registeredTest('owned registration', async () => { await operation(); });",
        undefined,
      ],
    ];
    for (const [name, body] of files)
      await writeFile(join(directory, `${name}.ts`), prelude + body);
    const eslint = new ESLint({
      cwd: dirname(directory),
      overrideConfigFile: true,
      overrideConfig: relocatedConfig(directory, "./tsconfig.json", ["*.ts"]),
    });
    for (const [name, , rule] of files) {
      const [result] = await eslint.lintFiles([join(directory, `${name}.ts`)]);
      assert.deepEqual(
        result.messages.map((message) => message.ruleId),
        rule === null ? [null] : rule ? [`@typescript-eslint/${rule}`] : [],
        `${name} must exercise its actual rule, not a parser failure`,
      );
      if (rule === null)
        assert.match(
          result.messages[0].message,
          /Unused eslint-disable directive/,
        );
    }
  });
});

test("actual JavaScript helper and fixture scopes reject async mistakes and accept owned promises", async () => {
  const helperConfig = await readFile(
    new URL("../tsconfig.helpers.json", import.meta.url),
    "utf8",
  );
  const prelude = `// @ts-check
async function operation() {}
/** @param {() => void} callback */
function takesCallback(callback) { callback(); }
`;
  /** @type {[name: string, body: string, rule: string | undefined][]} */
  const cases = [
    ["floating", "operation();", "no-floating-promises"],
    ["void-floating", "void operation();", "no-floating-promises"],
    ["misused", "takesCallback(async () => {});", "no-misused-promises"],
    [
      "valid",
      "await operation(); export function owned() { return operation(); }",
      undefined,
    ],
  ];
  for (const filename of [
    "scripts/host-fixture.mjs",
    "test/testdata/owned-builder.mjs",
    "../tools/vulnerability.test.mjs",
  ]) {
    for (const [name, body, rule] of cases) {
      await withGateProject(async (directory) => {
        await writeBaseConfig(directory, []);
        await writeFile(join(directory, "tsconfig.helpers.json"), helperConfig);
        await mkdir(join(directory, filename, ".."), { recursive: true });
        await writeFile(join(directory, filename), prelude + body);
        const eslint = new ESLint({
          cwd: dirname(directory),
          overrideConfigFile: true,
          overrideConfig: relocatedConfig(directory),
        });
        const [result] = await eslint.lintFiles([join(directory, filename)]);
        assert.deepEqual(
          result.messages.map((message) => message.ruleId),
          rule ? [`@typescript-eslint/${rule}`] : [],
          `${filename} ${name} must exercise the production helper selector and rule`,
        );
        assert.deepEqual(
          helperDiagnostics(directory).map((diagnostic) => diagnostic.code),
          [],
          `${filename} ${name} must be a valid typed fixture`,
        );
      });
    }
  }
});

test("actual helper compiler rejects a bad JSDoc argument and checks valid fixture arguments", async () => {
  const helperConfig = await readFile(
    new URL("../tsconfig.helpers.json", import.meta.url),
    "utf8",
  );
  for (const filename of [
    "scripts/host-fixture.mjs",
    "test/testdata/owned-builder.mjs",
    "../tools/vulnerability.test.mjs",
  ]) {
    /** @type {[argument: string, codes: number[]][]} */
    const argumentsToCheck = [
      ['"wrong"', [2345]],
      ["42", []],
    ];
    for (const [argument, codes] of argumentsToCheck) {
      await withGateProject(async (directory) => {
        await writeBaseConfig(directory, []);
        await writeFile(join(directory, "tsconfig.helpers.json"), helperConfig);
        await mkdir(join(directory, filename, ".."), { recursive: true });
        await writeFile(
          join(directory, filename),
          `// @ts-check
/** @param {number} count */
function countItems(count) { return count; }
countItems(${argument});
`,
        );
        assert.deepEqual(
          helperDiagnostics(directory).map((diagnostic) => diagnostic.code),
          codes,
          `${filename} must be included and strictly checked by the production helper compiler config`,
        );
      });
    }
  }
});

test("every configured JavaScript helper root retains strict compiler and typed promise coverage", async () => {
  const filename = new URL("../tsconfig.helpers.json", import.meta.url);
  const configPath = fileURLToPath(filename);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(read.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    fileURLToPath(new URL("..", import.meta.url)),
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.options.strict, true);
  const helpers = parsed.fileNames.filter((name) => name.endsWith(".mjs"));
  assert.ok(helpers.length > 0, "the helper compiler must have explicit roots");
  const eslint = new ESLint({
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  for (const name of helpers) {
    const source = await readFile(name, "utf8");
    assert.match(
      source,
      /^\s*\/\/ @ts-check(?:\r?\n|$)/,
      `${name} must retain its checked-root pragma`,
    );
    const policy = await eslint.calculateConfigForFile(name);
    assert.ok(policy, `${name} must have a lint policy`);
    const parserOptions = policy.languageOptions?.parserOptions;
    assert.ok(parserOptions && typeof parserOptions === "object");
    assert.ok("project" in parserOptions);
    assert.equal(
      parserOptions.project,
      "./tsconfig.helpers.json",
      `${name} must use the actual typed helper project`,
    );
    for (const rule of [
      "no-floating-promises",
      "no-misused-promises",
      "await-thenable",
    ]) {
      const setting = policy.rules?.[`@typescript-eslint/${rule}`];
      assert.ok(Array.isArray(setting));
      assert.equal(setting[0], 2, `${name} must enforce ${rule}`);
    }
  }
});
