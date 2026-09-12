package oniguruma

import (
	"context"
	"fmt"

	"github.com/frostybee/nuri/resources/wasm"
	"github.com/tetratelabs/wazero"
)

type Engine struct {
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
}

type engineConfig struct {
	closeOnContextDone  bool
	compilationCacheDir string
}

// EngineOption configures NewEngine.
type EngineOption func(*engineConfig)

// WithEngineCloseOnContextDone toggles wazero's context-interruption support
// (compiled-in checkpoints + per-call watchdog when the caller's context is
// cancellable). Default true. Turning it off removes the interruption
// overhead but means a runaway regex cannot be stopped mid-search — the
// Go-side soft per-line timeout still applies between scan positions, and
// Oniguruma's match stack limit (set in onig_scanner_init) still bounds
// runaway backtracking in-WASM.
func WithEngineCloseOnContextDone(enabled bool) EngineOption {
	return func(c *engineConfig) { c.closeOnContextDone = enabled }
}

// WithEngineCompilationCacheDir enables wazero's on-disk compilation cache,
// skipping the AOT compile of onig.wasm (~470KB) on process cold start.
func WithEngineCompilationCacheDir(dir string) EngineOption {
	return func(c *engineConfig) { c.compilationCacheDir = dir }
}

func NewEngine(ctx context.Context, opts ...EngineOption) (*Engine, error) {
	ecfg := engineConfig{closeOnContextDone: true}
	for _, o := range opts {
		o(&ecfg)
	}

	// wazero.NewRuntimeConfig auto-selects the compiler backend on
	// amd64/arm64 (interpreter elsewhere) — kept auto for portability.
	cfg := wazero.NewRuntimeConfig().WithCloseOnContextDone(ecfg.closeOnContextDone)
	if ecfg.compilationCacheDir != "" {
		cache, err := wazero.NewCompilationCacheWithDir(ecfg.compilationCacheDir)
		if err != nil {
			return nil, fmt.Errorf("oniguruma: compilation cache: %w", err)
		}
		cfg = cfg.WithCompilationCache(cache)
	}
	rt := wazero.NewRuntimeWithConfig(ctx, cfg)

	_, err := rt.NewHostModuleBuilder("env").
		NewFunctionBuilder().
		WithFunc(func(ctx context.Context, idx int32) {}).
		WithParameterNames("memory_index").
		Export("emscripten_notify_memory_growth").
		Instantiate(ctx)
	if err != nil {
		rt.Close(ctx)
		return nil, fmt.Errorf("oniguruma: stub env imports: %w", err)
	}

	compiled, err := rt.CompileModule(ctx, wasm.OnigWasm)
	if err != nil {
		rt.Close(ctx)
		return nil, fmt.Errorf("oniguruma: compile wasm: %w", err)
	}

	return &Engine{
		runtime:  rt,
		compiled: compiled,
	}, nil
}

func (e *Engine) Close(ctx context.Context) error {
	return e.runtime.Close(ctx)
}

func (e *Engine) newInstance(ctx context.Context) (*instance, error) {
	mod, err := e.runtime.InstantiateModule(ctx, e.compiled, wazero.NewModuleConfig())
	if err != nil {
		return nil, fmt.Errorf("oniguruma: instantiate module: %w", err)
	}

	inst := &instance{
		module:          mod,
		mem:             mod.Memory(),
		scanners:        make(map[uint64][]cachedScanner),
		fnMalloc:        mod.ExportedFunction("malloc"),
		fnFree:          mod.ExportedFunction("free"),
		fnInit:          mod.ExportedFunction("onig_scanner_init"),
		fnCreateScanner: mod.ExportedFunction("create_onig_scanner"),
		fnFindNextMatch: mod.ExportedFunction("find_next_match"),
		fnFreeScanner:   mod.ExportedFunction("free_onig_scanner"),
		fnGetLastError:  mod.ExportedFunction("get_last_onig_error"),
	}

	results, err := inst.fnInit.Call(ctx)
	if err != nil {
		mod.Close(ctx)
		return nil, fmt.Errorf("oniguruma: onig_scanner_init call: %w", err)
	}
	if results[0] != 0 {
		mod.Close(ctx)
		return nil, fmt.Errorf("oniguruma: onig_scanner_init returned error %d", results[0])
	}

	return inst, nil
}
