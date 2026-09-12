package nuri

import (
	"io/fs"
	"runtime"

	"github.com/frostybee/nuri/ast"
)

type grammarEntry struct {
	name string
	data []byte
}

type themeEntry struct {
	name string
	data []byte
}

type aliasEntry struct {
	alias  string
	target string
}

type extensionEntry struct {
	ext  string
	lang string
}

type options struct {
	grammarFS           fs.FS
	themeFS             fs.FS
	poolSize            int
	maxLineLength       int
	timeoutMs           int
	minContrast         float64
	regexInterruption   bool
	compilationCacheDir string
	grammars            []grammarEntry
	themes              []themeEntry
	aliases             []aliasEntry
	extensions          []extensionEntry
	defaults            *ast.CodeToHTMLOptions
}

// Option configures a Highlighter.
type Option func(*options)

// WithGrammarFS sets the filesystem for grammar JSON files.
func WithGrammarFS(fsys fs.FS) Option {
	return func(o *options) { o.grammarFS = fsys }
}

// WithThemeFS sets the filesystem for theme JSON files.
func WithThemeFS(fsys fs.FS) Option {
	return func(o *options) { o.themeFS = fsys }
}

// WithFS sets both the grammar and theme filesystems from a single fs.FS
// that contains "grammars/" and "themes/" subdirectories. This is the
// intended way to use the bundle packages.
func WithFS(fsys fs.FS) Option {
	return func(o *options) {
		o.grammarFS, _ = fs.Sub(fsys, "grammars")
		o.themeFS, _ = fs.Sub(fsys, "themes")
	}
}

// WithPoolSize sets the maximum number of WASM instances in the pool.
// Defaults to runtime.NumCPU().
//
// Instances are created lazily on demand, and the pool is LIFO: a borrow
// returns the most-recently-used instance. Each instance keeps a
// process-lifetime cache of compiled regex scanners for every grammar
// context it has tokenized (unbounded by design — Shiki/vscode-textmate
// never evict either), so a sequential workload keeps reusing one warm
// instance, and a workload with W concurrent tokenizations keeps a warm
// working set of W instances. Memory scales with instances actually
// created × distinct grammars used — sizing above your expected
// concurrency costs nothing until that concurrency materializes.
func WithPoolSize(n int) Option {
	return func(o *options) { o.poolSize = n }
}

// WithMaxLineLength sets the byte-length threshold for per-line pre-filtering.
// Lines exceeding this are emitted as a single unstyled token with a "too_long"
// diagnostic. 0 means no limit (the default).
func WithMaxLineLength(n int) Option {
	return func(o *options) { o.maxLineLength = n }
}

// WithTimeoutMs sets the per-line soft timeout in milliseconds. Lines whose
// tokenization exceeds this are stopped early; partial tokens are preserved and
// a "timeout" diagnostic is recorded. 0 means no timeout (the default).
func WithTimeoutMs(ms int) Option {
	return func(o *options) { o.timeoutMs = ms }
}

// WithGrammar registers a custom grammar from JSON bytes at construction time.
func WithGrammar(name string, data []byte) Option {
	return func(o *options) {
		o.grammars = append(o.grammars, grammarEntry{name, data})
	}
}

// WithTheme registers a custom theme from JSON bytes at construction time.
func WithTheme(name string, data []byte) Option {
	return func(o *options) {
		o.themes = append(o.themes, themeEntry{name, data})
	}
}

// WithAlias registers a language alias at construction time (e.g. "sh" -> "shellscript").
func WithAlias(alias, target string) Option {
	return func(o *options) {
		o.aliases = append(o.aliases, aliasEntry{alias, target})
	}
}

// WithExtension maps a file extension (without dot) to a language name at
// construction time. Overrides any existing mapping for that extension.
func WithExtension(ext, lang string) Option {
	return func(o *options) {
		o.extensions = append(o.extensions, extensionEntry{ext, lang})
	}
}

// WithDefaults sets default CodeToHTMLOptions applied to every CodeToHTML call.
// Per-call options override these defaults (non-zero values win).
func WithDefaults(defaults CodeToHTMLOptions) Option {
	return func(o *options) {
		o.defaults = &defaults
	}
}

// WithMinContrast sets the minimum WCAG 2.1 contrast ratio between syntax
// token foreground colors and the editor background. Tokens that fail the
// check are adjusted at theme load time (zero per-token cost). The default
// is 5.5 (WCAG AA enhanced). Set to 0 to disable and preserve raw theme colors.
func WithMinContrast(ratio float64) Option {
	return func(o *options) { o.minContrast = ratio }
}

// WithRegexInterruption toggles WASM-level regex interruption (default true).
// When enabled, regex execution compiled into the WASM runtime checks for
// context cancellation, so a runaway pattern can be stopped mid-search at
// the cost of some throughput. When disabled, only the Go-side soft per-line
// timeout (checked between scan positions) and Oniguruma's internal match
// stack limit bound a pathological regex.
func WithRegexInterruption(enabled bool) Option {
	return func(o *options) { o.regexInterruption = enabled }
}

// WithCompilationCacheDir enables an on-disk cache for the AOT-compiled
// onig.wasm module, cutting process cold-start time (useful for CLI/SSG
// invocations). The directory is created if needed and may be shared
// between processes; it only grows when the embedded WASM module changes.
func WithCompilationCacheDir(dir string) Option {
	return func(o *options) { o.compilationCacheDir = dir }
}

func defaultOptions() options {
	return options{
		poolSize:          runtime.NumCPU(),
		minContrast:       5.5,
		regexInterruption: true,
	}
}
