import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownedCommand } from "./owned-command.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const target = fileURLToPath(
  new URL(
    "../bin/saltbox-lint" + (process.platform === "win32" ? ".exe" : ""),
    import.meta.url,
  ),
);
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
export async function stageBinary({
  command = "go",
  prefix = [],
  output = target,
  timeoutMs = 300000,
} = {}) {
  mkdirSync(dirname(output), { recursive: true });
  await ownedCommand(
    command,
    [
      ...prefix,
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.version=${version}`,
      "-o",
      output,
      ".",
    ],
    {
      phase: "stage release CLI",
      timeoutMs,
      cwd: root,
      env: { ...process.env, CGO_ENABLED: "0" },
      stdio: "inherit",
    },
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await stageBinary();
