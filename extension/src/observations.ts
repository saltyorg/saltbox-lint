import { lstat, readFile, stat, realpath } from "node:fs/promises";
import {
  identify,
  identifyNow,
  templatePath,
  unavailableSource,
  type Identity,
} from "./identity.ts";
import { lstatSync, statSync, realpathSync, type BigIntStats } from "node:fs";
import * as path from "node:path";
import {
  hash,
  sourcePath,
  type AnalysisRecord,
  type DependencyFile,
} from "./protocol.ts";

export function fileFingerprint(value: BigIntStats): string {
  return [
    value.dev,
    value.ino,
    value.mode,
    value.size,
    value.mtimeNs,
    value.ctimeNs,
  ].join(":");
}

// Verify read bytes and marker type against the report before accepting it.
// Stable identities let watcher echoes arriving after acceptance coalesce.
// Buffer hashes remain separate from disk fingerprints. Disk echoes may
// coalesce, but saved bytes never replace the primary overlay observation.
export function observationFingerprint(
  value: BigIntStats,
  target?: BigIntStats,
): string {
  return `${fileFingerprint(value)}${target ? ":" + fileFingerprint(target) : ""}`;
}
export function contentFingerprint(
  value: BigIntStats,
  bytes: Uint8Array,
  target?: BigIntStats,
): string {
  return `${observationFingerprint(value, target)}:${hash(bytes)}`;
}

export interface TemplateOverlay {
  path: string;
  filename: string;
  sourceFilename: string;
  sha256: string;
}

// Source observations pin the lexical entry, its canonical owner and root.
// Query aliases additionally require that owner in the admitted source set.
export interface ObservedSource {
  filename: string;
  fingerprint: string;
  rootFingerprint: string;
  logical?: LogicalSource;
}

