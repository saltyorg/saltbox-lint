import { createVSIX } from "@vscode/vsce";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  root,
  extension,
  manifest,
  targets,
  run,
  sha256,
} from "./release-inputs.mjs";
import { filesIn } from "./source.mjs";
import { verifyPackage } from "./verify-package.mjs";

export async function packageTargets(sourceDirectory) {
  const source = JSON.parse(readFileSync(join(sourceDirectory, "SOURCE.json")));
  const artifacts = JSON.parse(readFileSync(join(root, "dist/artifacts.json")));
  const results = [];
  for (const [target, [goos, goarch]] of Object.entries(targets)) {
    const candidates = artifacts.filter(
      (a) => a.type === "Binary" && a.goos === goos && a.goarch === goarch,
    );
    if (candidates.length !== 1)
      throw new Error(
        `Expected one ${goos}/${goarch} GoReleaser binary, found ${candidates.length}`,
      );
    const binary = join(root, candidates[0].path);
    const metadata = run("go", ["version", "-m", binary]);
    for (const expected of [
      "-trimpath=true",
      "CGO_ENABLED=0",
      `GOOS=${goos}`,
      `GOARCH=${goarch}`,
    ])
      if (!metadata.includes(expected))
        throw new Error(`${target} build is missing ${expected}`);
    const stage = mkdtempSync(join(tmpdir(), "saltbox-vsix-"));
    const filename = `saltbox-lint-${manifest.version}-${target}.vsix`;
    try {
      mkdirSync(join(stage, "bin"));
      mkdirSync(join(stage, "dist"));
      cpSync(
        binary,
        join(stage, "bin", `saltbox-lint${goos === "windows" ? ".exe" : ""}`),
      );
      cpSync(
        join(extension, "dist/extension.js"),
        join(stage, "dist/extension.js"),
      );
      for (const name of [
        "README.md",
        "CHANGELOG.md",
        "PRIVACY.md",
        "SUPPORT.md",
      ])
        cpSync(join(extension, name), join(stage, name));
      for (const name of ["LICENSE", "THIRD_PARTY_NOTICES"])
        cpSync(join(root, name), join(stage, name));
      cpSync(join(sourceDirectory, "SOURCE.json"), join(stage, "SOURCE.json"));
      cpSync(join(sourceDirectory, "licenses"), join(stage, "licenses"), {
        recursive: true,
      });
      const { scripts, devDependencies, packageManager, ...runtimeManifest } =
        manifest;
      delete runtimeManifest.engines.node;
      // This is an explicit generated allowlist, independently checked after ZIP creation.
      runtimeManifest.files = filesIn(stage).map((path) =>
        path.replaceAll("\\", "/"),
      );
      writeFileSync(
        join(stage, "package.json"),
        JSON.stringify(runtimeManifest, null, 2) + "\n",
      );
      for (const path of filesIn(stage))
        chmodSync(join(stage, path), path.startsWith("bin/") ? 0o755 : 0o644);
      await createVSIX({
        cwd: stage,
        packagePath: join(root, "dist", filename),
        target,
        dependencies: false,
        githubBranch: "main",
      });
      await verifyPackage(join(root, "dist", filename), target, source, binary);
      results.push({
        target,
        filename,
        sha256: sha256(readFileSync(join(root, "dist", filename))),
        binary_sha256: sha256(readFileSync(binary)),
        goos,
        goarch,
        build_metadata: metadata,
      });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return results;
}
