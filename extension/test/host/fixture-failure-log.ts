import { closeSync, openSync, readSync } from "node:fs";

const stages = new Set([
  "instance-listen",
  "instance-random",
  "instance-open",
  "instance-write",
  "instance-close",
  "instance-accept",
  "process-log-open",
  "process-log-write",
  "process-log-close",
  "stdin-read",
  "gate-selection-decode",
  "gate-selection-empty",
  "readiness-marshal",
  "readiness-write",
  "readiness-rename",
  "stdout-write",
  "child-start",
]);
const classes = new Set(["errno", "json", "invalid-input", "other"]);
interface FixtureFailure {
  stage: string;
  error_class: string;
  pid: number;
  operation: "format" | "check" | "other";
  errno?: number;
}

// The proxy's captured stderr reaches an editor output channel. Read its
// separate test-only log after failure so the same safe stages reach CI.
export function fixtureFailureRecords(bytes: Uint8Array): FixtureFailure[] {
  if (bytes.byteLength > 4096) return [];
  const records: FixtureFailure[] = [];
  for (const line of Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .slice(0, 32)) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value))
        continue;
      const fields = value as Record<string, unknown>;
      if (
        typeof fields.stage !== "string" ||
        !stages.has(fields.stage) ||
        typeof fields.error_class !== "string" ||
        !classes.has(fields.error_class) ||
        typeof fields.pid !== "number" ||
        !Number.isSafeInteger(fields.pid) ||
        fields.pid <= 0 ||
        typeof fields.operation !== "string" ||
        !["format", "check", "other"].includes(fields.operation) ||
        Object.keys(fields).some(
          (key) =>
            !["stage", "error_class", "errno", "pid", "operation"].includes(
              key,
            ),
        )
      )
        continue;
      if (
        fields.errno !== undefined &&
        (fields.error_class !== "errno" ||
          typeof fields.errno !== "number" ||
          !Number.isSafeInteger(fields.errno) ||
          fields.errno < 0)
      )
        continue;
      if (fields.error_class === "errno" && fields.errno === undefined)
        continue;
      records.push({
        stage: fields.stage,
        error_class: fields.error_class,
        pid: fields.pid,
        operation: fields.operation as FixtureFailure["operation"],
        ...(fields.errno === undefined
          ? {}
          : { errno: fields.errno as number }),
      });
    } catch {
      // Partial or malformed evidence cannot replace the original failure.
    }
  }
  return records;
}

export function reportFixtureFailures(
  filename: string,
  emit: (record: FixtureFailure) => void = (record) =>
    console.error("SALTBOX_TEST_FIXTURE_FAILURE " + JSON.stringify(record)),
  operation?: FixtureFailure["operation"],
): void {
  try {
    const fd = openSync(filename, "r");
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(4097);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, length);
    } finally {
      closeSync(fd);
    }
    for (const record of fixtureFailureRecords(bytes))
      if (operation === undefined || record.operation === operation)
        emit(record);
  } catch {
    // Missing evidence or output failure preserves the existing exception.
  }
}
