import { lstat, readFile, stat, realpath } from "node:fs/promises";
import { identify, unavailableSource } from "./identity.ts";
import type { BigIntStats } from "node:fs";
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

// Query aliases require a known admitted canonical source, not matching bytes
// alone. The observation pins both the lexical entry and its canonical owner.
export interface ObservedAlias {
  filename: string;
  fingerprint: string;
  rootFingerprint: string;
}
export async function aliasCurrent(
  root: string,
  relative: string,
  alias: ObservedAlias,
  digest: string,
): Promise<boolean> {
  try {
    sourcePath(relative);
    const filename = path.join(root, ...relative.split("/"));
    const identity = await identify(root, filename);
    if (
      identity.filename !== alias.filename ||
      relative.split("/").includes(".git") ||
      identity.path.split("/").includes(".git") ||
      (await realpath(root)) !== root ||
      fileFingerprint(await lstat(root, { bigint: true })) !==
        alias.rootFingerprint
    )
      return false;
    const entry = await lstat(filename, { bigint: true });
    const target = entry.isSymbolicLink()
      ? await stat(filename, { bigint: true })
      : undefined;
    return (
      observationFingerprint(entry, target) + ":" + digest ===
        alias.fingerprint && (await realpath(filename)) === alias.filename
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
  captureAliases = false,
): Promise<{
  fingerprints: Map<string, string>;
  changed: Set<string>;
  overlayPaths: Set<string>;
  aliases: Map<string, ObservedAlias>;
}> {
  const overlayPaths = new Set<string>();
  const aliases = new Map<string, ObservedAlias>();
  const rootFingerprint = captureAliases
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
      };
    }
  }
  const observations = new Map<string, DependencyFile>();
  const sourceFiles = new Map<string, DependencyFile>();
  const identities = new Map<string, DependencyFile>();
  for (const source of record.sources) {
    if (captureAliases)
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
      if (rootFingerprint && resolved && resolved !== filename && bytes) {
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
          aliases.set(relative, {
            filename: resolved,
            // An overlay owns the captured buffer digest, while its disk
            // entry and canonical owner retain their observed identities.
            fingerprint:
              observationFingerprint(after, afterTarget) + ":" + file.sha256,
            rootFingerprint,
          });
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
  return { fingerprints, changed, overlayPaths, aliases };
}
