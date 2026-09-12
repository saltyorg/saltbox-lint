import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const result = spawnSync(
  "go",
  [
    "build",
    "-o",
    resolve(
      "bin/process-fixture" + (process.platform === "win32" ? ".exe" : ""),
    ),
    "./test/testdata/process_fixture.go",
  ],
  { stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0" }, shell: false },
);
process.exit(result.status ?? 1);
