import type { AnalysisRecord, SourceDependencies } from "./protocol.ts";

interface Entry {
  record: SourceDependencies;
  revision: number;
  fingerprints: Map<string, string>;
}
interface State {
  root: string;
  sources: Map<string, Entry>;
  files: Map<string, Set<string>>;
  directories: Map<string, Set<string>>;
  events: { revision: number; path: string; fingerprint?: string }[];
  floor: number;
  admission: number;
  fingerprints: Map<string, string>;
}
const contains = (directory: string, file: string) =>
  file === directory || file.startsWith(`${directory}/`);
const observesDirectory = (directory: string, file: string) => {
  if (contains(directory, file)) return true;
  if (file === ".gitignore") return true;
  if (!file.endsWith("/.gitignore")) return false;
  return contains(file.slice(0, -"/.gitignore".length), directory);
};
const observes = (record: SourceDependencies, file: string) =>
  [...record.files, ...record.identity, ...record.discovery].some(
    (item) => item.path === file,
  ) || record.directories.some((item) => observesDirectory(item.path, file));

// Dependency ownership and event freshness share one lifecycle. Tokens precede
// scans so even events for previously unknown dependencies reject late results.
export class Dependencies {
  private readonly states = new Map<string, State>();
  private next = 0;
  observationKind(
    folder: string,
    file: string,
  ): "read" | "metadata" | undefined {
    const state = this.states.get(folder);
    const sources = state?.files.get(file);
    if (!state || !sources) return;
    for (const source of sources) {
      const record = state.sources.get(source)!.record;
      if (
        [...record.files, ...record.discovery].some(
          (item) => item.path === file && item.state === "read",
        )
      )
        return "read";
    }
    return "metadata";
  }
  admissionRevision(folder: string): number {
    return this.states.get(folder)?.admission ?? 0;
  }
  begin(): number {
    return this.next;
  }
  revision(folder: string, source: string): number {
    return this.states.get(folder)?.sources.get(source)?.revision ?? 0;
  }
  accept(
    folder: string,
    record: AnalysisRecord,
    token: number,
    full: boolean,
    retained: Iterable<string> = [],
    fingerprints: ReadonlyMap<string, string> = new Map(),
  ): boolean {
    const state = this.states.get(folder);
    if (
      state &&
      (state.root !== record.root ||
        token < state.floor ||
        state.events.some(
          (event) =>
            event.revision > token &&
            (!event.fingerprint ||
              fingerprints.get(event.path) !== event.fingerprint) &&
            record.sources.some((source) => observes(source, event.path)),
        ))
    )
      return false;
    const current = state ?? {
      root: record.root,
      sources: new Map(),
      files: new Map(),
      directories: new Map(),
      events: [],
      floor: 0,
      admission: 0,
      fingerprints: new Map(),
    };
    for (const [file, fingerprint] of fingerprints)
      current.fingerprints.set(file, fingerprint);
    const previous = new Map(current.sources);
    if (full) {
      const keep = new Set(retained);
      for (const source of current.sources.keys())
        if (!keep.has(source)) current.sources.delete(source);
    }
    for (const source of record.sources) {
      const observed = new Map<string, string>();
      const declared = new Set(
        [...source.files, ...source.identity, ...source.discovery].map(
          (file) => file.path,
        ),
      );
      for (const [file, fingerprint] of previous.get(source.path)
        ?.fingerprints ?? [])
        if (!declared.has(file) && observes(source, file))
          observed.set(file, fingerprint);
      for (const file of declared)
        if (fingerprints.has(file))
          // A report replaces only its own result. Other buffers can still
          // display an older result for this canonical source, so acceptance
          // must not consume the next dependency event on their behalf.
          observed.set(
            file,
            previous.get(source.path)?.fingerprints.get(file) ??
              fingerprints.get(file)!,
          );
      current.sources.set(source.path, {
        record: source,
        revision: previous.get(source.path)?.revision ?? 0,
        fingerprints: observed,
      });
    }
    current.files.clear();
    current.directories.clear();
    const index = (
      map: Map<string, Set<string>>,
      key: string,
      source: string,
    ) => {
      const entries = map.get(key) ?? new Set<string>();
      entries.add(source);
      map.set(key, entries);
    };
    for (const [source, entry] of current.sources) {
      for (const file of [
        ...entry.record.files,
        ...entry.record.identity,
        ...entry.record.discovery,
      ])
        index(current.files, file.path, source);
      for (const directory of entry.record.directories)
        index(current.directories, directory.path, source);
    }
    this.states.set(folder, current);
    return true;
  }
  event(
    folder: string,
    root: string,
    file: string,
    fingerprint?: string,
  ): Set<string> | undefined {
    let state = this.states.get(folder);
    if (!state) {
      state = {
        root,
        sources: new Map(),
        files: new Map(),
        directories: new Map(),
        events: [],
        floor: 0,
        admission: 0,
        fingerprints: new Map(),
      };
      this.states.set(folder, state);
    }
    if (state.root !== root) return new Set();
    const candidates = new Set(state.files.get(file));
    for (const [directory, sources] of state.directories)
      if (observesDirectory(directory, file))
        for (const source of sources) candidates.add(source);
    const affected = new Set<string>();
    for (const source of candidates) {
      const entry = state.sources.get(source)!;
      const reads = [...entry.record.files, ...entry.record.discovery].some(
        (item) => item.path === file && item.state === "read",
      );
      const metadata =
        !reads &&
        [
          ...entry.record.files,
          ...entry.record.identity,
          ...entry.record.discovery,
        ].some((item) => item.path === file);
      const observed =
        metadata && fingerprint
          ? fingerprint.replace(/:[0-9a-f]{64}$/, "")
          : fingerprint;
      if (observed === undefined || entry.fingerprints.get(file) !== observed)
        affected.add(source);
      if (observed !== undefined) entry.fingerprints.set(file, observed);
    }
    const echo =
      fingerprint !== undefined && state.fingerprints.get(file) === fingerprint;
    if (echo && !affected.size) return;
    if (fingerprint !== undefined) {
      state.fingerprints.set(file, fingerprint);
      if (state.fingerprints.size > 4096)
        state.fingerprints.delete(state.fingerprints.keys().next().value!);
    }
    const revision = ++this.next;
    if (
      file === ".gitignore" ||
      file.endsWith("/.gitignore") ||
      file === ".git/info/exclude"
    )
      state.admission = revision;
    state.events.push({ revision, path: file, fingerprint });
    if (state.events.length > 4096)
      state.floor = state.events.shift()!.revision;
    for (const source of affected)
      state.sources.get(source)!.revision = revision;
    return affected;
  }
  remove(folder: string, source?: string): void {
    if (source === undefined) {
      this.states.delete(folder);
      return;
    }
    const state = this.states.get(folder);
    if (state) state.sources.delete(source);
    for (const map of [state?.files, state?.directories])
      if (map)
        for (const [key, sources] of map) {
          sources.delete(source);
          if (!sources.size) map.delete(key);
        }
  }
  clear(): void {
    this.states.clear();
  }
}
