import extensionConfig from "./extension/eslint.config.mjs";

// ESLint 10 resolves config from each file's directory. Reuse the extension's
// selected sibling-tool policy from the repository root without duplicating it.
export default extensionConfig
  .filter((entry) => entry.basePath === "..")
  .map((entry) => ({ ...entry, basePath: "." }));