// A never-created YAML leaf has no disk fingerprint. Retain its original
// spelling, canonical parent chain and absence instead of treating ENOENT as
// permission to accept any missing source. Physical owners never use this path.
export interface LogicalSource extends Identity {
  sourceFilename: string;
  rootFingerprint: string;
  parents: { filename: string; canonical: string; fingerprint: string }[];
}
interface SourceOrigin extends Identity {
  sourceFilename: string;
  logical?: LogicalSource;
}
async function absent(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
export async function observeLogicalSource(
  identity: Identity,
  sourceFilename: string,
): Promise<LogicalSource | undefined> {
  if (
    templatePath(sourceFilename) ||
    templatePath(identity.filename) ||
    templatePath(identity.path) ||
    !/\.ya?ml$/i.test(sourceFilename) ||
    identity.path.split("/").includes(".git") ||
    path.resolve(sourceFilename).split(path.sep).includes(".git") ||
    (await realpath(identity.root)) !== identity.root ||
    !(await absent(sourceFilename)) ||
    !(await absent(identity.filename))
  )
    return;
  const observation: LogicalSource = {
    ...identity,
    sourceFilename,
    rootFingerprint: fileFingerprint(
      await lstat(identity.root, { bigint: true }),
    ),
    parents: [],
  };
  const seen = new Set<string>();
  for (const origin of [sourceFilename, identity.filename]) {
    let filename = path.dirname(origin);
    while (!seen.has(filename)) {
      seen.add(filename);
      const canonical = await realpath(filename);
      const relative = path
        .relative(identity.root, canonical)
        .split(path.sep)
        .join("/");
      if (relative) {
        sourcePath(relative);
        if (relative.split("/").includes(".git")) return;
      }
      const entry = await lstat(filename, { bigint: true });
      const target = entry.isSymbolicLink()
        ? await stat(filename, { bigint: true })
        : undefined;
      if (!(target ?? entry).isDirectory()) return;
      observation.parents.push({
        filename,
        canonical,
        fingerprint: observationFingerprint(entry, target),
      });
      if (canonical === identity.root) break;
      filename = path.dirname(filename);
    }
  }
  return (await logicalSourceCurrent(observation)) ? observation : undefined;
}
// The final query fence must use the same authority policy without yielding.
// Paired reads keep logical/physical identity rules shared between both modes.
interface AuthorityRead {
  asynchronous: () => Promise<unknown>;
  immediate: () => unknown;
}
function* authorityRead<T>(
  asynchronous: () => Promise<T>,
  immediate: () => T,
): Generator<AuthorityRead, T, unknown> {
  return (yield { asynchronous, immediate }) as T;
}
function identityRead(root: string, filename: string) {
  return authorityRead(
    () => identify(root, filename),
    () => identifyNow(root, filename),
  );
}
function canonicalRead(filename: string) {
  return authorityRead(
    () => realpath(filename),
    () => realpathSync(filename),
  );
}
function entryRead(filename: string) {
  return authorityRead(
    () => lstat(filename, { bigint: true }),
    () => lstatSync(filename, { bigint: true }),
  );
}
function targetRead(filename: string) {
  return authorityRead(
    () => stat(filename, { bigint: true }),
    () => statSync(filename, { bigint: true }),
  );
}
function* absenceRead(
  filename: string,
): Generator<AuthorityRead, boolean, unknown> {
  try {
    yield* entryRead(filename);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
async function authorityCurrent(
  checks: Generator<AuthorityRead, boolean, unknown>,
): Promise<boolean> {
  let step = checks.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = await step.value.asynchronous();
    } catch (error) {
      step = checks.throw(error);
      continue;
    }
    step = checks.next(value);
  }
  return step.value;
}
function authorityCurrentNow(
  checks: Generator<AuthorityRead, boolean, unknown>,
): boolean {
  let step = checks.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = step.value.immediate();
    } catch (error) {
      step = checks.throw(error);
      continue;
    }
    step = checks.next(value);
  }
  return step.value;
}
export function logicalSourceCurrent(
  observation: LogicalSource,
): Promise<boolean> {
  return authorityCurrent(logicalSourceChecks(observation));
}
export function logicalSourceCurrentNow(observation: LogicalSource): boolean {
  return authorityCurrentNow(logicalSourceChecks(observation));
}
// The original URI may be absent from every reported dependency and target.
// Retain its captured owner separately from the current public buffer list.
export function sourceOriginCurrent(origin: SourceOrigin): Promise<boolean> {
  return authorityCurrent(sourceOriginChecks(origin));
}
export function sourceOriginCurrentNow(origin: SourceOrigin): boolean {
  return authorityCurrentNow(sourceOriginChecks(origin));
}
function* sourceOriginChecks(
  origin: SourceOrigin,
): Generator<AuthorityRead, boolean, unknown> {
  try {
    const identity = yield* identityRead(origin.root, origin.sourceFilename);
    if (identity.filename !== origin.filename || identity.path !== origin.path)
      return false;
    return origin.logical
      ? yield* logicalSourceChecks(origin.logical)
      : (yield* canonicalRead(origin.sourceFilename)) === origin.filename;
  } catch (error) {
    if (unavailableSource(error)) return false;
    throw error;
  }
}
export function sourceCurrent(
  root: string,
  relative: string,
  observation: ObservedSource,
  digest: string,
): Promise<boolean> {
  return authorityCurrent(sourceChecks(root, relative, observation, digest));
}
export function sourceCurrentNow(
  root: string,
  relative: string,
  observation: ObservedSource,
  digest: string,
): boolean {
  return authorityCurrentNow(sourceChecks(root, relative, observation, digest));
}
function* logicalSourceChecks(
  observation: LogicalSource,
): Generator<AuthorityRead, boolean, unknown> {
  try {
    const identity = yield* identityRead(
      observation.root,
      observation.sourceFilename,
    );
    if (
      identity.filename !== observation.filename ||
      identity.path !== observation.path ||
      (yield* canonicalRead(observation.root)) !== observation.root ||
      fileFingerprint(yield* entryRead(observation.root)) !==
        observation.rootFingerprint
    )
      return false;
    for (const parent of observation.parents) {
      if ((yield* canonicalRead(parent.filename)) !== parent.canonical)
        return false;
      const entry = yield* entryRead(parent.filename);
      const target = entry.isSymbolicLink()
        ? yield* targetRead(parent.filename)
        : undefined;
      if (observationFingerprint(entry, target) !== parent.fingerprint)
        return false;
    }
    return (
      (yield* absenceRead(observation.sourceFilename)) &&
      (yield* absenceRead(observation.filename))
    );
  } catch (error) {
    if (unavailableSource(error)) return false;
    throw error;
  }
}
function* sourceChecks(
  root: string,
  relative: string,
  observation: ObservedSource,
  digest: string,
): Generator<AuthorityRead, boolean, unknown> {
  try {
    sourcePath(relative);
    if (observation.logical)
      return (
        observation.logical.root === root &&
        observation.logical.path === relative &&
        observation.logical.filename === observation.filename &&
        observation.logical.rootFingerprint === observation.rootFingerprint &&
        observation.fingerprint === "missing:" + digest &&
        (yield* logicalSourceChecks(observation.logical))
      );
    const filename = path.join(root, ...relative.split("/"));
    const identity = yield* identityRead(root, filename);
    if (
      identity.filename !== observation.filename ||
      relative.split("/").includes(".git") ||
      identity.path.split("/").includes(".git") ||
      (yield* canonicalRead(root)) !== root ||
      fileFingerprint(yield* entryRead(root)) !== observation.rootFingerprint
    )
      return false;
    const entry = yield* entryRead(filename);
    const target = entry.isSymbolicLink()
      ? yield* targetRead(filename)
      : undefined;
    return (
      observationFingerprint(entry, target) + ":" + digest ===
        observation.fingerprint &&
      (yield* canonicalRead(filename)) === observation.filename
    );
  } catch (error) {
    if (
      unavailableSource(error) ||
      (error instanceof Error &&
        error.message === "Invalid Saltbox Lint response")
    )
      return false;
    throw error;
  }
}

