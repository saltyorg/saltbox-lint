package oniguruma

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"hash/fnv"

	"github.com/tetratelabs/wazero/api"
)

type instance struct {
	module   api.Module
	mem      api.Memory
	poisoned bool

	// scanners caches compiled scanners for the lifetime of the instance,
	// keyed by pattern-set hash with linear bucket scan + exact byte
	// verification (a silent 64-bit collision would corrupt output).
	// Unbounded by design — Shiki/vscode-textmate never evict either; the
	// cache dies with the module on Close or poison-swap.
	scanners map[uint64][]cachedScanner

	// Persistent FFI buffers (single-goroutine while checked out of the
	// pool, so no locking). curText pins the Go slice last uploaded to
	// textPtr: while the reference is live the allocator cannot reuse its
	// address, so a SliceData match guarantees the WASM copy is current.
	// wazero's memory.grow never relocates allocations, so textPtr and
	// resultPtr stay valid across calls.
	curText   []byte
	textPtr   uint32
	textCap   uint32
	resultPtr uint32
	callStack [8]uint64

	fnMalloc        api.Function
	fnFree          api.Function
	fnInit          api.Function
	fnCreateScanner api.Function
	fnFindNextMatch api.Function
	fnFreeScanner   api.Function
	fnGetLastError  api.Function
}

// cachedScanner pairs a compiled scanner with an exact copy of the pattern
// set that produced it (joined bytes + per-pattern lengths) so a hash
// collision can never return the wrong scanner.
type cachedScanner struct {
	joined  []byte
	lens    []int
	scanner *Scanner
}

func (c *cachedScanner) matches(patterns [][]byte) bool {
	if len(c.lens) != len(patterns) {
		return false
	}
	off := 0
	for i, p := range patterns {
		if c.lens[i] != len(p) {
			return false
		}
		if !bytes.Equal(c.joined[off:off+len(p)], p) {
			return false
		}
		off += len(p)
	}
	return off == len(c.joined)
}

// hashPatternSet is an overridable var so tests can force bucket collisions.
var hashPatternSet = func(patterns [][]byte) uint64 {
	h := fnv.New64a()
	for _, p := range patterns {
		h.Write(p)
		h.Write([]byte{0}) // separator
	}
	return h.Sum64()
}

// GetOrCreateScannerCtx returns a cached scanner for the given pattern set,
// compiling and caching one on first use. The returned scanner is owned by
// the instance; callers must not Close it. Cached scanners live until the
// instance itself is closed (or poison-swapped out of the pool).
func (inst *instance) GetOrCreateScannerCtx(ctx context.Context, patterns [][]byte) (OnigScanner, error) {
	key := hashPatternSet(patterns)
	for i := range inst.scanners[key] {
		if inst.scanners[key][i].matches(patterns) {
			return inst.scanners[key][i].scanner, nil
		}
	}

	scanner, err := inst.NewScanner(ctx, patterns)
	if err != nil {
		return nil, err
	}

	total := 0
	for _, p := range patterns {
		total += len(p)
	}
	joined := make([]byte, 0, total)
	lens := make([]int, len(patterns))
	for i, p := range patterns {
		joined = append(joined, p...)
		lens[i] = len(p)
	}
	inst.scanners[key] = append(inst.scanners[key], cachedScanner{
		joined:  joined,
		lens:    lens,
		scanner: scanner,
	})
	return scanner, nil
}

func (inst *instance) close(ctx context.Context) error {
	return inst.module.Close(ctx)
}

func (inst *instance) wasmAlloc(ctx context.Context, size uint32) (uint32, error) {
	inst.callStack[0] = uint64(size)
	if err := inst.fnMalloc.CallWithStack(ctx, inst.callStack[:]); err != nil {
		return 0, fmt.Errorf("malloc(%d): %w", size, err)
	}
	ptr := uint32(inst.callStack[0])
	if ptr == 0 {
		return 0, fmt.Errorf("malloc(%d) returned null", size)
	}
	return ptr, nil
}

func (inst *instance) wasmFree(ctx context.Context, ptr uint32) {
	inst.callStack[0] = uint64(ptr)
	inst.fnFree.CallWithStack(ctx, inst.callStack[:])
}

func (inst *instance) lastError(ctx context.Context) string {
	const bufSize = 256
	ptr, err := inst.wasmAlloc(ctx, bufSize)
	if err != nil {
		return "(cannot read error)"
	}
	defer inst.wasmFree(ctx, ptr)

	results, err := inst.fnGetLastError.Call(ctx, uint64(ptr), uint64(bufSize))
	if err != nil || results[0] == 0 {
		return "(cannot read error)"
	}
	length := uint32(results[0])
	buf, ok := inst.mem.Read(ptr, length)
	if !ok {
		return "(cannot read error)"
	}
	return string(buf)
}

func (inst *instance) NewScanner(ctx context.Context, patterns [][]byte) (*Scanner, error) {
	if len(patterns) == 0 {
		return nil, fmt.Errorf("oniguruma: no patterns provided")
	}

	totalLen := 0
	for _, p := range patterns {
		totalLen += len(p)
	}

	patBuf := make([]byte, totalLen)
	lengths := make([]int32, len(patterns))
	off := 0
	for i, p := range patterns {
		copy(patBuf[off:], p)
		lengths[i] = int32(len(p))
		off += len(p)
	}

	patPtr, err := inst.wasmAlloc(ctx, uint32(totalLen))
	if err != nil {
		return nil, fmt.Errorf("oniguruma: alloc patterns: %w", err)
	}
	inst.mem.Write(patPtr, patBuf)

	lenBufSize := uint32(len(patterns) * 4)
	lenPtr, err := inst.wasmAlloc(ctx, lenBufSize)
	if err != nil {
		inst.wasmFree(ctx, patPtr)
		return nil, fmt.Errorf("oniguruma: alloc lengths: %w", err)
	}
	lenBuf := make([]byte, lenBufSize)
	for i, l := range lengths {
		binary.LittleEndian.PutUint32(lenBuf[i*4:], uint32(l))
	}
	inst.mem.Write(lenPtr, lenBuf)

	results, err := inst.fnCreateScanner.Call(ctx,
		uint64(patPtr), uint64(lenPtr), uint64(len(patterns)))
	inst.wasmFree(ctx, patPtr)
	inst.wasmFree(ctx, lenPtr)

	if err != nil {
		return nil, fmt.Errorf("oniguruma: create_onig_scanner call: %w", err)
	}
	scannerPtr := uint32(results[0])
	if scannerPtr == 0 {
		errMsg := inst.lastError(ctx)
		return nil, fmt.Errorf("oniguruma: create_onig_scanner failed: %s", errMsg)
	}

	return &Scanner{
		inst: inst,
		ptr:  scannerPtr,
	}, nil
}

func (inst *instance) NewScannerCtx(ctx context.Context, patterns [][]byte) (OnigScanner, error) {
	return inst.NewScanner(ctx, patterns)
}

func (inst *instance) Close() error {
	return inst.close(context.Background())
}
