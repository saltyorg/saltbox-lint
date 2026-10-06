package cmd

import (
	"errors"
	"io"
	"time"

	"github.com/saltyorg/saltbox-lint/lint"
	"github.com/saltyorg/saltbox-lint/report"
)

// checkStatistics belongs to one invocation. Disabled calls neither allocate
// records nor read the clock. Active phase duration includes interrupted work.
type checkStatistics struct {
	record  report.Statistics
	phase   string
	started time.Time
}

func newCheckStatistics() *checkStatistics {
	return &checkStatistics{record: report.Statistics{SchemaVersion: 1, Status: "complete", DurationUnit: "milliseconds", Phases: []report.StatisticsPhase{}}}
}

func (s *checkStatistics) begin(name string) {
	if s == nil {
		return
	}
	s.phase, s.started = name, time.Now()
}

func (s *checkStatistics) end(err error) {
	if s == nil || s.phase == "" {
		return
	}
	status := "complete"
	if err != nil {
		status = "failed"
	}
	duration := float64(time.Since(s.started)) / float64(time.Millisecond)
	s.record.Phases = append(s.record.Phases, report.StatisticsPhase{Name: s.phase, Status: status, Scope: "wall", Duration: &duration})
	s.phase = ""
}

func (s *checkStatistics) parsing(name string, metrics *lint.LoadStatistics, err error) {
	if s == nil {
		return
	}
	attempts, elapsed := metrics.Parsing()
	duration := float64(elapsed) / float64(time.Millisecond)
	phase := report.StatisticsPhase{Name: name, Status: "complete", Scope: "aggregate_worker", Duration: &duration, Attempts: &attempts}
	if err != nil {
		phase.Status = "partial"
		if attempts == 0 {
			phase.Status, phase.Duration = "unavailable", nil
		}
	}
	s.record.Phases = append(s.record.Phases, phase)
}

func (s *checkStatistics) finish(w io.Writer, format string, err error) error {
	if s == nil {
		return err
	}
	s.end(err)
	operational := err != nil && !errors.Is(err, errFindings)
	if operational {
		s.record.Status = "failed"
		for _, phase := range s.record.Phases {
			if phase.Status == "complete" {
				s.record.Status = "partial"
				break
			}
		}
	}
	if format == "json" && !operational {
		return err
	}
	statsErr := report.RenderStatistics(w, &s.record)
	if statsErr != nil {
		if err == nil || errors.Is(err, errFindings) {
			return statsErr
		}
		return errors.Join(err, statsErr)
	}
	return err
}
