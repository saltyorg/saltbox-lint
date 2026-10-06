import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import { observeCLIErrorStage } from "./cli-error-stage.ts";

const captureLimit = 256 * 1024;
const outputLimit = 16 * 1024;
const countLimit = Number.MAX_SAFE_INTEGER;
const prefix = "SALTBOX_FIRST_DEFINITION_FAILURE ";

interface Document {
  uri: { fsPath: string; toString(): string };
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  getText(): string;
  offsetAt(position: { line: number; character: number }): number;
}
interface Inputs {
  commands: object;
  childProcess: object;
  document: Document;
  position: { line: number; character: number };
  root: string;
  source: string;
  cliPath: string;
  cliCanonicalPath?: string;
  cliProductPath?: string;
  cliHash: string;
  productActive: boolean;
  platform?: NodeJS.Platform;
}

function count(value: number): number {
  return Math.min(countLimit, Math.max(0, value));
}
function digest(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : undefined;
}
function path(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\u0000-\u001f]/u.test(value)
    ? value
    : undefined;
}
function pathAvailability(value: unknown) {
  return path(value) === undefined ? "path_unavailable" : "path_available";
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function length(value: unknown): number | undefined {
  return Array.isArray(value) ? count(value.length) : undefined;
}
function safe(operation: () => void): void {
  try {
    operation();
  } catch {
    // Observation never changes the original command, event or spawn outcome.
  }
}

/** Observe public calls and native events; never request or change product work. */
export function observeFirstDefinition(inputs: Inputs) {
  const executableSpelling = (value: string) =>
    (inputs.platform ?? process.platform) === "win32"
      ? win32.normalize(value.replace(/^\\\\\?\\/u, "")).toLowerCase()
      : value;
  const cliSpellings = new Set(
    [inputs.cliPath, inputs.cliCanonicalPath, inputs.cliProductPath]
      .filter((value): value is string => path(value) !== undefined)
      .map(executableSpelling),
  );
  const restorations: (() => void)[] = [];
  let disposed = false;
  let pendingAttempt: number | undefined;
  let calls = 0;
  let candidates = 0;
  let matches = 0;
  let firstResultCount: number | undefined;
  let lastResultCount: number | undefined;
  let version: number | undefined;
  let sha256: string | undefined;
  let offset: number | undefined;
  let firstDocument: ReturnType<typeof documentFacts> | undefined;
  let settledDocument: ReturnType<typeof documentFacts> | undefined;
  let commandStage = "request_not_observed";
  let child:
    | {
        rootMatches: boolean;
        rootAvailability: ReturnType<typeof pathAvailability>;
        publicAttempt: number;
        sourceMatches: boolean;
        sourceAvailability: ReturnType<typeof pathAvailability>;
        offsetMatches: boolean;
        cliRawPathMatches: boolean;
        cliPathAvailability: ReturnType<typeof pathAvailability>;
        spawnThrew: boolean;
        spawned: boolean;
        exited: boolean;
        closed: boolean;
        error: boolean;
        exitCode?: number | null;
        signalled?: boolean;
        stdoutBytes: number;
        stderrBytes: number;
        truncated: boolean;
      }
    | undefined;
  let chunks: Buffer[] = [];
  let retained = 0;
  let installedCommand = false;
  let installedSpawn = false;
  const errorStage = observeCLIErrorStage();

  function documentFacts() {
    return {
      versionMatches: version === inputs.document.version,
      dirty: inputs.document.isDirty,
      closed: inputs.document.isClosed,
    };
  }
  function wrap(
    target: object,
    key: string,
    replacement: (original: (...args: unknown[]) => unknown) => unknown,
  ): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const original: unknown = Reflect.get(target, key);
    if (typeof original !== "function") return false;
    const value = replacement(original as (...args: unknown[]) => unknown);
    Object.defineProperty(target, key, {
      ...(descriptor ?? { configurable: true, writable: true }),
      value,
    });
    restorations.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
    return true;
  }

  function observeEmitter(emitter: object, observe: (args: unknown[]) => void) {
    wrap(
      emitter,
      "emit",
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          if (!disposed) safe(() => observe(args));
          return Reflect.apply(original, this, args) as unknown;
        },
    );
  }

  safe(() => {
    installedCommand = wrap(
      inputs.commands,
      "executeCommand",
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          let first = false;
          let observed = false;
          let attempt: number | undefined;
          safe(() => {
            const position = record(args[2]);
            if (
              disposed ||
              args[0] !== "vscode.executeDefinitionProvider" ||
              args[1] !== inputs.document.uri ||
              position?.line !== inputs.position.line ||
              position.character !== inputs.position.character
            )
              return;
            calls = count(calls + 1);
            observed = true;
            attempt = calls;
            pendingAttempt = attempt;
            first = calls === 1;
            if (first) {
              version = inputs.document.version;
              const text = inputs.document.getText();
              sha256 = createHash("sha256").update(text).digest("hex");
              offset = Buffer.byteLength(
                text.slice(0, inputs.document.offsetAt(inputs.position)),
                "utf8",
              );
              firstDocument = documentFacts();
              commandStage = "request_entered";
            }
          });
          let result: unknown;
          try {
            result = Reflect.apply(original, this, args) as unknown;
          } catch (error) {
            if (first && !disposed) {
              commandStage = "command_threw";
            }
            if (pendingAttempt === attempt) pendingAttempt = undefined;
            throw error;
          }
          if (!disposed && observed)
            safe(() => {
              const settle = (value: unknown, rejected: boolean) => {
                if (disposed) return;
                if (pendingAttempt === attempt) pendingAttempt = undefined;
                if (!rejected) lastResultCount = length(value);
                if (first) {
                  firstResultCount = rejected ? undefined : length(value);
                  settledDocument = documentFacts();
                  commandStage = rejected
                    ? "command_rejected"
                    : "command_fulfilled";
                }
              };
              const then: unknown =
                result != null
                  ? Reflect.get(Object(result), "then")
                  : undefined;
              if (typeof then === "function") {
                // Observe the original thenable, returning it unchanged. Both
                // callbacks contain their own errors and return no rejected work.
                Reflect.apply(then, result, [
                  (value: unknown) => safe(() => settle(value, false)),
                  () => safe(() => settle(undefined, true)),
                ]);
              } else settle(result, false);
            });
          return result;
        },
    );
  });
  safe(() => {
    installedSpawn = wrap(
      inputs.childProcess,
      "spawn",
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          let observeChild = false;
          safe(() => {
            if (
              disposed ||
              pendingAttempt === undefined ||
              typeof args[0] !== "string" ||
              !cliSpellings.has(executableSpelling(args[0])) ||
              !Array.isArray(args[1])
            )
              return;
            const argv: unknown[] = args[1];
            const flag = (name: string) => argv[argv.indexOf(name) + 1];
            if (argv[0] !== "query" || flag("--operation") !== "definition")
              return;
            const rootMatches = flag("--root") === inputs.root;
            const sourceMatches = flag("--stdin-filename") === inputs.source;
            const offsetMatches = flag("--offset") === String(offset);
            candidates = count(candidates + 1);
            if (rootMatches && sourceMatches && offsetMatches)
              matches = count(matches + 1);
            if (child) return;
            child = {
              rootMatches,
              rootAvailability: pathAvailability(flag("--root")),
              publicAttempt: pendingAttempt,
              sourceMatches,
              sourceAvailability: pathAvailability(flag("--stdin-filename")),
              offsetMatches,
              cliRawPathMatches: args[0] === inputs.cliPath,
              cliPathAvailability: pathAvailability(args[0]),
              spawnThrew: false,
              spawned: false,
              exited: false,
              closed: false,
              error: false,
              stdoutBytes: 0,
              stderrBytes: 0,
              truncated: false,
            };
            observeChild = true;
          });
          let result: unknown;
          try {
            result = Reflect.apply(original, this, args) as unknown;
          } catch (error) {
            if (observeChild && child) child.spawnThrew = true;
            throw error;
          }
          safe(() => {
            if (!observeChild) return;
            const process = result as ChildProcess;
            observeEmitter(process, ([event, code, signal]) => {
              if (!child) return;
              if (event === "spawn") child.spawned = true;
              if (event === "error") child.error = true;
              if (event === "exit" || event === "close") {
                if (event === "exit") child.exited = true;
                else child.closed = true;
                if (
                  code === null ||
                  (typeof code === "number" &&
                    Number.isSafeInteger(code) &&
                    code >= 0 &&
                    code <= 0xffffffff)
                )
                  child.exitCode = code;
                child.signalled = typeof signal === "string";
              }
            });
            if (process.stdout)
              observeEmitter(process.stdout, ([event, data]) => {
                if (!child || event !== "data" || !(data instanceof Uint8Array))
                  return;
                child.stdoutBytes = count(child.stdoutBytes + data.byteLength);
                if (retained + data.byteLength > captureLimit) {
                  child.truncated = true;
                  chunks = [];
                  retained = 0;
                } else if (!child.truncated) {
                  chunks.push(Buffer.from(data));
                  retained += data.byteLength;
                }
              });
            if (process.stderr)
              observeEmitter(process.stderr, ([event, data]) => {
                if (child && event === "data") errorStage.observe(data);
                if (child && event === "data" && data instanceof Uint8Array)
                  child.stderrBytes = count(
                    child.stderrBytes + data.byteLength,
                  );
              });
          });
          return result;
        },
    );
  });

  function responseFacts() {
    if (!child?.closed) return { stage: "response_close_not_observed" };
    if (child.truncated) return { stage: "response_capture_truncated" };
    let text: string;
    try {
      text = new TextDecoder("utf8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      return { stage: "response_utf8_invalid" };
    }
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(text));
    } catch {
      return { stage: "response_json_invalid" };
    }
    if (!value) return { stage: "response_json_not_object" };
    const dependencies = record(value.dependencies);
    const sources = dependencies?.sources;
    const firstSource = Array.isArray(sources) ? record(sources[0]) : undefined;
    const hashes = record(value.target_hashes);
    return {
      stage: "response_json_object",
      schemaRecognized: value.schema_version === 1,
      definitionOperation: value.operation === "definition",
      state:
        ["none", "resolved", "ambiguous", "dynamic", "unavailable"].find(
          (state) => state === value.state,
        ) ?? "unrecognized",
      rootMatches: value.root === inputs.root,
      rootAvailability: pathAvailability(value.root),
      pathMatches:
        value.path ===
        inputs.source.slice(inputs.root.length + 1).replaceAll("\\", "/"),
      pathAvailability: pathAvailability(value.path),
      hashMatches:
        digest(value.source_sha256) !== undefined &&
        value.source_sha256 === sha256,
      offsetMatches: value.offset === offset,
      locations: length(value.locations),
      declarations: length(value.declarations),
      completions: length(value.completions),
      targetHashes: hashes ? count(Object.keys(hashes).length) : undefined,
      dependencySources: length(sources),
      dependencyFiles: length(firstSource?.files),
      dependencyRootMatches: dependencies?.root === inputs.root,
      dependencyRootAvailability: pathAvailability(dependencies?.root),
      dependencyHashMatches: firstSource?.source_sha256 === sha256,
    };
  }
  function snapshot() {
    return {
      stage: "original_assertion_rejected",
      boundary: "public_command_without_provider_registration_observation",
      association:
        "preflight_cli_spellings_definition_operation_and_pending_original_public_attempt",
      executableComparison:
        "known_spellings_with_platform_normalization_no_request_window_filesystem_probe",
      cancellation: "provider_token_unavailable",
      productActive: inputs.productActive,
      commandObserverInstalled: installedCommand,
      spawnObserverInstalled: installedSpawn,
      root: path(inputs.root),
      rootAvailability: pathAvailability(inputs.root),
      source: path(inputs.source),
      sourceAvailability: pathAvailability(inputs.source),
      sourceHash: sha256,
      offset,
      cliPath: path(inputs.cliPath),
      cliPathAvailability: pathAvailability(inputs.cliPath),
      cliHash: digest(inputs.cliHash),
      calls,
      candidates,
      matches,
      countsSaturated: [
        calls,
        candidates,
        matches,
        child?.stdoutBytes,
        child?.stderrBytes,
      ].includes(countLimit),
      commandStage,
      firstResultCount,
      lastResultCount,
      firstDocument,
      settledDocument,
      failureDocument: documentFacts(),
      child: child && {
        ...child,
        errorStage: errorStage.stage(child.closed, child.exitCode),
      },
      response: responseFacts(),
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    pendingAttempt = undefined;
    for (const restore of restorations.reverse()) safe(restore);
    restorations.length = 0;
    chunks = [];
    retained = 0;
    errorStage.dispose();
  }
  return { snapshot, dispose };
}

/** Restore observation before emitting failure facts or rethrowing the error. */
export async function withFirstDefinitionObservation<T>(
  observer: ReturnType<typeof observeFirstDefinition>,
  operation: () => Promise<T>,
  write: (message: string) => void = console.error,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    let evidence: unknown = { stage: "observation_unavailable" };
    safe(() => {
      evidence = observer.snapshot();
    });
    observer.dispose();
    safe(() => {
      const text = JSON.stringify(evidence);
      write(
        prefix +
          (Buffer.byteLength(prefix + text, "utf8") <= outputLimit
            ? text
            : '{"stage":"observation_output_truncated"}'),
      );
    });
    throw error;
  } finally {
    observer.dispose();
  }
}
