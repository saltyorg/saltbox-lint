import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const target = fileURLToPath(
  new URL(
    "../bin/saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
    import.meta.url,
  ),
);
mkdirSync(fileURLToPath(new URL("../bin", import.meta.url)), {
  recursive: true,
});
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
const result = spawnSync(
  "go",
  [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X main.version=${version}`,
    "-o",
    target,
    ".",
  ],
  {
    cwd: root,
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: "inherit",
    shell: false,
  },
);
process.exit(result.status ?? 1);
