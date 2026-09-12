package oniguruma

import "context"

type Match struct {
	Index    int
	Captures []Capture
}

type Capture struct {
	Start int
	End   int
}

type SearchOptions int

const (
	SearchOptionNone             SearchOptions = 0
	SearchOptionNotBeginString   SearchOptions = 1 << 22 // ONIG_OPTION_NOT_BEGIN_STRING (0x400000) — disables \A
	SearchOptionNotBeginPosition SearchOptions = 1 << 24 // ONIG_OPTION_NOT_BEGIN_POSITION (0x1000000) — disables \G
)

type OnigScanner interface {
	FindNextMatchCtx(ctx context.Context, text []byte, startPos int, options SearchOptions) (*Match, error)
	Close() error
}

type OnigLib interface {
	NewScannerCtx(ctx context.Context, patterns [][]byte) (OnigScanner, error)
	// GetOrCreateScannerCtx returns a cached scanner for the pattern set,
	// compiling and caching it on first use. The returned scanner is owned
	// by the lib; callers must not Close it.
	GetOrCreateScannerCtx(ctx context.Context, patterns [][]byte) (OnigScanner, error)
	Close() error
}
