// Local and native checks share the current project source boundary.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ownedCommand } from "../extension/scripts/owned-command.mjs";

const root = process.cwd();

// This replacement retains its complete public API and production packages.
// Ordinary root package discovery keeps nested modules separate; maintained
// modules receive their own canonical test, vet, lint, tidy and scanner scope.
export function maintainedModules(files) {
  const directory = "third_party/go-yaml";
  if (!files.includes(`${directory}/go.mod`)) return [];
  const directories = new Set();
  for (const file of files) {
    if (!file.startsWith(`${directory}/`) || !file.endsWith(".go")) continue;
    const parts = file
      .slice(directory.length + 1)
      .split("/")
      .slice(0, -1);
    if (
      parts.some(
        (part) =>
          part === "testdata" ||
          part === "vendor" ||
          part.startsWith(".") ||
          part.startsWith("_"),
      )
    )
      continue;
    if (
      parts.some((_, index) =>
        existsSync(join(directory, ...parts.slice(0, index + 1), "go.mod")),
      )
    )
      continue;
    directories.add(parts.length ? `./${parts.join("/")}` : ".");
  }
  return [
    {
      directory,
      name: "go-yaml",
      path: "github.com/goccy/go-yaml",
      packages: [...directories].sort(),
    },
  ];
}

function capture(command, args, signal, env = process.env) {
  return ownedCommand(command, args, {
    phase: "project Go source discovery",
    cwd: root,
    signal,
    maxOutputBytes: 16 * 1024 * 1024,
    env: { ...env, LC_ALL: "C" },
  });
}

export async function sourceFiles(signal) {
  const gitArgs = [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ];
  let files;
  if (existsSync("SOURCE-PROVENANCE.json") && !existsSync(".git")) {
    // An unpacked archive may itself live in an ignored directory of another
    // checkout. Prefer Git whenever this module actually has Git source inputs.
    let candidates;
    try {
      candidates = (await capture("git", gitArgs, signal)).split("\0");
    } catch (error) {
      // A missing repository may use the published inventory. Command errors,
      // owner cancellation and cleanup failures must never trigger fallback.
      const noRepository =
        error.exitCode === 128 &&
        error.stderr?.startsWith("fatal: not a git repository");
      const noGit =
        error.cause?.code === "ENOENT" && error.cause?.path === "git";
      if (!noRepository && !noGit) throw error;
      candidates = [];
    }
    if (candidates.includes("go.mod")) files = candidates;
    else {
      const { inputs } = JSON.parse(readFileSync("SOURCE-PROVENANCE.json"));
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
        throw new Error("Source provenance must contain an inputs object");
      if (
        Object.entries(inputs).some(
          ([path, hash]) =>
            !path || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
        )
      )
        throw new Error(
          "Source provenance inputs must map paths to SHA-256 hashes",
        );
      files = Object.keys(inputs);
    }
  } else files = (await capture("git", gitArgs, signal)).split("\0");
  const selected = [...new Set(files)]
    .filter(Boolean)
    .sort()
    .filter((file) => {
      const local = relative(root, resolve(root, file));
      if (isAbsolute(file) || local === ".." || local.startsWith(`..${sep}`))
        throw new Error(`Source input escapes the module: ${file}`);
      // Tracked deletions must stay deleted; other I/O failures must surface.
      try {
        return !lstatSync(file).isDirectory();
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
  // An existing ignored go.mod still defines a real module boundary. Preserve
  // that context in tidy's snapshot when project Go files lie below it.
  const inputs = new Set(selected);
  for (const file of selected) {
    if (!file.endsWith(".go")) continue;
    const folders = file.split("/").slice(0, -1);
    for (let count = 1; count <= folders.length; count++) {
      const marker = `${folders.slice(0, count).join("/")}/go.mod`;
      if (existsSync(marker)) inputs.add(marker);
    }
  }
  return [...inputs].sort();
}

export async function packages(files, signal, env = process.env) {
  const directories = new Set();
  for (const file of files) {
    if (!file.endsWith(".go")) continue;
    const parts = file.split("/");
    if (parts.some((part) => part.startsWith(".") || part.startsWith("_")))
      continue;
    const folders = parts.slice(0, -1);
    if (folders.some((part) => part === "testdata" || part === "vendor"))
      continue;
    if (
      folders.some((_, index) =>
        existsSync(join(...folders.slice(0, index + 1), "go.mod")),
      )
    )
      continue;
    directories.add(folders.length ? `./${folders.join("/")}` : ".");
  }
  if (!directories.size)
    throw new Error("No project Go source directories found");
  // Go applies GOOS/GOARCH and build tags. Every record ends with NUL plus
  // go list's newline, so filenames never become shell words or line records.
  const output = await capture(
    "go",
    [
      "list",
      "-e",
      "-f",
      '{{if or .GoFiles .CgoFiles .TestGoFiles .XTestGoFiles .InvalidGoFiles}}{{.Dir}}{{end}}{{"\\x00"}}',
      ...[...directories].sort(),
    ],
    signal,
    env,
  );
  const selected = output.split("\0\n").filter(Boolean);
  if (!selected.length)
    throw new Error(
      "No project Go packages match the current build constraints",
    );
  return selected.map((directory) => {
    const local = relative(root, directory).split(sep).join("/");
    return local ? `./${local}` : ".";
  });
}
