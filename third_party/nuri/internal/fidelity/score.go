package fidelity

// TripleResult records the comparison outcome for one (grammar, theme, source) triple.
type TripleResult struct {
	Grammar string
	Theme   string
	Source  string // fixture source file or identifier
	Pass    bool
	Diffs   []TokenDiff
}

// GrammarScore aggregates pass/total for a single grammar across themes.
type GrammarScore struct {
	Pass  int
	Total int
}

// Rate returns the pass rate as a float64 in [0, 1].
func (s GrammarScore) Rate() float64 {
	if s.Total == 0 {
		return 0
	}
	return float64(s.Pass) / float64(s.Total)
}

// ThemeScore aggregates pass/total for a single theme across grammars.
type ThemeScore struct {
	Pass  int
	Total int
}

// Rate returns the pass rate as a float64 in [0, 1].
func (s ThemeScore) Rate() float64 {
	if s.Total == 0 {
		return 0
	}
	return float64(s.Pass) / float64(s.Total)
}

// FidelityReport is the aggregated fidelity report across all triples.
type FidelityReport struct {
	Results     []TripleResult
	ByGrammar   map[string]*GrammarScore
	ByTheme     map[string]*ThemeScore
	GlobalPass  int
	GlobalTotal int
}

// ComputeReport aggregates individual triple results into a fidelity report.
func ComputeReport(results []TripleResult) *FidelityReport {
	report := &FidelityReport{
		Results:   results,
		ByGrammar: make(map[string]*GrammarScore),
		ByTheme:   make(map[string]*ThemeScore),
	}

	for _, r := range results {
		report.GlobalTotal++
		if r.Pass {
			report.GlobalPass++
		}

		gs, ok := report.ByGrammar[r.Grammar]
		if !ok {
			gs = &GrammarScore{}
			report.ByGrammar[r.Grammar] = gs
		}
		gs.Total++
		if r.Pass {
			gs.Pass++
		}

		ts, ok := report.ByTheme[r.Theme]
		if !ok {
			ts = &ThemeScore{}
			report.ByTheme[r.Theme] = ts
		}
		ts.Total++
		if r.Pass {
			ts.Pass++
		}
	}

	return report
}
