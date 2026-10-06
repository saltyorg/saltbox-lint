package lint

import (
	"sync/atomic"
	"time"
)

// LoadStatistics measures parser work only when explicitly supplied to Load.
// Parser elapsed time is summed across workers and includes rejected discovery
// candidates. It is not a nonoverlapping portion of load wall time.
type LoadStatistics struct {
	attempts atomic.Int64
	nanos    atomic.Int64
}

func (s *LoadStatistics) Parsing() (attempts int64, elapsed time.Duration) {
	return s.attempts.Load(), time.Duration(s.nanos.Load())
}

func (s *Source) ParseDiagnosticCount() int { return len(s.parseDiagnostics) }
