package lint

import (
	"bytes"
	"slices"
	"unicode/utf8"
)

// structuralFix is an exact, source-derived transformation with a narrowly
// authorized YAML node replacement. Providers must prove the replacement's
// semantics before returning it; the common verifier checks every other node.
// Task-specific providers extend structuralFixes, never the whitespace policy.
type structuralFix struct {
	rule       string
	span       Span
	edits      []Edit
	node       *Node
	value      string
	items      []string
	valueEdits []Edit
}

func structuralFixes(s *Source) []structuralFix {
	return expressionStructuralFixes(s)
}

func structuralNodesEquivalent(a, b *Node, changes map[*Node]structuralFix) bool {
	if a == nil || b == nil {
		return a == b
	}
	if change, ok := changes[a]; ok {
		if change.items != nil {
			if b.Kind != "sequence" || b.Style != "block" || b.Tag != "" || b.Anchor != "" || len(b.Items) != len(change.items) {
				return false
			}
			for i, item := range b.Items {
				if item.Kind != "string" || item.Style != "plain" || item.Tag != "" || item.Anchor != "" || item.Value != change.items[i] {
					return false
				}
			}
			return true
		}
		if a.Kind != b.Kind || a.Style != b.Style || a.Tag != b.Tag || a.Anchor != b.Anchor || b.Value != change.value {
			return false
		}
		return true
	}
	if a.Kind != b.Kind || a.Style != b.Style || a.Tag != b.Tag || a.Anchor != b.Anchor || a.Value != b.Value || len(a.Entries) != len(b.Entries) || len(a.Items) != len(b.Items) {
		return false
	}
	for i, e := range a.Entries {
		if !structuralNodesEquivalent(e.Key, b.Entries[i].Key, changes) || !structuralNodesEquivalent(e.Value, b.Entries[i].Value, changes) {
			return false
		}
	}
	for i, item := range a.Items {
		if !structuralNodesEquivalent(item, b.Items[i], changes) {
			return false
		}
	}
	return true
}

