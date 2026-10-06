// Local and native checks share the current project source boundary.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ownedCommand } from "../extension/scripts/owned-command.mjs";

import { sourceFiles, packages } from "./go-source.mjs";

const root = process.cwd();
const interruption = new AbortController();
const forwardSignal = (signal) => interruption.abort(new Error(signal));
// Keep signals handled while a synchronous source snapshot is being copied.
// Once the child starts, forward interruption and join it before cleanup.
process.on("SIGINT", forwardSignal);
process.on("SIGTERM", forwardSignal);

function run(command, args, cwd = root) {
  return ownedCommand(command, args, {
    phase: "project Go check",
    cwd,
    stdio: "inherit",
    signal: interruption.signal,
    returnExitCode: true,
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
  const files = await sourceFiles(interruption.signal);
  process.exitCode =
    command === "tidy"
      ? await tidy(files)
      : await run(command, [
          ...args,
          ...(await packages(files, interruption.signal)),
        ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
}
