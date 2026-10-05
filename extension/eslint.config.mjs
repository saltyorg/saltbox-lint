import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: false,
          checkThenables: true,
          allowForKnownSafeCalls: [
            // Node owns test registration failures. Only its ambient module
            // symbol is exempt; local functions named test remain checked.
            { from: "package", name: "test", package: "node:test" },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-confusing-non-null-assertion": "error",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
    },
  },
];