// buildStructuralChange reparses caller-owned bytes and regenerates the exact
// permitted transformation. Private rule selection is a request, never proof.
// It validates structural edits once per file, then uses the existing whitespace
// authority for conditional wrapping and layout stabilization.
func buildStructuralChange(source *Source, rules []string) (Change, []structuralFix, bool) {
	s, ds := Parse(source.Path, source.Data)
	if len(ds) > 0 {
		return Change{}, nil, false
	}
	var chosen []structuralFix
	var edits []Edit
	changes := map[*Node]structuralFix{}
	for _, fix := range structuralFixes(s) {
		if !slices.Contains(rules, fix.rule) {
			continue
		}
		if prior, exists := changes[fix.node]; exists {
			if len(prior.valueEdits) == 0 || len(fix.valueEdits) == 0 {
				return Change{}, nil, false
			}
			merged, err := orderedEdits(append(slices.Clone(prior.valueEdits), fix.valueEdits...))
			if err != nil {
				return Change{}, nil, false
			}
			fix.valueEdits = merged
			fix.value = string(applyEdits([]byte(fix.node.Value), merged))
			if !equivalentExpressionScalar(fix.node.Value, fix.value) {
				return Change{}, nil, false
			}
		}
		chosen = append(chosen, fix)
		if fix.node != nil {
			changes[fix.node] = fix
		}
		edits = append(edits, fix.edits...)
	}
	ordered, err := orderedEdits(edits)
	if err != nil {
		return Change{}, nil, false
	}
	candidate, errors := Parse(s.Path, applyEdits(s.Data, ordered))
	if len(errors) > 0 || len(candidate.Documents) != len(s.Documents) {
		return Change{}, nil, false
	}
	for i, n := range s.Documents {
		if !structuralNodesEquivalent(n, candidate.Documents[i], changes) {
			return Change{}, nil, false
		}
	}
	if slices.Contains(rules, "jinja-conditional-length") {
		var wraps []Edit
		long := map[Span]bool{}
		for _, d := range checkConditionalLength(nil, candidate) {
			long[d.Span] = true
		}
		for _, e := range Expressions(candidate) {
			if !long[e.Span] || !e.mapped || !layoutSupported(e) {
				continue
			}
			a := layoutAnalysis{source: candidate, expression: e, newline: "\n"}
			if bytes.Contains(candidate.Data, []byte("\r\n")) {
				a.newline = "\r\n"
			}
			a.block, a.base = pureBlock(candidate, e)
			a.region(0, len(e.Tokens), a.column(e.Tokens[0].Span.Start), a.column(e.Span.Start), true)
			wraps = append(wraps, a.edits...)
		}
		ordered, err = orderedEdits(wraps)
		if err != nil {
			return Change{}, nil, false
		}
		data := applyEdits(candidate.Data, ordered)
		if !verifiedCandidate(candidate, data) {
			return Change{}, nil, false
		}
		candidate, _ = Parse(s.Path, data)
	}
	if slices.Contains(rules, "section-spacing") {
		var gaps []Edit
		for _, gap := range sectionGaps(candidate) {
			gaps = append(gaps, gap.Edit)
		}
		ordered, err = orderedEdits(gaps)
		if err != nil {
			return Change{}, nil, false
		}
		data := applyEdits(candidate.Data, ordered)
		if !verifiedCandidate(candidate, data) {
			return Change{}, nil, false
		}
		candidate, _ = Parse(s.Path, data)
	}
	normalized, ok := normalizeFixLayout(candidate)
	if !ok {
		return Change{}, nil, false
	}
	if bytes.Equal(s.Data, normalized.Data) {
		return Change{}, nil, false
	}
	if slices.Contains(rules, "jinja-conditional-length") && len(checkConditionalLength(nil, normalized)) == 0 {
		for _, d := range checkConditionalLength(nil, s) {
			chosen = append(chosen, structuralFix{rule: d.RuleID, span: d.Span})
		}
	}
	projection := replacementEdits(s.Data, normalized.Data)
	return Change{Path: s.Path, Before: bytes.Clone(s.Data), After: bytes.Clone(normalized.Data), fixRules: slices.Clone(rules), fixEdits: projection}, chosen, true
}
func normalizeFixLayout(s *Source) (*Source, bool) {
	candidate := s
	for range 24 {
		_, edits := layoutFindings(candidate)
		if len(edits) == 0 {
			return candidate, true
		}
		ordered, err := orderedEdits(edits)
		if err != nil {
			return nil, false
		}
		data := applyEdits(candidate.Data, ordered)
		if !verifiedCandidate(candidate, data) {
			return nil, false
		}
		candidate, _ = Parse(s.Path, data)
	}
	return nil, false
}

// A source splice retains every untouched byte exactly; no YAML is re-emitted.
// Trimming at rune and newline boundaries keeps editor coordinates lossless.
func replacementEdits(before, after []byte) []Edit {
	start := 0
	for start < len(before) && start < len(after) && before[start] == after[start] {
		start++
	}
	for start > 0 && ((start < len(before) && !utf8.RuneStart(before[start])) || (start < len(before) && before[start] == '\n' && before[start-1] == '\r')) {
		start--
	}
	end, stop := len(before), len(after)
	for end > start && stop > start && before[end-1] == after[stop-1] {
		end--
		stop--
	}
	for end < len(before) && (!utf8.RuneStart(before[end]) || (end > 0 && before[end] == '\n' && before[end-1] == '\r')) {
		end++
		stop++
	}
	if start == end && start == stop {
		return nil
	}
	return []Edit{{Span: Span{start, end}, Text: string(after[start:stop])}}
}

func attachStructuralFixes(s *Source, ds []Diagnostic) {
	var rules []string
	for _, d := range ds {
		switch d.RuleID {
		case "ansible-when-parentheses", "ansible-when-list", "jinja-redundant-conditional-parentheses", "jinja-conditional-length":
			rules = append(rules, d.RuleID)
		}
	}
	if len(rules) == 0 {
		return
	}
	for _, d := range ds {
		if d.Fix != nil {
			rules = append(rules, d.RuleID)
		}
	}
	slices.Sort(rules)
	rules = slices.Compact(rules)
	change, chosen, ok := buildStructuralChange(s, rules)
	if !ok {
		return
	}
	fix := &Fix{Message: "apply verified source corrections", Edits: change.fixEdits, fixRules: rules}
	for i, d := range ds {
		eligible := d.Fix != nil
		for _, proposal := range chosen {
			if d.RuleID == proposal.rule && d.Span == proposal.span {
				eligible = true
			}
		}
		if eligible {
			ds[i].Fix = fix
		}
	}
}
