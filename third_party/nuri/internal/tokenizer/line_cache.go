package tokenizer

import (
	"container/list"
	"reflect"
	"sync"

	"github.com/frostybee/nuri/internal/grammar"
)

const lineCacheEntryOverhead = 256

// LineCache retains successful complete-line tokenization results. Keys include
// the exact bare line and the complete normalized incoming TextMate state.
// The byte budget bounds the retained line, scope, state, and token data; a
// fixed per-entry charge also bounds container overhead and entry count.
type LineCache struct {
	mu       sync.Mutex
	maxBytes int
	bytes    int
	lru      *list.List
	entries  map[lineCacheKey][]*list.Element
	hits     uint64
	misses   uint64
	stores   uint64
}

// LineCacheStats reports cache activity for regression tests and profiling.
type LineCacheStats struct {
	Hits, Misses, Stores uint64
	Entries, Bytes       int
}

type resolverKey struct {
	value grammar.GrammarResolver
}

type lineCacheKey struct {
	line          string
	grammar       *grammar.Grammar
	resolver      resolverKey
	maxLineLength int
	timeoutMs     int
	firstLine     bool
}

type lineCacheEntry struct {
	key      lineCacheKey
	incoming *StateStack
	tokens   []Token
	outgoing *StateStack
	bytes    int
}

// NewLineCache creates a cache with a fixed retained-memory budget. A
// non-positive budget disables storage.
func NewLineCache(maxBytes int) *LineCache {
	return &LineCache{
		maxBytes: max(0, maxBytes),
		lru:      list.New(),
		entries:  make(map[lineCacheKey][]*list.Element),
	}
}