export async function observeAnalysis(
  record: AnalysisRecord,
  buffers: ReadonlySet<string> = new Set(),
  readSource: (filename: string) => Promise<Uint8Array> = readFile,
  templateOverlay?: TemplateOverlay,
  captureSources = false,
): Promise<{
  fingerprints: Map<string, string>;
  changed: Set<string>;
  overlayPaths: Set<string>;
  aliases: Map<string, ObservedSource>;
  targets: Map<string, ObservedSource>;
}> {
  const overlayPaths = new Set<string>();
  const aliases = new Map<string, ObservedSource>();
  const targets = new Map<string, ObservedSource>();
  const rootFingerprint = captureSources
    ? fileFingerprint(await lstat(record.root, { bigint: true }))
    : undefined;
  // The CLI substitutes one template snapshot into its admitted aliases.
  // Match ownership and the captured digest, never equal content alone.
  const overlayFiles = new Set<string>();
  let ownerFingerprint: string | undefined;
  const overlayOwner = async () => {
    if (!templateOverlay) return undefined;
    if (
      record.sources.length !== 1 ||
      record.sources[0].path !== templateOverlay.path ||
      record.sources[0].source_sha256 !== templateOverlay.sha256 ||
      path.join(record.root, ...templateOverlay.path.split("/")) !==
        templateOverlay.filename ||
      (await realpath(record.root)) !== record.root ||
      (await realpath(templateOverlay.filename)) !== templateOverlay.filename ||
      (await realpath(templateOverlay.sourceFilename)) !==
        templateOverlay.filename
    )
      throw new Error("Template overlay identity changed");
    const origin = await lstat(templateOverlay.sourceFilename, {
      bigint: true,
    });
    return [
      fileFingerprint(await lstat(record.root, { bigint: true })),
      fileFingerprint(await lstat(templateOverlay.filename, { bigint: true })),
      fileFingerprint(origin),
    ].join(":");
  };
  if (templateOverlay) {
    try {
      ownerFingerprint = await overlayOwner();
      for (const file of record.sources[0].files)
        if (file.state === "read") overlayFiles.add(file.path);
    } catch {
      return {
        fingerprints: new Map(),
        changed: new Set([templateOverlay.path]),
        overlayPaths,
        aliases,
        targets,
      };
    }
  }
  const observations = new Map<string, DependencyFile>();
  const sourceFiles = new Map<string, DependencyFile>();
  const identities = new Map<string, DependencyFile>();
  for (const source of record.sources) {
    if (captureSources)
      for (const file of source.files) sourceFiles.set(file.path, file);
    for (const file of [...source.files, ...source.discovery])
      observations.set(file.path, file);
    for (const marker of source.identity) identities.set(marker.path, marker);
  }
  const fingerprints = new Map<string, string>(),
    changed = new Set<string>();
  for (const [relative, file] of observations) {
    let overlay = buffers.has(relative);
    const filename = path.join(record.root, ...relative.split("/"));
    try {
      const before = await lstat(filename, { bigint: true });
      if (file.state === "missing") {
        changed.add(relative);
        continue;
      }
      const beforeTarget = before.isSymbolicLink()
        ? await stat(filename, { bigint: true })
        : undefined;
      let bytes: Uint8Array | undefined;
      let resolved: string | undefined;
      if (file.state === "read") {
        resolved = await realpath(filename);
        const relativeTarget = path.relative(record.root, resolved);
        if (
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeTarget)
        ) {
          changed.add(relative);
          continue;
        }
        if (
          templateOverlay &&
          overlayFiles.has(relative) &&
          resolved === templateOverlay.filename
        ) {
          if (file.sha256 !== templateOverlay.sha256) {
            changed.add(relative);
            continue;
          }
          overlay = true;
          overlayPaths.add(relative);
        }
        if ((beforeTarget ?? before).isFile())
          bytes = await readSource(resolved);
      }
      if (
        file.state === "read" &&
        !overlay &&
        (!bytes || hash(bytes) !== file.sha256)
      ) {
        changed.add(relative);
        continue;
      }
      const after = await lstat(filename, { bigint: true });
      const afterTarget = after.isSymbolicLink()
        ? await stat(filename, { bigint: true })
        : undefined;
      if (
        observationFingerprint(before, beforeTarget) !==
          observationFingerprint(after, afterTarget) ||
        (resolved !== undefined && (await realpath(filename)) !== resolved)
      ) {
        changed.add(relative);
        continue;
      }
      if (rootFingerprint && resolved && bytes) {
        const canonical = path
          .relative(record.root, resolved)
          .split(path.sep)
          .join("/");
        const owner = sourceFiles.get(canonical);
        if (
          owner?.state === "read" &&
          owner.sha256 === file.sha256 &&
          !relative.split("/").includes(".git") &&
          !canonical.split("/").includes(".git")
        ) {
          const observation = {
            filename: resolved,
            // An overlay owns the captured buffer digest, while its disk
            // entry and canonical owner retain their observed identities.
            fingerprint:
              observationFingerprint(after, afterTarget) + ":" + file.sha256,
            rootFingerprint,
          };
          targets.set(relative, observation);
          if (resolved !== filename) aliases.set(relative, observation);
        }
      }
      fingerprints.set(
        relative,
        bytes
          ? contentFingerprint(after, bytes, afterTarget)
          : observationFingerprint(after, afterTarget),
      );
    } catch (error) {
      if (
        file.state === "unavailable" ||
        ((error as NodeJS.ErrnoException).code === "ENOENT" &&
          (file.state !== "read" || overlay))
      )
        fingerprints.set(relative, "unavailable");
      else changed.add(relative);
    }
  }
  for (const [relative, marker] of identities) {
    const filename = path.join(record.root, ...relative.split("/"));
    try {
      const before = await lstat(filename, { bigint: true });
      const beforeTarget = before.isSymbolicLink()
        ? await stat(filename, { bigint: true })
        : undefined;
      const regular = (beforeTarget ?? before).isFile();
      if (
        marker.state === "missing" ||
        (marker.state === "regular") !== regular
      ) {
        changed.add(relative);
        continue;
      }
      const after = await lstat(filename, { bigint: true });
      const afterTarget = after.isSymbolicLink()
        ? await stat(filename, { bigint: true })
        : undefined;
      if (
        observationFingerprint(before, beforeTarget) !==
        observationFingerprint(after, afterTarget)
      ) {
        changed.add(relative);
        continue;
      }
      // Loaded bytes have already established a stronger identity observation.
      if (!observations.has(relative))
        fingerprints.set(relative, observationFingerprint(after, afterTarget));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        marker.state === "missing"
      ) {
        if (!observations.has(relative))
          fingerprints.set(relative, "unavailable");
      } else if (marker.state !== "unavailable") changed.add(relative);
    }
  }
  if (templateOverlay) {
    try {
      if ((await overlayOwner()) !== ownerFingerprint)
        changed.add(templateOverlay.path);
    } catch {
      changed.add(templateOverlay.path);
    }
  }
  return { fingerprints, changed, overlayPaths, aliases, targets };
}
