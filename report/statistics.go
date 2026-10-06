package report

import (
	"cmp"
	"fmt"
	"io"
	"slices"

	"github.com/saltyorg/saltbox-lint/lint"
)

// Statistics is opt-in and versioned independently of check JSON schema 2.
// Durations are monotonic elapsed milliseconds. Nil durations are unavailable.
type Statistics struct {
	SchemaVersion int               `json:"schema_version"`
	Status        string            `json:"status"`
	DurationUnit  string            `json:"duration_unit"`
	Initial       *StatisticsCounts `json:"initial,omitempty"`
	Rechecked     *StatisticsCounts `json:"rechecked,omitempty"`
	PlannedFiles  *int              `json:"planned_files,omitempty"`
	AppliedFiles  *int              `json:"applied_files,omitempty"`
	Phases        []StatisticsPhase `json:"phases"`
}

type StatisticsPhase struct {
	Name     string   `json:"name"`
	Status   string   `json:"status"`
	Scope    string   `json:"scope"`
	Duration *float64 `json:"duration_ms"`
	Attempts *int64   `json:"parse_attempts,omitempty"`
}

type StatisticsCounts struct {
	Sources            int            `json:"sources"`
	Selected           int            `json:"selected"`
	Context            int            `json:"context"`
	SourceKinds        []KindCount    `json:"source_kinds"`
	ParseFailedSources int            `json:"parse_failed_sources"`
	ParseFindings      int            `json:"parse_findings"`
	Findings           int            `json:"findings"`
	Fixes              int            `json:"fixes"`
	Rules              []FindingCount `json:"rules"`
}

type KindCount struct {
	Kind     string `json:"kind"`
	Selected int    `json:"selected"`
	Context  int    `json:"context"`
}

type FindingCount struct {
	RuleID string `json:"rule_id"`
	Count  int    `json:"count"`
}

// CountStatistics projects the admitted project and the selected analysis result.
// It does not discover, read, parse, or evaluate any additional source.
func CountStatistics(project *lint.Project, ds []lint.Diagnostic) *StatisticsCounts {
	counts := &StatisticsCounts{SourceKinds: []KindCount{}}
	kinds := map[string]KindCount{}
	for name, source := range project.Sources {
		if source == nil {
			continue
		}
		counts.Sources++
		kind := kinds[string(source.Kind)]
		kind.Kind = string(source.Kind)
		if project.Selected[name] {
			counts.Selected++
			kind.Selected++
		} else {
			counts.Context++
			kind.Context++
		}
		if n := source.ParseDiagnosticCount(); n != 0 {
			counts.ParseFailedSources++
			counts.ParseFindings += n
		}
		kinds[kind.Kind] = kind
	}
	for _, kind := range kinds {
		counts.SourceKinds = append(counts.SourceKinds, kind)
	}
	slices.SortFunc(counts.SourceKinds, func(a, b KindCount) int { return cmp.Compare(a.Kind, b.Kind) })
	countFindings(counts, diagnostics(project, ds))
	return counts
}

// countFindings uses the same exact shared-fix interning as JSON diagnostics.
func countFindings(counts *StatisticsCounts, records []Diagnostic) {
	counts.Findings = len(records)
	fixes := map[*Fix]bool{}
	rules := map[string]int{}
	for _, d := range records {
		rules[d.RuleID]++
		if d.Fix != nil {
			fixes[d.Fix] = true
		}
	}
	counts.Fixes = len(fixes)
	counts.Rules = make([]FindingCount, 0, len(rules))
	for rule, count := range rules {
		counts.Rules = append(counts.Rules, FindingCount{rule, count})
	}
	slices.SortFunc(counts.Rules, func(a, b FindingCount) int { return cmp.Compare(a.RuleID, b.RuleID) })
}

// RenderStatistics writes a compact, path-free summary after diagnostics.
func RenderStatistics(w io.Writer, statistics *Statistics) error {
	if _, err := fmt.Fprintf(w, "Statistics v%d (%s; milliseconds)\n", statistics.SchemaVersion, statistics.Status); err != nil {
		return err
	}
	for _, snapshot := range []struct {
		name   string
		counts *StatisticsCounts
	}{{"initial", statistics.Initial}, {"rechecked", statistics.Rechecked}} {
		if snapshot.counts == nil {
			continue
		}
		c := snapshot.counts
		if _, err := fmt.Fprintf(w, "  %s: sources=%d selected=%d context=%d parse-failed=%d parse-findings=%d findings=%d shared-fixes=%d\n", snapshot.name, c.Sources, c.Selected, c.Context, c.ParseFailedSources, c.ParseFindings, c.Findings, c.Fixes); err != nil {
			return err
		}
		for _, kind := range c.SourceKinds {
			if _, err := fmt.Fprintf(w, "    kind %s: selected=%d context=%d\n", kind.Kind, kind.Selected, kind.Context); err != nil {
				return err
			}
		}
		for _, rule := range c.Rules {
			if _, err := fmt.Fprintf(w, "    rule %s: %d\n", rule.RuleID, rule.Count); err != nil {
				return err
			}
		}
	}
	for _, count := range []struct {
		name  string
		value *int
	}{{"planned-files", statistics.PlannedFiles}, {"applied-files", statistics.AppliedFiles}} {
		if count.value != nil {
			if _, err := fmt.Fprintf(w, "  %s: %d\n", count.name, *count.value); err != nil {
				return err
			}
		}
	}
	for _, phase := range statistics.Phases {
		duration := "unavailable"
		if phase.Duration != nil {
			duration = fmt.Sprintf("%.3f ms", *phase.Duration)
		}
		if _, err := fmt.Fprintf(w, "  %s: %s, %s (%s)", phase.Name, phase.Status, duration, phase.Scope); err != nil {
			return err
		}
		if phase.Attempts != nil {
			if _, err := fmt.Fprintf(w, "; parse-attempts=%d", *phase.Attempts); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintln(w); err != nil {
			return err
		}
	}
	return nil
}
