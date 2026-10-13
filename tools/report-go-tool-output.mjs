// @ts-check
import { readFile } from "node:fs/promises";

const [stdout, stderr] = process.argv.slice(2);
if (!stdout || !stderr || process.argv.length !== 4)
  throw new Error("Two owned output files are required");
const loaded = await Promise.allSettled([readFile(stdout), readFile(stderr)]);
const readErrors = loaded.flatMap((outcome) =>
  outcome.status === "rejected" ? [outcome.reason] : [],
);
if (readErrors.length)
  throw new AggregateError(readErrors, "Tool output could not be read");
const buffers = loaded.flatMap((outcome) =>
  outcome.status === "fulfilled" ? [outcome.value] : [],
);
const outcomes = await Promise.allSettled(
  buffers.map(
    (buffer, index) =>
      new Promise((resolve, reject) => {
        (index === 0 ? process.stdout : process.stderr).write(
          buffer,
          (error) => (error ? reject(error) : resolve(undefined)),
        );
      }),
  ),
);
const errors = outcomes.flatMap((outcome) =>
  outcome.status === "rejected" ? [outcome.reason] : [],
);
if (errors.length)
  throw new AggregateError(errors, "Tool output delivery failed");
