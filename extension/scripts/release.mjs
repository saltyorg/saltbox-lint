import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  root,
  extension,
  manifest,
  sourceName,
  run,
  sha256,
} from "./release-inputs.mjs";
import { createSource, filesIn } from "./source.mjs";
import { packageTargets } from "./package.mjs";
import { verifyCLIArchives } from "./verify-package.mjs";

if (process.platform !== "linux")
  throw new Error(
    "Release packaging runs on Linux to preserve ZIP executable modes",
  );
const stable = process.argv.includes("--stable");
if (stable) {
  if (
    run("git", ["describe", "--tags", "--exact-match"]).trim() !==
    `v${manifest.version}`
  )
    throw new Error("Stable tag must match extension/package.json");
  if (run("git", ["status", "--porcelain", "--untracked-files=no"]).trim())
    throw new Error("Stable artifacts require a clean tracked worktree");
}
process.env.SALTBOX_RELEASE_KIND = stable ? "stable" : "snapshot";
process.env.SALTBOX_RELEASE_VERSION = manifest.version;
run(process.execPath, ["scripts/build.mjs"], {
  cwd: extension,
  stdio: "inherit",
});
const source = await createSource();
// GoReleaser owns dist/ and cleans it. Preserve the source outside dist until it finishes.
run(
  join(root, "bin/tools/goreleaser-v2.18.1/goreleaser"),
  ["release", "--clean", ...(stable ? ["--skip=publish"] : ["--snapshot"])],
  { stdio: "inherit" },
);
cpSync(join(source, sourceName), join(root, "dist", sourceName));
cpSync(join(source, "SOURCE.json"), join(root, "dist/SOURCE.json"));
await verifyCLIArchives(
  join(root, "dist"),
  JSON.parse(readFileSync(join(source, "SOURCE.json"))),
);
const packages = await packageTargets(source);
writeFileSync(
  join(root, "dist/vsix-artifacts.json"),
  JSON.stringify(
    { ...JSON.parse(readFileSync(join(source, "SOURCE.json"))), packages },
    null,
    2,
  ) + "\n",
);
// Cover the final adjacent source, CLI archives, VSIXs and provenance after packaging.
const names = filesIn(join(root, "dist")).filter(
  (path) =>
    !path.includes("/") &&
    (path.endsWith(".vsix") ||
      path.endsWith(".tar.gz") ||
      path.endsWith(".zip") ||
      ["SOURCE.json", "vsix-artifacts.json"].includes(path)),
);
writeFileSync(
  join(root, "dist/checksums.txt"),
  names
    .map(
      (path) => `${sha256(readFileSync(join(root, "dist", path)))}  ${path}\n`,
    )
    .join(""),
);
console.log(
  `Verified ${packages.length} platform VSIXs and matching ${sourceName} (${process.env.SALTBOX_RELEASE_KIND})`,
);
