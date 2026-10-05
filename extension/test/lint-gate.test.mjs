import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import config from "../eslint.config.mjs";

test("typed correctness gate rejects async mistakes and unsafe assertion patterns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saltbox-eslint-"));
  try {
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          typeRoots: [resolve("node_modules/@types")],
          types: ["node"],
        },
        include: ["*.ts"],
      }),
    );
    const prelude = `import { test as registeredTest } from "node:test";
declare function operation(): Promise<void>;
declare const optional: { value: string } | undefined;
declare function takesCallback(callback: () => void): void;
declare const other: string;
`;
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
      cwd: directory,
      overrideConfigFile: true,
      overrideConfig: config.map((entry) => ({
        ...entry,
        files: ["*.ts"],
        languageOptions: {
          ...entry.languageOptions,
          parserOptions: {
            ...entry.languageOptions.parserOptions,
            tsconfigRootDir: directory,
          },
        },
      })),
    });
    for (const [name, , rule] of files) {
      const [result] = await eslint.lintFiles([`${name}.ts`]);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
