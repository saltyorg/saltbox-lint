// Cached results have one owner for scan merging, invalidation and removal.
// URI identity, request freshness and VS Code publication stay with the caller.
export class Results<
  Document extends { diagnostics: { relatedInformation?: unknown[] }[] },
> {
  private readonly documents = new Map<string, Document>();
  private readonly scans = new Map<
    string,
    Map<string, Document["diagnostics"]>
  >();
  private readonly complete = new Set<string>();

  document(uri: string): Document | undefined {
    return this.documents.get(uri);
  }
  storeDocument(uri: string, result: Document): void {
    this.documents.set(uri, result);
  }
  saved(folder: string, uri: string): Document["diagnostics"] | undefined {
    return this.scans.get(folder)?.get(uri);
  }
  invalidateCoverage(folder: string): void {
    this.complete.delete(folder);
  }
  hasCompleteScan(folder: string): boolean {
    return this.complete.has(folder);
  }
  uris(): Set<string> {
    const uris = new Set(this.documents.keys());
    for (const scan of this.scans.values())
      for (const uri of scan.keys()) uris.add(uri);
    return uris;
  }
  storeScan(
    folder: string,
    entries: Map<string, Document["diagnostics"]>,
    partial: boolean,
  ): Set<string> {
    const previous = this.scans.get(folder);
    this.scans.set(
      folder,
      partial ? new Map([...(previous ?? []), ...entries]) : entries,
    );
    if (!partial) this.complete.add(folder);
    return new Set([
      ...(partial ? [] : (previous?.keys() ?? [])),
      ...entries.keys(),
    ]);
  }
  invalidateRelated(): Set<string> {
    const changed = new Set<string>();
    const invalidate = (uri: string, diagnostics: Document["diagnostics"]) => {
      for (const diagnostic of diagnostics) {
        if (!diagnostic.relatedInformation?.length) continue;
        diagnostic.relatedInformation = undefined;
        changed.add(uri);
      }
    };
    for (const [uri, result] of this.documents)
      invalidate(uri, result.diagnostics);
    for (const scan of this.scans.values())
      for (const [uri, diagnostics] of scan) invalidate(uri, diagnostics);
    return changed;
  }
  close(uri: string, canonical?: string): void {
    this.documents.delete(uri);
    // Closing an alias suppresses its saved result without discarding another
    // live buffer's own result for the canonical URI.
    for (const scan of this.scans.values()) {
      scan.delete(uri);
      if (canonical) scan.delete(canonical);
    }
  }
  forget(uris: Iterable<string>): void {
    for (const uri of uris) this.close(uri);
  }
  refresh(folder: string, documents: Iterable<string>): Set<string> {
    const scanned = new Set(this.scans.get(folder)?.keys());
    this.scans.delete(folder);
    this.complete.delete(folder);
    for (const uri of documents) this.documents.delete(uri);
    return scanned;
  }
  clear(): void {
    this.documents.clear();
    this.scans.clear();
    this.complete.clear();
  }
}
