package lint

import (
	"cmp"
	"slices"
)

// Analyze evaluates applicable checkers on parsed sources, then reports only
// selected primary locations. Related locations may refer to contextual files.
// A checker's Scope describes its context needs; it does not widen selection.
func Analyze(project *Project, rules []Rule) []Diagnostic {
	if project == nil {
		return nil
	}
	diagnostics := slices.Clone(project.Diagnostics)
	for _, name := range sortedKeys(project.Sources) {
		source := project.Sources[name]
		if source == nil {
			continue
		}
		if len(source.parseDiagnostics) > 0 {
			diagnostics = append(diagnostics, source.parseDiagnostics...)
			continue
		}
		for _, rule := range rules {
			if rule.Check == nil || (len(rule.Kinds) > 0 && !slices.Contains(rule.Kinds, source.Kind)) {
				continue
			}
			diagnostics = append(diagnostics, rule.Check(project, source)...)
		}
	}
	type diagnosticKey struct {
		path, rule, severity, message, expected string
		span                                    Span
	}
	seen := map[diagnosticKey][]Diagnostic{}
	result := make([]Diagnostic, 0, len(diagnostics))
	for _, d := range diagnostics {
		if !project.Selected[d.Path] {
			continue
		}
		key := diagnosticKey{d.Path, d.RuleID, d.Severity, d.Message, d.Expected, d.Span}
		if slices.ContainsFunc(seen[key], func(prior Diagnostic) bool {
			return sameDiagnosticDetails(prior, d)
		}) {
			continue
		}
		seen[key] = append(seen[key], d)
		result = append(result, d)
	}
	slices.SortStableFunc(result, func(a, b Diagnostic) int {
		return cmp.Or(cmp.Compare(a.Path, b.Path), cmp.Compare(a.Span.Start, b.Span.Start), cmp.Compare(a.Span.End, b.Span.End), cmp.Compare(a.RuleID, b.RuleID), cmp.Compare(a.Message, b.Message))
	})
	return result
}

// Primary fields share a bucket; only equal explanatory and fix content makes
// a duplicate. Separate allocations of the same fix still compare equal.
func sameDiagnosticDetails(a, b Diagnostic) bool {
	if (a.Related == nil) != (b.Related == nil) || !slices.Equal(a.Related, b.Related) {
		return false
	}
	if a.Fix == nil || b.Fix == nil {
		return a.Fix == b.Fix
	}
	return a.Fix.Message == b.Fix.Message &&
		(a.Fix.Edits == nil) == (b.Fix.Edits == nil) && slices.Equal(a.Fix.Edits, b.Fix.Edits)
}
