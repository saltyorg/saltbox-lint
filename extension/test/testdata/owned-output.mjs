import { writeFileSync } from "node:fs";
import { ownedCommand } from "../../scripts/owned-command.mjs";

const [fixture, mode, record, result] = process.argv.slice(2);
const counts = () =>
  [process.stdout, process.stderr].map((stream) =>
    ["error", "close", "drain"].map((event) => stream.listenerCount(event)),
  );
const before = counts();
const start = Date.now();
let error;
try {
  const args = mode.endsWith("-output")
    ? [
        "-e",
        `process.stdout.write("normal stdout\\n"); process.stderr.write("normal stderr\\n"); process.exitCode = ${mode === "error-output" ? 7 : 0}`,
      ]
    : [fixture, mode, record];
  await ownedCommand(process.execPath, args, {
    phase: "owned output control",
    timeoutMs: 30000,
    stdio: "inherit",
  });
} catch (failure) {
  error = failure.message;
}
writeFileSync(
  result,
  JSON.stringify({
    error,
    elapsed: Date.now() - start,
    settledAt: Date.now(),
    before,
    after: counts(),
  }),
);
