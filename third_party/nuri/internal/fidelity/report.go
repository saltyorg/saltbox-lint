package fidelity

import (
	"fmt"
	"slices"
	"strings"
)

// RenderMarkdown produces a FIDELITY.md table from a report.
// The themes parameter controls column order.
func RenderMarkdown(report *FidelityReport, themes []string) string {
	grammars := make([]string, 0, len(report.ByGrammar))
	for g := range report.ByGrammar {
		grammars = append(grammars, g)
	}
	slices.Sort(grammars)

	var sb strings.Builder
	sb.WriteString("# Fidelity Report\n\n")
	fmt.Fprintf(&sb, "**Overall**: %d / %d pass (%.1f%%)\n\n", report.GlobalPass, report.GlobalTotal, globalRate(report)*100)

	// Table header
	sb.WriteString("| Grammar |")
	for _, t := range themes {
		fmt.Fprintf(&sb, " %s |", t)
	}
	sb.WriteString(" Status |\n")

	// Separator
	sb.WriteString("|---------|")
	for range themes {
		sb.WriteString(":---:|")
	}
	sb.WriteString("----------|\n")

	// Rows
	for _, g := range grammars {
		fmt.Fprintf(&sb, "| %s |", g)
		allPass := true
		for _, t := range themes {
			pass := triplePass(report.Results, g, t)
			if pass {
				sb.WriteString(" ✅ |")
			} else {
				sb.WriteString(" ❌ |")
				allPass = false
			}
		}
		if allPass {
			sb.WriteString(" shipping |\n")
		} else {
			sb.WriteString(" held |\n")
		}
	}

	return sb.String()
}

func globalRate(r *FidelityReport) float64 {
	if r.GlobalTotal == 0 {
		return 0
	}
	return float64(r.GlobalPass) / float64(r.GlobalTotal)
}

func triplePass(results []TripleResult, grammar, theme string) bool {
	for _, r := range results {
		if r.Grammar == grammar && r.Theme == theme {
			return r.Pass
		}
	}
	return false
}
