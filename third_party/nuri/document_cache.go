package nuri

import (
	"container/list"
	"sync"

	"github.com/frostybee/nuri/internal/tokenizer"
)

type documentEntry struct {
	document    *Document
	snapshot    *tokenizer.DocumentSnapshot
	bytes, pins int
	invalid     bool
}

type documentCache struct {
	mu                    sync.Mutex
	entries               map[*Document]*list.Element
	lru                   *list.List
	bytes, peak, maxBytes int
	visited, reused       uint64
	closed                bool
}

// DocumentCacheStats exposes retained memory and actual traversal for profiling.
// Pinned snapshots remain charged until the borrower has finished building its
// independently owned public result; eviction never hides their retained bytes.
type DocumentCacheStats struct {
	Bytes, PeakBytes, LineBytes, Entries int
	Visited, Reused                      uint64
}

func newDocumentCache(maxBytes int) *documentCache {
	return &documentCache{maxBytes: max(0, maxBytes), entries: make(map[*Document]*list.Element), lru: list.New()}
}

func (c *documentCache) acquire(document *Document) (*tokenizer.DocumentSnapshot, func()) {
	c.mu.Lock()
	entry := c.entries[document]
	if entry == nil || entry.Value.(*documentEntry).invalid {
		c.mu.Unlock()
		return nil, func() {}
	}
	item := entry.Value.(*documentEntry)
	item.pins++
	c.lru.MoveToFront(entry)
	c.mu.Unlock()
	return item.snapshot, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		item.pins--
		if item.invalid && item.pins == 0 {
			c.remove(entry)
		}
	}
}

func (c *documentCache) store(document *Document, snapshot *tokenizer.DocumentSnapshot) {
	if snapshot == nil {
		return
	}
	size := snapshot.Bytes() + 256 + len(document.source)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || size > c.maxBytes {
		return
	}
	if previous := c.entries[document]; previous != nil {
		if previous.Value.(*documentEntry).pins > 0 {
			return
		}
		c.remove(previous)
	}
	for c.bytes+size > c.maxBytes {
		candidate := c.lru.Back()
		for candidate != nil && candidate.Value.(*documentEntry).pins > 0 {
			candidate = candidate.Prev()
		}
		if candidate == nil {
			return
		}
		c.remove(candidate)
	}
	entry := &documentEntry{document: document, snapshot: snapshot, bytes: size}
	c.entries[document] = c.lru.PushFront(entry)
	c.bytes += size
	c.peak = max(c.peak, c.bytes)
}

func (c *documentCache) remove(element *list.Element) {
	entry := element.Value.(*documentEntry)
	delete(c.entries, entry.document)
	c.lru.Remove(element)
	c.bytes -= entry.bytes
}

func (c *documentCache) record(stats tokenizer.DocumentStats) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.visited += uint64(stats.Visited)
	c.reused += uint64(stats.Reused)
}

func (c *documentCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[*Document]*list.Element)
	c.lru.Init()
	c.bytes = 0
}

func (c *documentCache) close() { c.clear(); c.mu.Lock(); c.closed = true; c.mu.Unlock() }

func (h *Highlighter) DocumentCacheStats() DocumentCacheStats {
	c := h.documents
	c.mu.Lock()
	defer c.mu.Unlock()
	return DocumentCacheStats{Bytes: c.bytes, PeakBytes: c.peak, LineBytes: h.lineCache.Stats().Bytes, Entries: c.lru.Len(), Visited: c.visited, Reused: c.reused}
}

// invalidate excludes a degraded document immediately while still charging any
// already borrowed snapshot until its final reader has finished.
func (c *documentCache) invalidate(document *Document) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if element := c.entries[document]; element != nil {
		entry := element.Value.(*documentEntry)
		entry.invalid = true
		if entry.pins == 0 {
			c.remove(element)
		}
	}
}
