import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { manifest } from "./release-inputs.mjs";
const target = `${process.platform}-${process.arch}`;
const vsix = resolve(`../dist/saltbox-lint-${manifest.version}-${target}.vsix`);
for (const version of ["1.100.0", "1.137.0"]) {
  const executable = await downloadAndUnzipVSCode(version);
  for (const mode of [
    "normal",
    "regressions",
    "markers",
    "save-scope",
    "untrusted",
    "disabled",
  ]) {
    const result = spawnSync(process.execPath, ["scripts/test-host.mjs"], {
      stdio: "inherit",
      timeout: 180000,
      env: {
        ...process.env,
        VSCODE_EXECUTABLE_PATH: executable,
        SALTBOX_TEST_VSIX: vsix,
        SALTBOX_TEST_REGRESSIONS: mode === "regressions" ? "1" : "0",
        SALTBOX_TEST_MARKERS: mode === "markers" ? "1" : "0",
        SALTBOX_TEST_SAVE_SCOPE: mode === "save-scope" ? "1" : "0",
        SALTBOX_TEST_UNTRUSTED: mode === "untrusted" ? "1" : "0",
        SALTBOX_TEST_DISABLED: ["disabled", "save-scope"].includes(mode)
          ? "1"
          : "0",
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `${target} VS Code ${version} ${mode} failed: ${result.status}`,
      );
  }
}
