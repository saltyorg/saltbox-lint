import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import { SnapshotIndex } from "../../src/protocol.ts";

const textLimit = 1024 * 1024;
const captureLimit = 256 * 1024;
const outputLimit = 16 * 1024;
const locationLimit = 32;
const prefix = "SALTBOX_DIRTY_REFERENCE_FAILURE ";

interface Document {
  uri: { toString(): string };
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  languageId?: string;
  positionAt?(offset: number): { line: number; character: number };
  offsetAt?(position: { line: number; character: number }): number;
  getText(): string;
}
interface Inputs {
  childProcess: object;
  document: Document;
  documents: () => readonly Document[];
  retainedDocuments?: () => readonly Document[];
  tabURIs: () => readonly string[];
  aliases: readonly { path: string; uri: string }[];
  root: string;
  owner: string;
  ownerPath: string;
  source: string;
  position: { line: number; character: number };
  baseline: Uint8Array;
  cli: { spellings: readonly string[]; identityEqual: boolean | undefined };
  platform?: NodeJS.Platform;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function count(value: number) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function safe(operation: () => void) {
  try {
    operation();
  } catch {
    // Observation must never change the original request or assertion.
  }
}
function digest(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function captureText(document: Document) {
  // Real TextDocuments can reject an oversized model before getting its text.
  if (
    document.positionAt &&
    document.offsetAt &&
    document.offsetAt(document.positionAt(textLimit + 1)) > textLimit
  )
    return undefined;
  const text = document.getText();
  if (text.length > textLimit || Buffer.byteLength(text) > textLimit)
    return undefined;
  return text;
}

/** One original public request, with no access to private product state. */
export function observeDirtyReference(inputs: Inputs) {
  const aliases = inputs.aliases.slice(0, 4);
  const restorations: (() => void)[] = [];
  const spelling = (value: string) =>
    (inputs.platform ?? process.platform) === "win32"
      ? win32.normalize(value.replace(/^\\\\\?\\/u, "")).toLowerCase()
      : value;
  const cliSpellings = new Set(inputs.cli.spellings.map(spelling));
  let disposed = false;
  let pending = false;
  let requested = false;
  let stage = "request_not_observed";
  let text: string | undefined;
  let sourceHash: string | undefined;
  let baselineHash: string | undefined;
  let index: SnapshotIndex | undefined;
  let offset: number | undefined;
  let entry: unknown;
  let settlement: unknown;
  let results: unknown;
  let candidates = 0;
  let matches = 0;
  let spawnInstalled = false;
  let failureWritten = false;
  let primaryCapture = "unavailable";
  let child:
    | {
        rootMatches: boolean;
        ownerMatches: boolean;
        sourceMatches: boolean;
        offsetMatches: boolean;
        cliSpellingMatches: boolean;
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

  function restore() {
    pending = false;
    for (const operation of restorations.reverse()) safe(operation);
    restorations.length = 0;
  }
  function wrap(
    target: object,
    key: string,
    replace: (original: (...args: unknown[]) => unknown) => unknown,
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const original: unknown = Reflect.get(target, key);
    if (typeof original !== "function") return false;
    const value = replace(original as (...args: unknown[]) => unknown);
    Object.defineProperty(target, key, {
      ...(descriptor ?? { configurable: true, writable: true }),
      value,
    });
    restorations.push(() => {
      if (Reflect.get(target, key) !== value) return;
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
    return true;
  }
  function emitter(target: object, observe: (args: unknown[]) => void) {
    wrap(
      target,
      "emit",
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          if (pending && !disposed) safe(() => observe(args));
          return Reflect.apply(original, this, args) as unknown;
        },
    );
  }
  function publicFacts() {
    const documents = inputs.documents();
    const retainedDocuments = [
      inputs.document,
      ...(inputs.retainedDocuments?.() ?? []),
    ];
    const tabs = inputs.tabURIs();
    let tabCount = 0;
    const knownTabs: string[] = [];
    for (const uri of tabs) {
      const alias = aliases.find((alias) => alias.uri === uri);
      if (!alias) continue;
      tabCount = count(tabCount + 1);
      if (knownTabs.length < 16) knownTabs.push(alias.path);
    }
    return {
      ownership: "fixture_declared_not_independently_observed",
      aliasesTruncated: inputs.aliases.length > aliases.length,
      tabs: { count: tabCount, truncated: tabCount > 16, paths: knownTabs },
      documents: aliases.map((alias) => {
        const matching = documents.filter(
          (document) => document.uri.toString() === alias.uri,
        );
        const retained = retainedDocuments.find(
          (document) => document.uri.toString() === alias.uri,
        );
        const document = matching[0] ?? retained;
        if (!document)
          return { path: alias.path, uri: alias.uri, available: false };
        const result = {
          path: alias.path,
          uri: alias.uri,
          available: true,
          workspacePresent: matching.length > 0,
          instanceOrigin:
            matching.length > 0
              ? "current_workspace_model"
              : "retained_original_sequence_instance_replacement_state_unavailable",
          duplicateURIs: matching.length > 1,
          version: integer(document.version),
          dirty: document.isDirty,
          closed: document.isClosed,
          languageAvailable: typeof document.languageId === "string",
        };
        try {
          const captured = captureText(document);
          const bytes =
            captured !== undefined ? Buffer.byteLength(captured) : undefined;
          const available = captured !== undefined;
          return {
            ...result,
            bytes,
            capture: available ? "available" : "unavailable_above_one_mib",
            hashEqualsPrimary:
              available && captured !== undefined && sourceHash !== undefined
                ? digest(captured) === sourceHash
                : undefined,
            hashEqualsLastReadBaseline:
              available && captured !== undefined && baselineHash !== undefined
                ? digest(captured) === baselineHash
                : undefined,
            bytesEqualPrimary:
              available && text !== undefined ? captured === text : undefined,
            bytesEqualLastReadBaseline:
              available &&
              captured !== undefined &&
              inputs.baseline.byteLength <= textLimit
                ? Buffer.from(captured).equals(inputs.baseline)
                : undefined,
          };
        } catch {
          return { ...result, capture: "unavailable" };
        }
      }),
    };
  }
  function capturePublic() {
    let facts: unknown = { state: "public_observation_unavailable" };
    safe(() => {
      facts = publicFacts();
    });
    return facts;
  }
  function resultFacts(value: unknown) {
    if (!Array.isArray(value)) return { available: false };
    return {
      available: true,
      count: count(value.length),
      truncated: value.length > locationLimit,
      locations: value.slice(0, locationLimit).map((item: unknown) => {
        const location = object(item);
        const uri = object(location?.uri);
        let candidate: unknown;
        safe(() => {
          const method: unknown = uri?.toString;
          if (typeof method === "function")
            candidate = Reflect.apply(method, uri, []);
        });
        const alias = aliases.find((alias) => alias.uri === candidate);
        const range = object(location?.range);
        const start = object(range?.start),
          end = object(range?.end);
        const mapped = {
          start: {
            line: integer(start?.line),
            character: integer(start?.character),
          },
          end: { line: integer(end?.line), character: integer(end?.character) },
        };
        let coordinatesValid: boolean | undefined;
        if (alias?.uri === inputs.document.uri.toString() && index) {
          coordinatesValid = false;
          safe(() => {
            const first = index!.byteOffset(
              mapped.start as { line: number; character: number },
            );
            const last = index!.byteOffset(
              mapped.end as { line: number; character: number },
            );
            coordinatesValid = first <= last;
          });
        }
        return {
          path: alias?.path,
          uri: alias?.uri,
          uriAvailable: typeof candidate === "string",
          primaryURI: candidate === inputs.document.uri.toString(),
          range: mapped,
          coordinatesValid,
        };
      }),
    };
  }
  function responseFacts() {
    if (!child?.closed) return { stage: "response_close_not_observed" };
    if (child.truncated) return { stage: "response_capture_truncated" };
    let value: Record<string, unknown> | undefined;
    try {
      value = object(
        JSON.parse(
          new TextDecoder("utf8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        ),
      );
    } catch {
      return { stage: "response_invalid" };
    }
    if (!value) return { stage: "response_not_object" };
    const dependencies = object(value.dependencies);
    const sources = dependencies?.sources;
    const source = Array.isArray(sources) ? object(sources[0]) : undefined;
    const targets = object(value.target_hashes);
    const length = (value: unknown) =>
      Array.isArray(value) ? count(value.length) : undefined;
    const primary = [
      value.origin,
      ...(Array.isArray(value.locations)
        ? value.locations.slice(0, locationLimit)
        : []),
    ]
      .filter(
        (location: unknown) =>
          object(location)?.path === inputs.ownerPath ||
          object(location)?.path ===
            aliases.find(
              (alias) => alias.uri === inputs.document.uri.toString(),
            )?.path,
      )
      .slice(0, locationLimit);
    return {
      stage: "response_json_object",
      schemaRecognized: value.schema_version === 1,
      operationMatches: value.operation === "references",
      rootMatches: value.root === inputs.root,
      ownerMatches: value.path === inputs.ownerPath,
      sourceHashMatches:
        sourceHash !== undefined && value.source_sha256 === sourceHash,
      offsetMatches: offset !== undefined && value.offset === offset,
      dependencyRootMatches: dependencies?.root === inputs.root,
      dependencySourceHashMatches:
        sourceHash !== undefined && source?.source_sha256 === sourceHash,
      locations: length(value.locations),
      declarations: length(value.declarations),
      dependencySources: length(sources),
      dependencyFiles: length(source?.files),
      targetHashes: targets ? count(Object.keys(targets).length) : undefined,
      primaryLocationsTruncated:
        Array.isArray(value.locations) &&
        value.locations.length > locationLimit,
      primaryLocations: primary.map((location: unknown) => {
        const item = object(location),
          span = object(item?.span);
        let valid = false;
        let mapped: unknown;
        safe(() => {
          if (
            !index ||
            text === undefined ||
            integer(span?.start) === undefined ||
            integer(span?.end) === undefined
          )
            return;
          mapped = index.span(span as { start: number; end: number });
          const position = index.position({
            line: item!.line as number,
            column: item!.column as number,
          });
          const start = object(object(mapped)?.start);
          valid =
            start?.line === position.line &&
            start?.character === position.character &&
            Buffer.from(text)
              .subarray(span!.start as number, span!.end as number)
              .toString("utf8") === item!.text;
        });
        return {
          owner: item?.path === inputs.ownerPath,
          span: { start: integer(span?.start), end: integer(span?.end) },
          range: mapped,
          capturedCoordinatesAndTextMatch: valid,
        };
      }),
    };
  }
  function installSpawn() {
    spawnInstalled = wrap(
      inputs.childProcess,
      "spawn",
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          let observe = false;
          safe(() => {
            if (
              !pending ||
              disposed ||
              typeof args[0] !== "string" ||
              !cliSpellings.has(spelling(args[0])) ||
              !Array.isArray(args[1])
            )
              return;
            const argv: unknown[] = args[1];
            const flag = (name: string) => {
              const at = argv.indexOf(name);
              return at >= 0 ? argv[at + 1] : undefined;
            };
            if (argv[0] !== "query" || flag("--operation") !== "references")
              return;
            candidates = count(candidates + 1);
            const facts = {
              rootMatches: flag("--root") === inputs.root,
              ownerMatches: flag("--stdin-filename") === inputs.owner,
              sourceMatches: flag("--stdin-source-filename") === inputs.source,
              offsetMatches:
                offset !== undefined && flag("--offset") === String(offset),
              cliSpellingMatches: true,
            };
            if (!Object.values(facts).every(Boolean)) return;
            matches = count(matches + 1);
            if (child) return;
            child = {
              ...facts,
              spawnThrew: false,
              spawned: false,
              exited: false,
              closed: false,
              error: false,
              stdoutBytes: 0,
              stderrBytes: 0,
              truncated: false,
            };
            observe = true;
          });
          let result: unknown;
          try {
            result = Reflect.apply(original, this, args) as unknown;
          } catch (error) {
            if (observe && child) child.spawnThrew = true;
            throw error;
          }
          safe(() => {
            if (!observe) return;
            const process = result as ChildProcess;
            emitter(process, ([event, code, signal]) => {
              if (!child) return;
              if (event === "spawn") child.spawned = true;
              if (event === "error") child.error = true;
              if (event === "exit" || event === "close") {
                if (event === "exit") child.exited = true;
                else child.closed = true;
                if (code === null || integer(code) !== undefined)
                  child.exitCode = code as number | null;
                child.signalled = typeof signal === "string";
              }
            });
            if (process.stdout)
              emitter(process.stdout, ([event, data]) => {
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
              emitter(process.stderr, ([event, data]) => {
                if (child && event === "data" && data instanceof Uint8Array)
                  child.stderrBytes = count(
                    child.stderrBytes + data.byteLength,
                  );
              });
          });
          return result;
        },
    );
  }
  function request<T>(operation: () => T): T {
    if (requested || disposed) return operation();
    requested = true;
    pending = true;
    stage = "request_entered";
    safe(() => {
      if (inputs.baseline.byteLength <= textLimit)
        baselineHash = digest(inputs.baseline);
      const captured = captureText(inputs.document);
      if (captured === undefined) {
        primaryCapture = "unavailable_above_one_mib";
        return;
      }
      text = captured;
      primaryCapture = "available";
      sourceHash = digest(text);
      index = new SnapshotIndex(text);
      offset = index.byteOffset(inputs.position);
    });
    entry = capturePublic();
    safe(installSpawn);
    let result: T;
    try {
      result = operation();
    } catch (error) {
      stage = "command_threw";
      settlement = capturePublic();
      restore();
      throw error;
    }
    safe(() => {
      const settle = (value: unknown, rejected: boolean) => {
        if (disposed) return;
        stage = rejected ? "command_rejected" : "command_fulfilled";
        safe(() => {
          results = resultFacts(value);
        });
        settlement = capturePublic();
        restore();
      };
      const then: unknown =
        result != null ? Reflect.get(Object(result), "then") : undefined;
      if (typeof then === "function")
        Reflect.apply(then, result, [
          (value: unknown) => safe(() => settle(value, false)),
          () => safe(() => settle(undefined, true)),
        ]);
      else settle(result, false);
    });
    return result;
  }
  function snapshot() {
    return {
      schemaVersion: 1,
      boundary: "single_original_public_reference_request",
      association:
        matches > 1
          ? "ambiguous_matching_native_candidates"
          : "known_cli_arguments_during_pending_public_attempt_no_provider_registration_observation",
      cancellation: "provider_token_unavailable",
      baseline: "last_iteration_start_disk_read_not_request_time_observation",
      stage,
      primaryCapture,
      cliIdentityEqualAtPreflight: inputs.cli.identityEqual,
      spawnInstalled,
      candidates,
      matches,
      entry,
      settlement,
      results,
      child,
      response: responseFacts(),
    };
  }
  function failure(write: (message: string) => void = console.error) {
    restore();
    if (failureWritten) return;
    failureWritten = true;
    safe(() => {
      const value = JSON.stringify(snapshot());
      write(
        prefix +
          (Buffer.byteLength(prefix + value) <= outputLimit
            ? value
            : '{"stage":"observation_output_truncated"}'),
      );
    });
  }
  function dispose() {
    restore();
    disposed = true;
    chunks = [];
    text = undefined;
    index = undefined;
    sourceHash = undefined;
    baselineHash = undefined;
  }
  return { request, snapshot, failure, dispose };
}