// Stats returns a synchronized snapshot of cache activity.
func (c *LineCache) Stats() LineCacheStats {
	if c == nil {
		return LineCacheStats{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return LineCacheStats{
		Hits:    c.hits,
		Misses:  c.misses,
		Stores:  c.stores,
		Entries: c.lru.Len(),
		Bytes:   c.bytes,
	}
}

func (c *LineCache) lookup(line []byte, g *grammar.Grammar, resolver grammar.GrammarResolver, opts TokenizeOptions, firstLine bool, incoming *StateStack) ([]Token, *StateStack, bool) {
	if c == nil || c.maxBytes == 0 {
		return nil, nil, false
	}
	identity, ok := resolverIdentity(resolver)
	if !ok {
		return nil, nil, false
	}
	key := makeLineCacheKey(string(line), g, identity, opts, firstLine)

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, element := range c.entries[key] {
		entry := element.Value.(*lineCacheEntry)
		if !stateStacksEqual(entry.incoming, incoming) {
			continue
		}
		c.hits++
		c.lru.MoveToFront(element)
		return cloneTokens(entry.tokens), entry.outgoing.clone(), true
	}
	c.misses++
	return nil, nil, false
}

func (c *LineCache) store(line []byte, g *grammar.Grammar, resolver grammar.GrammarResolver, opts TokenizeOptions, firstLine bool, incoming *StateStack, tokens []Token, outgoing *StateStack) {
	if c == nil || c.maxBytes == 0 || incoming == nil || outgoing == nil {
		return
	}
	identity, ok := resolverIdentity(resolver)
	if !ok {
		return
	}
	key := makeLineCacheKey(string(line), g, identity, opts, firstLine)
	entry := &lineCacheEntry{
		key:      key,
		incoming: incoming.clone(),
		tokens:   cloneTokens(tokens),
		outgoing: outgoing.clone(),
	}
	entry.bytes = lineCacheEntryBytes(entry)
	if entry.bytes > c.maxBytes {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, element := range c.entries[key] {
		current := element.Value.(*lineCacheEntry)
		if stateStacksEqual(current.incoming, incoming) {
			c.lru.MoveToFront(element)
			return
		}
	}
	element := c.lru.PushFront(entry)
	c.entries[key] = append(c.entries[key], element)
	c.bytes += entry.bytes
	c.stores++
	for c.bytes > c.maxBytes {
		c.removeOldest()
	}
}

func makeLineCacheKey(line string, g *grammar.Grammar, resolver resolverKey, opts TokenizeOptions, firstLine bool) lineCacheKey {
	return lineCacheKey{
		line:          line,
		grammar:       g,
		resolver:      resolver,
		maxLineLength: opts.MaxLineLength,
		timeoutMs:     opts.TimeoutMs,
		firstLine:     firstLine,
	}
}

func resolverIdentity(resolver grammar.GrammarResolver) (resolverKey, bool) {
	if resolver == nil {
		return resolverKey{}, true
	}
	value := reflect.ValueOf(resolver)
	if value.Kind() != reflect.Pointer || value.IsNil() {
		return resolverKey{}, false
	}
	return resolverKey{value: resolver}, true
}

func (c *LineCache) removeOldest() {
	element := c.lru.Back()
	if element == nil {
		return
	}
	entry := element.Value.(*lineCacheEntry)
	bucket := c.entries[entry.key]
	for i, candidate := range bucket {
		if candidate != element {
			continue
		}
		copy(bucket[i:], bucket[i+1:])
		bucket[len(bucket)-1] = nil
		bucket = bucket[:len(bucket)-1]
		break
	}
	if len(bucket) == 0 {
		delete(c.entries, entry.key)
	} else {
		if cap(bucket) > 4 && cap(bucket) > 2*len(bucket) {
			bucket = append([]*list.Element(nil), bucket...)
		}
		c.entries[entry.key] = bucket
	}
	c.bytes -= entry.bytes
	c.lru.Remove(element)
}

func lineCacheEntryBytes(entry *lineCacheEntry) int {
	size := lineCacheEntryOverhead + len(entry.key.line)
	size += stateStackBytes(entry.incoming) + stateStackBytes(entry.outgoing)
	for _, token := range entry.tokens {
		size += 40 + cap(token.Scopes)*16
		for _, scope := range token.Scopes {
			size += len(scope)
		}
	}
	return size
}

func stateStackBytes(state *StateStack) int {
	if state == nil {
		return 0
	}
	size := 24 + cap(state.frames)*96
	for _, frame := range state.frames {
		size += len(frame.NameScope) + len(frame.ContentScope)
		if frame.EndRule != nil {
			size += 40 + len(frame.EndRule.EndPattern)
		}
		if frame.WhileRule != nil {
			size += 40 + len(frame.WhileRule.WhilePattern)
		}
	}
	return size
}

func cloneTokens(tokens []Token) []Token {
	if tokens == nil {
		return nil
	}
	cloned := make([]Token, len(tokens))
	for i, token := range tokens {
		cloned[i] = token
		cloned[i].Scopes = append([]string(nil), token.Scopes...)
	}
	return cloned
}

func stateStacksEqual(left, right *StateStack) bool {
	if left == nil || right == nil {
		return left == right
	}
	if len(left.frames) != len(right.frames) {
		return false
	}
	for i := range left.frames {
		if !stackFramesEqual(left.frames[i], right.frames[i]) {
			return false
		}
	}
	return true
}

func stackFramesEqual(left, right StackFrame) bool {
	return ruleIdentityEqual(left.Rule, right.Rule) &&
		left.ContentGrammar == right.ContentGrammar &&
		left.NameScope == right.NameScope &&
		left.ContentScope == right.ContentScope &&
		endRulesEqual(left.EndRule, right.EndRule) &&
		whileRulesEqual(left.WhileRule, right.WhileRule) &&
		left.BeginCapturedEOL == right.BeginCapturedEOL &&
		left.AnchorPosition == right.AnchorPosition &&
		left.EnterPosition == right.EnterPosition
}

func ruleIdentityEqual(left, right grammar.Rule) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	lv, rv := reflect.ValueOf(left), reflect.ValueOf(right)
	return lv.Kind() == reflect.Pointer && rv.Kind() == reflect.Pointer &&
		lv.Type() == rv.Type() && lv.Pointer() == rv.Pointer()
}

func endRulesEqual(left, right *grammar.EndRule) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.ID == right.ID && left.Parent == right.Parent && left.EndPattern == right.EndPattern && capturesEqual(left.EndCaptures, right.EndCaptures)
}

func whileRulesEqual(left, right *grammar.WhileRule) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.ID == right.ID && left.Parent == right.Parent && left.WhilePattern == right.WhilePattern && capturesEqual(left.WhileCaptures, right.WhileCaptures)
}

func capturesEqual(left, right grammar.Captures) bool {
	if len(left) != len(right) {
		return false
	}
	for index, capture := range left {
		if right[index] != capture {
			return false
		}
	}
	return true
}

// Clear invalidates cached contexts after registry mutations.
func (c *LineCache) Clear() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[lineCacheKey][]*list.Element)
	c.lru.Init()
	c.bytes = 0
}
