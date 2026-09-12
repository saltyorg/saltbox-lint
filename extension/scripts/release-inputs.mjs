import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const extension = fileURLToPath(new URL("../", import.meta.url));
export const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
export const targets = {
  "linux-x64": ["linux", "amd64"],
  "linux-arm64": ["linux", "arm64"],
  "alpine-x64": ["linux", "amd64"],
  "alpine-arm64": ["linux", "arm64"],
  "darwin-x64": ["darwin", "amd64"],
  "darwin-arm64": ["darwin", "arm64"],
  "win32-x64": ["windows", "amd64"],
  "win32-arm64": ["windows", "arm64"],
};
export const sourceName = `saltbox-lint_${manifest.version}_source.tar.gz`;
export const oniguruma = {
  version: "6.9.10",
  url: "https://github.com/kkos/oniguruma/releases/download/v6.9.10/onig-6.9.10.tar.gz",
  sha256: "2a5cfc5ae259e4e97f86b68dfffc152cdaffe94e2060b770cb827238d769fc05",
};
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  return result.stdout;
}
