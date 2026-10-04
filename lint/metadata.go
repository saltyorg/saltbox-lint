package lint

import (
	"slices"
	"strings"
)

// RuleMetadata is the public data projection. Executable policy and private
// providers are deliberately absent from this protocol.
type RuleMetadata struct {
	ID          string `json:"id"`
	Summary     string `json:"summary"`
	Explanation string `json:"explanation"`
	Kinds       []Kind `json:"source_kinds"`
	Scope       string `json:"scope"`
	GoodExample string `json:"good_example"`
	BadExample  string `json:"bad_example"`
	Fixable     bool   `json:"fixable"`
}
type RuleRegistry struct {
	SchemaVersion int            `json:"schema_version"`
	Rules         []RuleMetadata `json:"rules"`
}

// Registry returns an independent, deterministically ordered metadata snapshot.
func Registry() RuleRegistry {
	result := RuleRegistry{SchemaVersion: 1, Rules: []RuleMetadata{}}
	for _, rule := range Rules() {
		kinds := slices.Clone(rule.Kinds)
		slices.Sort(kinds)
		result.Rules = append(result.Rules, RuleMetadata{rule.ID, rule.Summary, rule.Explanation, kinds, rule.Scope, rule.GoodExample, rule.BadExample, rule.Fixable})
	}
	slices.SortFunc(result.Rules, func(a, b RuleMetadata) int { return strings.Compare(a.ID, b.ID) })
	return result
}
