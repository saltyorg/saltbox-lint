import { lstat, readFile, stat, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";
import { hash, type AnalysisRecord, type DependencyFile } from "./protocol.ts";

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

export async function observeAnalysis(
  record: AnalysisRecord,
  buffers: ReadonlySet<string> = new Set(),
  readSource: (filename: string) => Promise<Uint8Array> = readFile,
): Promise<{ fingerprints: Map<string, string>; changed: Set<string> }> {
  const observations = new Map<string, DependencyFile>();
  const identities = new Map<string, DependencyFile>();
  for (const source of record.sources) {
    for (const file of [...source.files, ...source.discovery])
      observations.set(file.path, file);
    for (const marker of source.identity) identities.set(marker.path, marker);
  }
  const fingerprints = new Map<string, string>(),
    changed = new Set<string>();
  for (const [relative, file] of observations) {
    const overlay = buffers.has(relative);
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
      if (file.state === "read") {
        const resolved = await realpath(filename);
        const relativeTarget = path.relative(record.root, resolved);
        if (
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeTarget)
        ) {
          changed.add(relative);
          continue;
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
        observationFingerprint(after, afterTarget)
      ) {
        changed.add(relative);
        continue;
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
  return { fingerprints, changed };
}
