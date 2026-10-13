import tseslint from "typescript-eslint";

/** @type {import('eslint').Linter.RulesRecord} */
const promiseRules = {
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
};

const helpers = [
  "scripts/build.mjs",
  "scripts/host-fixture.mjs",
  "scripts/host-inputs.mjs",
  "scripts/host-launcher.mjs",
  "scripts/host-process-supervisor.mjs",
  "scripts/native-hosts.mjs",
  "scripts/owned-command.mjs",
  "scripts/owned-command-posix.mjs",
  "scripts/owned-group.mjs",
  "scripts/stage-binary.mjs",
  "scripts/test-host.mjs",
  "scripts/test-native-hosts.mjs",
  "test/{editor-acceptance,host-process-supervisor,release-liveness,lint-gate}.test.mjs",
  "test/owned-command-guardian.test.mjs",
  "test/native-fixture-lifetime.test.mjs",
  "test/go-tool-install.test.mjs",
  "test/testdata/*.mjs",
];

/** @param {string[]} files @param {string} project @returns {import('eslint').Linter.Config} */
function typedProject(files, project) {
  return {
    files,
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: promiseRules,
  };
}

export default [
  typedProject(["src/**/*.ts", "test/**/*.ts"], "./tsconfig.json"),
  typedProject(helpers, "./tsconfig.helpers.json"),
  {
    basePath: "..",
    ...typedProject(
      [
        "tools/vulnerability.test.mjs",
        "tools/install-go-tool.mjs",
        "tools/report-go-tool-output.mjs",
      ],
      "./tsconfig.helpers.json",
    ),
  },
];
