package oniguruma

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// Pool is a bounded LIFO pool of WASM instances with lazy creation.
//
// LIFO matters: each instance keeps a process-lifetime cache of compiled
// regex scanners (instance.scanners), and compiling a grammar's scanners is
// expensive (~185ms for JavaScript). Get returns the most-recently-used —
// warmest — instance, so a sequential workload keeps reusing one warm
// instance, and a concurrent workload with W in-flight borrowers keeps a warm
// working set of exactly W instances. A FIFO pool (the previous design)
// rotated sequential callers across every instance, paying the full compile
// cost on nearly every call.
//
// Instances are created on demand: NewPool does no WASM work, and instances
// beyond the peak concurrency level are never instantiated.
//
// Invariants:
//   - sem holds one token per available borrow slot: tokens_in_sem ==
//     size − borrowers, where a borrower is a goroutine between a successful
//     sem-acquire in Get and the matching release (Put, Swap, or a Get
//     failure path).
//   - Every created instance is either on the idle stack or held by exactly
//     one borrower. So when a token-holder finds idle empty, all other
//     instances are held by other borrowers (at most size−1 of them), and
//     creating a new instance can never exceed size — no explicit count
//     check is needed.
//   - Put pushes to idle BEFORE releasing the token, so a waiter woken by
//     that token always finds a non-empty stack and pops the warm instance
//     instead of creating a cold one.
type Pool struct {
	eng  *Engine
	size int

	// sem is a counting semaphore with capacity == size. Acquired in Get
	// (ctx-aware); released in Put, in Swap (both paths), and on Get's
	// failure paths.
	sem chan struct{}

	mu     sync.Mutex
	idle   []*instance // LIFO stack; last element = most recently used
	all    []*instance // every live instance, for Close; len(all) <= size
	closed bool
}

// NewPool creates a pool that lazily instantiates up to size WASM instances.
// No instances are created here; creation failures surface from Get (and
// therefore from Do). ctx is retained in the signature for API stability and
// future use; it is currently unused.
func NewPool(ctx context.Context, eng *Engine, size int) (*Pool, error) {
	if size < 1 {
		return nil, fmt.Errorf("oniguruma: pool size must be >= 1")
	}
	_ = ctx

	p := &Pool{
		eng:  eng,
		size: size,
		sem:  make(chan struct{}, size),
		idle: make([]*instance, 0, size),
		all:  make([]*instance, 0, size),
	}
	for i := 0; i < size; i++ {
		p.sem <- struct{}{}
	}
	return p, nil
}

// Get borrows an instance, blocking until a borrow slot is available or ctx
// is done. It returns the most-recently-used idle instance (warmest scanner
// cache), creating a new one only when no instance is idle.
func (p *Pool) Get(ctx context.Context) (*instance, error) {
	select {
	case <-p.sem:
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		p.sem <- struct{}{}
		return nil, errors.New("oniguruma: pool is closed")
	}
	if n := len(p.idle); n > 0 {
		inst := p.idle[n-1]
		p.idle[n-1] = nil // drop the stack's reference; borrower owns it now
		p.idle = p.idle[:n-1]
		p.mu.Unlock()
		return inst, nil
	}
	p.mu.Unlock()

	// Idle is empty but we hold a token, so creating cannot exceed size.
	// newInstance does WASM work (~5ms) — keep it outside the lock.
	inst, err := p.eng.newInstance(ctx)
	if err != nil {
		p.sem <- struct{}{} // give the borrow slot back
		return nil, fmt.Errorf("oniguruma: create pool instance: %w", err)
	}
	p.mu.Lock()
	p.all = append(p.all, inst)
	p.mu.Unlock()
	return inst, nil
}

// Put returns a borrowed instance to the pool. Double-Put would let two
// borrowers share one WASM instance and corrupt its linear memory, so it is
// checked and panics loudly (pool sizes are small; the scan is free).
func (p *Pool) Put(inst *instance) {
	p.mu.Lock()
	for _, idle := range p.idle {
		if idle == inst {
			p.mu.Unlock()
			panic("oniguruma: double Put of pool instance")
		}
	}
	p.idle = append(p.idle, inst) // push BEFORE releasing the token
	p.mu.Unlock()
	p.sem <- struct{}{}
}

// Swap retires a poisoned, checked-out instance and returns the borrower's
// capacity to the pool. Contract: the caller must currently hold old from
// Get; Swap releases the caller's borrow slot on every path (the caller must
// NOT also call Put).
//
// On replacement failure the old instance is still retired and the slot
// released — the pool self-heals because the next Get lazily creates a fresh
// instance. (The previous design left a failed Swap's capacity permanently
// lost.)
func (p *Pool) Swap(ctx context.Context, old *instance) error {
	fresh, err := p.eng.newInstance(ctx)
	if err != nil {
		p.mu.Lock()
		p.removeFromAllLocked(old)
		p.mu.Unlock()
		old.close(ctx)
		p.sem <- struct{}{}
		return fmt.Errorf("oniguruma: create replacement instance: %w", err)
	}

	p.mu.Lock()
	if p.closed {
		// Close already ran; nobody will close fresh if we publish it.
		p.mu.Unlock()
		fresh.close(ctx)
		old.close(ctx)
		p.sem <- struct{}{}
		return nil
	}
	p.removeFromAllLocked(old)
	p.all = append(p.all, fresh)
	p.idle = append(p.idle, fresh) // cold, but on top — warm instances below
	// it are only reachable once it is borrowed, which also warms it
	p.mu.Unlock()

	old.close(ctx)
	p.sem <- struct{}{}
	return nil
}

// removeFromAllLocked removes old from p.all. Caller must hold p.mu.
func (p *Pool) removeFromAllLocked(old *instance) {
	for i, inst := range p.all {
		if inst == old {
			last := len(p.all) - 1
			p.all[i] = p.all[last]
			p.all[last] = nil
			p.all = p.all[:last]
			return
		}
	}
}

// Do borrows an instance from the pool, passes it to fn as OnigLib, and
// returns it when fn completes. If fn panics, the instance is poisoned and
// replaced with a fresh one.
func (p *Pool) Do(ctx context.Context, fn func(OnigLib) error) (retErr error) {
	inst, err := p.Get(ctx)
	if err != nil {
		return err
	}

	defer func() {
		if r := recover(); r != nil {
			inst.poisoned = true
			retErr = fmt.Errorf("oniguruma: panic in Do: %v", r)
		}
		if inst.poisoned {
			if swapErr := p.Swap(ctx, inst); swapErr != nil {
				retErr = errors.Join(retErr, swapErr)
			}
		} else {
			p.Put(inst)
		}
	}()

	return fn(inst)
}

// Close closes every created instance, including ones currently checked out
// (their borrowers' subsequent WASM calls fail on the closed module — same
// behavior as the previous design). Get after Close returns an error.
func (p *Pool) Close(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true

	var firstErr error
	for _, inst := range p.all {
		if err := inst.close(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	p.all = nil
	p.idle = nil
	return firstErr
}
