// @ts-check
import { ownedCommand } from "../extension/scripts/owned-command.mjs";
import { hostFailureEvidence } from "../extension/test/support/host-failure.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @typedef {{env?: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number}} InstallOptions */
/** @typedef {import('../extension/scripts/owned-command.mjs').CommandOutput} CommandOutput */
/** @typedef {import('../extension/scripts/owned-command.mjs').OwnedCommandOptions & {captureOutput: true, returnExitCode?: false}} InstallCommandOptions */
/** @typedef {{runInstall?: (args: string[], options: InstallCommandOptions) => Promise<CommandOutput>, write?: (stream: 'stdout' | 'stderr', text: string) => void, now?: () => number}} InstallDependencies */
/** @typedef {{number: number, stdout: string, stderr: string, error?: unknown}} InstallAttempt */
/** @typedef {{directory?:string, files:{number:number,stdout:string,stderr:string}[],attempts:InstallAttempt[],remaining?:()=>number,env:NodeJS.ProcessEnv,signal?:AbortSignal}} Evidence */
const reporter = fileURLToPath(
  new URL("report-go-tool-output.mjs", import.meta.url),
);

/** @param {unknown[]} errors @param {unknown} [primary] @returns {never} */
function failed(errors, primary = errors.at(-1)) {
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Pinned Go tool installation failed", {
    cause: primary,
  });
}
/** @param {unknown} error @returns {CommandOutput} */
function failureOutput(error) {
  for (
    let depth = 0;
    depth < 8 &&
    error instanceof Error &&
    !("stdout" in error) &&
    "cause" in error;
    depth++
  )
    error = error.cause;
  return {
    stdout:
      error instanceof Error &&
      "stdout" in error &&
      typeof error.stdout === "string"
        ? error.stdout
        : "",
    stderr:
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "",
  };
}
/** @param {unknown} error */
function transientDownload(error) {
  if (
    !(error instanceof Error) ||
    error instanceof AggregateError ||
    !("ownershipReleased" in error) ||
    error.ownershipReleased !== true ||
    !("exitCode" in error) ||
    error.exitCode !== 1 ||
    !("stdout" in error) ||
    error.stdout !== "" ||
    !("stderr" in error) ||
    typeof error.stderr !== "string"
  )
    return false;
  const errors = error.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^go: downloading \S+ v\S+$/.test(line));
  return (
    errors.length > 0 &&
    errors.every((line) =>
      /^(?:go: |.+:\d+(?::\d+)?: )?\S+@v\S+: read "https:\/\/[^"\s]+\/@v\/[^"\s]+\.(?:zip|mod|info)": stream error: stream ID \d+; INTERNAL_ERROR; received from peer$/.test(
        line,
      ),
    )
  );
}
/** @param {Evidence} evidence */
async function directory(evidence) {
  if (!evidence.directory) {
    const base = resolve(evidence.env.GOBIN ?? "bin/tools");
    await mkdir(base, { recursive: true });
    evidence.directory = await mkdtemp(join(base, ".install-evidence-"));
  }
  return evidence.directory;
}
/** @param {Evidence} evidence @param {InstallAttempt} attempt */
async function store(evidence, attempt) {
  const root = await directory(evidence);
  const files = {
    number: attempt.number,
    stdout: join(root, `${attempt.number}.stdout.log`),
    stderr: join(root, `${attempt.number}.stderr.log`),
  };
  const written = await Promise.allSettled([
    writeFile(files.stdout, attempt.stdout, { mode: 0o600 }),
    writeFile(files.stderr, attempt.stderr, { mode: 0o600 }),
  ]);
  const failures = written.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length) failed(failures);
  evidence.files.push(files);
  return files;
}
/** @param {{stdout:string,stderr:string}} files @param {Evidence} evidence */
async function report(files, evidence) {
  if (!evidence.remaining) throw new Error("Missing reporting budget");
  await ownedCommand(process.execPath, [reporter, files.stdout, files.stderr], {
    phase: "Go tool output delivery",
    stdio: "inherit",
    signal: evidence.signal,
    timeoutMs: evidence.remaining(),
  });
  evidence.remaining();
}
/** @param {string} target @param {InstallOptions} options @param {InstallDependencies} dependencies @param {Evidence} evidence */
async function perform(
  target,
  { env = process.env, signal, timeoutMs = 300000 },
  {
    runInstall = (args, options) => ownedCommand("go", args, options),
    write,
    now = () => performance.now(),
  },
  evidence,
) {
  if (!/^\S+@v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(target))
    throw new Error("Tool installation requires one exact pinned version");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000)
    throw new Error("Tool installation budget must be within 300000ms");
  const started = now();
  if (!Number.isFinite(started))
    throw new Error("Tool installation clock is not finite");
  const deadline = started + timeoutMs;
  let last = started;
  /** @type {unknown[]} */ const errors = [];
  /** @type {unknown} */ let primary;
  const remaining = () => {
    if (signal?.aborted)
      throw new Error("Tool installation cancelled", { cause: signal.reason });
    const time = now();
    if (!Number.isFinite(time) || time < last)
      throw new Error("Tool installation clock is not monotonic");
    last = time;
    if (deadline - time <= 0)
      throw new Error("Tool installation exhausted its overall budget");
    return deadline - time;
  };
  evidence.remaining = remaining;
  /** @param {InstallAttempt} attempt */
  const publish = async (attempt) => {
    if (write) {
      /** @type {unknown[]} */ const failures = [];
      for (const stream of /** @type {const} */ (["stdout", "stderr"]))
        try {
          write(stream, attempt[stream]);
        } catch (error) {
          failures.push(error);
        }
      if (failures.length) failed(failures);
    } else {
      const files = await store(evidence, attempt);
      await report(files, evidence);
    }
  };
  try {
    for (let number = 1; number <= 3; number++) {
      const budget = remaining();
      /** @type {CommandOutput} */ let output;
      try {
        output = await runInstall(["install", target], {
          phase: "pinned Go tool installation",
          env,
          signal,
          timeoutMs: budget,
          retainOutputOnError: true,
          captureOutput: true,
          maxOutputBytes: 4 * 1024 * 1024,
        });
      } catch (error) {
        errors.push(error);
        const attempt = { number, ...failureOutput(error), error };
        evidence.attempts.push(attempt);
        try {
          await publish(attempt);
        } catch (reporting) {
          primary = error;
          throw reporting;
        }
        remaining();
        if (number === 3 || !transientDownload(error)) throw error;
        continue;
      }
      const attempt = { number, ...output };
      evidence.attempts.push(attempt);
      if (!write) await store(evidence, attempt);
      remaining();
      if (write) await publish(attempt);
      else
        await report(
          evidence.files.at(-1) ?? { stdout: "", stderr: "" },
          evidence,
        );
      remaining();
      if (evidence.directory) {
        await rm(evidence.directory, { recursive: true, force: true });
        evidence.directory = undefined;
        evidence.files = [];
        remaining();
      }
      return { attempts: evidence.attempts };
    }
  } catch (error) {
    if (!errors.includes(error)) errors.push(error);
    failed(errors, primary ?? error);
  }
  throw new Error("Tool installation did not settle");
}
/** @param {string} target @param {InstallOptions} [options] @param {InstallDependencies} [dependencies] */
export async function installGoTool(target, options = {}, dependencies = {}) {
  /** @type {Evidence} */ const evidence = {
    env: options.env ?? process.env,
    signal: options.signal,
    attempts: [],
    files: [],
  };
  return perform(target, options, dependencies, evidence);
}
/** Bounded CLI graph omits native payloads; complete attempt output stays private. */
/** @param {unknown} error */
function graph(error) {
  const result = hostFailureEvidence(error);
  for (const node of result.nodes)
    node.message = node.message
      .replace(/https?:\/\/\S+/g, "[redacted URL]")
      .replace(/\b(token|password|secret|key)=\S+/gi, "$1=[redacted]");
  return result;
}
/** @param {string} target @param {InstallOptions} [options] @param {InstallDependencies} [dependencies] */
export async function runGoToolCLI(target, options = {}, dependencies = {}) {
  /** @type {Evidence} */ const evidence = {
    env: options.env ?? process.env,
    signal: options.signal,
    attempts: [],
    files: [],
  };
  try {
    await perform(target, options, dependencies, evidence);
    return { code: 0 };
  } catch (original) {
    let error = original;
    try {
      const root = await directory(evidence);
      for (const attempt of evidence.attempts)
        if (!evidence.files.some((files) => files.number === attempt.number))
          await store(evidence, attempt);
      const failure = join(root, "failure.json");
      const record = () =>
        JSON.stringify({
          schemaVersion: 1,
          target,
          graph: graph(error),
          attemptOutputs: evidence.files,
        });
      await writeFile(failure, record() + "\n", { mode: 0o600 });
      if (evidence.remaining && !evidence.signal?.aborted) {
        try {
          evidence.remaining();
          const stdout = join(root, "failure.stdout.log"),
            stderr = join(root, "failure.stderr.log");
          const written = await Promise.allSettled([
            writeFile(stdout, "", { mode: 0o600 }),
            writeFile(stderr, "SALTBOX_GO_TOOL_FAILURE " + record() + "\n", {
              mode: 0o600,
            }),
          ]);
          const failures = written.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
          if (failures.length) failed(failures);
          await report({ stdout, stderr }, evidence);
        } catch (reporting) {
          error = new AggregateError(
            [error, reporting],
            "Go tool failure reporting failed",
            { cause: original },
          );
          await writeFile(failure, record() + "\n", { mode: 0o600 });
        }
      }
      return { code: 1, error, evidenceDirectory: root };
    } catch (recording) {
      return {
        code: 1,
        error: new AggregateError(
          [error, recording],
          "Go tool failure evidence could not be retained",
          { cause: original },
        ),
      };
    }
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error("SIGINT"));
  const terminate = () => cancellation.abort(new Error("SIGTERM"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const result = await runGoToolCLI(
      process.argv.length === 3 ? process.argv[2] : "",
      { signal: cancellation.signal },
    );
    process.exitCode = result.code;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
