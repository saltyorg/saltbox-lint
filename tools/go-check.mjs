// Local and native checks share the current project source boundary.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = process.cwd();
let activeChild;
const forwardSignal = (signal) => activeChild?.kill(signal);
// Keep signals handled while a synchronous source snapshot is being copied.
// Once the child starts, forward interruption and join it before cleanup.
process.on("SIGINT", forwardSignal);
process.on("SIGTERM", forwardSignal);

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  }
  return result.stdout;
}

function sourceFiles() {
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
    const git = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });
    const candidates = git.status === 0 ? git.stdout.split("\0") : [];
    if (candidates.includes("go.mod")) files = candidates;
    else {
      const { inputs } = JSON.parse(readFileSync("SOURCE-PROVENANCE.json"));
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
        throw new Error("Source provenance must contain an inputs object");
      files = Object.keys(inputs);
    }
  } else files = capture("git", gitArgs).split("\0");
  return [...new Set(files)]
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
}

function packages(files) {
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
  const output = capture("go", [
    "list",
    "-e",
    "-f",
    '{{if or .GoFiles .CgoFiles .TestGoFiles .XTestGoFiles .InvalidGoFiles}}{{.ImportPath}}{{end}}{{"\\x00"}}',
    ...[...directories].sort(),
  ]);
  const selected = output.split("\0\n").filter(Boolean);
  if (!selected.length)
    throw new Error(
      "No project Go packages match the current build constraints",
    );
  return selected;
}

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    activeChild = child;
    child.once("error", reject);
    child.once("close", (status, signal) => {
      activeChild = undefined;
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(status);
    });
  });
}

async function tidy(files) {
  // tidy discovers directories itself and has no package-list argument.
  // Copy current bytes, including embeds and local module replacements, rather
  // than checking an index/commit snapshot or rewriting installed dependencies.
  const snapshot = mkdtempSync(join(tmpdir(), "saltbox-lint-go-tidy-"));
  try {
    for (const file of files) {
      const target = join(snapshot, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
    }
    return await run("go", ["mod", "tidy", "-diff"], snapshot);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command)
    throw new Error("Usage: node tools/go-check.mjs tidy | COMMAND ARGS...");
  const files = sourceFiles();
  process.exitCode =
    command === "tidy"
      ? await tidy(files)
      : await run(command, [...args, ...packages(files)]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
}
