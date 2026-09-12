// Linux release-time source export. No tracked source or dependency is rewritten.
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  root,
  manifest,
  sourceName,
  oniguruma,
  run,
  sha256,
} from "./release-inputs.mjs";

export function filesIn(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const name = join(prefix, entry.name);
      return entry.isDirectory()
        ? filesIn(join(directory, entry.name), name)
        : [name];
    })
    .sort();
}
function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}
export async function createSource() {
  if (run("git", ["ls-files", "--others", "--exclude-standard", "-z"]).length)
    throw new Error(
      "Stage all nonignored source inputs before packaging; untracked files would not have corresponding source",
    );
  const output = join(root, "bin/release-source");
  rmSync(output, { recursive: true, force: true });
  const tree = join(output, "saltbox-lint-source");
  mkdirSync(tree, { recursive: true });
  const inputs = {};
  // Only version-controlled paths; scratch examples, SDKs, caches and credentials stay out.
  for (const path of run("git", ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort()) {
    if (!lstatSync(join(root, path)).isFile())
      throw new Error(`Source input must be a regular file: ${path}`);
    inputs[path] = sha256(readFileSync(join(root, path)));
    copy(join(root, path), join(tree, path));
  }
  run("go", ["mod", "vendor", "-o", join(tree, "vendor")]);
  const tarball = join(output, "onig-6.9.10.tar.gz");
  if (process.env.ONIGURUMA_SOURCE_ARCHIVE)
    copy(process.env.ONIGURUMA_SOURCE_ARCHIVE, tarball);
  else
    run("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--output",
      tarball,
      oniguruma.url,
    ]);
  if (sha256(readFileSync(tarball)) !== oniguruma.sha256)
    throw new Error("Oniguruma source checksum mismatch");
  const deps = join(tree, "source-deps");
  mkdirSync(deps);
  run("tar", ["-xzf", tarball, "-C", deps]);
  copy(tarball, join(deps, "onig-6.9.10.tar.gz"));
  writeFileSync(
    join(deps, "oniguruma.json"),
    JSON.stringify(oniguruma, null, 2) + "\n",
  );
  const licenses = join(output, "licenses");
  mkdirSync(licenses);
  // Include all vendored license/notice files, including nested package licenses.
  for (const path of filesIn(join(tree, "vendor"))) {
    if (
      /(^|[/\\])(licen[sc]e|copying|copyright|notice|third.party.notice)([.\-_]|$)/i.test(
        path,
      )
    )
      copy(join(tree, "vendor", path), join(licenses, "go", path));
  }
  for (const path of filesIn(join(root, "highlight/assets/licenses")))
    copy(
      join(root, "highlight/assets/licenses", path),
      join(licenses, "assets", path),
    );
  for (const path of ["LICENSE", "THIRD-PARTY-NOTICE"])
    copy(join(root, "third_party/nuri", path), join(licenses, "nuri", path));
  copy(join(deps, "onig-6.9.10/COPYING"), join(licenses, "oniguruma-COPYING"));
  copy(
    join(run("go", ["env", "GOROOT"]).trim(), "LICENSE"),
    join(licenses, "go-toolchain-LICENSE"),
  );
  const licenseHashes = Object.fromEntries(
    filesIn(licenses).map((path) => [
      path.replaceAll("\\", "/"),
      sha256(readFileSync(join(licenses, path))),
    ]),
  );
  writeFileSync(
    join(licenses, "inventory.json"),
    JSON.stringify(licenseHashes, null, 2) + "\n",
  );
  const provenance = {
    version: manifest.version,
    build_kind: process.env.SALTBOX_RELEASE_KIND ?? "snapshot",
    commit: run("git", ["rev-parse", "HEAD"]).trim(),
    tracked_worktree_dirty:
      run("git", ["status", "--porcelain", "--untracked-files=no"]).trim() !==
      "",
    inputs,
    go: run("go", ["version"]).trim(),
    node: process.version,
    npm: run("npm", ["--version"]).trim(),
    oniguruma,
    nuri_wasm_sha256: sha256(
      readFileSync(join(tree, "third_party/nuri/resources/wasm/onig.wasm")),
    ),
    modules: run("go", ["list", "-m", "all"]).trim().split("\n"),
  };
  writeFileSync(
    join(tree, "SOURCE-PROVENANCE.json"),
    JSON.stringify(provenance, null, 2) + "\n",
  );
  cpSync(licenses, join(tree, "release-licenses"), { recursive: true });
  const epoch = run("git", ["show", "-s", "--format=%ct", "HEAD"]).trim();
  run("tar", [
    "--sort=name",
    `--mtime=@${epoch}`,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    join(output, sourceName),
    "-C",
    output,
    "saltbox-lint-source",
  ]);
  const notice = {
    version: manifest.version,
    build_kind: process.env.SALTBOX_RELEASE_KIND ?? "snapshot",
    commit: provenance.commit,
    tracked_worktree_dirty: provenance.tracked_worktree_dirty,
    source_archive: sourceName,
    source_sha256: sha256(readFileSync(join(output, sourceName))),
    source_url: `https://github.com/saltyorg/saltbox-lint/releases/download/v${manifest.version}/${sourceName}`,
    availability:
      "Publication gate: publish this exact archive at the URL above at no charge before distributing the VSIX.",
    nuri_wasm_sha256: provenance.nuri_wasm_sha256,
    licenses: licenseHashes,
  };
  writeFileSync(
    join(output, "SOURCE.json"),
    JSON.stringify(notice, null, 2) + "\n",
  );
  return output;
}
