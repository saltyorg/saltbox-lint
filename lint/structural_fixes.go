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
	rule          string
	span          Span
	edits         []Edit
	node          *Node
	value         string
	items         []string
	valueEdits    []Edit
	sequenceStyle string
}

// Rules select shared providers. Each provider runs once per source, and only
// proposals belonging to registered rules can enter the common verifier.
type structuralFixProvider struct {
	propose         func(*Source) []structuralFix
	requireProposal bool
}

var (
	expressionFixProvider     = structuralFixProvider{propose: expressionStructuralFixes}
	representationFixProvider = structuralFixProvider{propose: representationStructuralFixes, requireProposal: true}
	// Conditional wrapping is performed after structural edits and independently
	// verified as whitespace. It does not propose a YAML node replacement.
	conditionalFixProvider = structuralFixProvider{}
)

func structuralFixes(s *Source) []structuralFix {
	var fixes []structuralFix
	providers := map[*structuralFixProvider][]structuralFix{}
	for _, rule := range Rules() {
		provider := rule.structural
		if provider == nil || provider.propose == nil {
			continue
		}
		proposals, ok := providers[provider]
		if !ok {
			proposals = provider.propose(s)
			providers[provider] = proposals
		}
		for _, proposal := range proposals {
			if proposal.rule == rule.ID {
				fixes = append(fixes, proposal)
			}
		}
	}
	return fixes
}

func structuralNodesEquivalent(a, b *Node, changes map[*Node]structuralFix) bool {
	if a == nil || b == nil {
		return a == b
	}
	if change, ok := changes[a]; ok {
		if change.sequenceStyle != "" {
			if a.Kind != "sequence" || b.Kind != a.Kind || b.Style != change.sequenceStyle || a.Tag != b.Tag || a.Anchor != b.Anchor || len(a.Items) != len(b.Items) {
				return false
			}
			for i, item := range a.Items {
				if !structuralNodesEquivalent(item, b.Items[i], changes) {
					return false
				}
			}
			return true
		}
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
	if source.Kind == Template {
		return Change{}, nil, false
	}
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
	// The projection tracks every stage against the original bytes so ignored
	// lines are checked against the exact minimal source edits.
	projection := ordered
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
			a := layoutAnalysis{source: candidate, expression: e, newline: "\n", wrapNestedConditionals: true}
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
		projection = composeEdits(projection, ordered)
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
		projection = composeEdits(projection, ordered)
		candidate, _ = Parse(s.Path, data)
	}
	normalized, projection, ok := normalizeFixLayout(candidate, projection)
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
	if !independentlyEquivalent(s, normalized.Data, changes) {
		return Change{}, nil, false
	}
	projection = minimalEdits(s.Data, projection)
	if !bytes.Equal(applyEdits(s.Data, projection), normalized.Data) || !fixesPreserveIgnoredLines(s, projection) {
		return Change{}, nil, false
	}
	return Change{Path: s.Path, Before: bytes.Clone(s.Data), After: bytes.Clone(normalized.Data), fixRules: slices.Clone(rules), fixEdits: projection}, chosen, true
}
func normalizeFixLayout(s *Source, projection []Edit) (*Source, []Edit, bool) {
	candidate := s
	for range 24 {
		_, edits := layoutFindings(candidate)
		if len(edits) == 0 {
			return candidate, projection, true
		}
		ordered, err := orderedEdits(edits)
		if err != nil {
			return nil, nil, false
		}
		data := applyEdits(candidate.Data, ordered)
		if !verifiedCandidate(candidate, data) {
			return nil, nil, false
		}
		projection = composeEdits(projection, ordered)
		candidate, _ = Parse(s.Path, data)
	}
	return nil, nil, false
}

// composeEdits re-expresses next, ordered against applyEdits(base, prior), as
// ordered edits against base. A later edit touching an earlier replacement
// merges with it, so every original byte keeps one owner. No YAML is
// re-emitted: untouched bytes remain exact source splices.
func composeEdits(prior, next []Edit) []Edit {
	result := slices.Clone(prior)
	// Later edits are composed first so earlier current offsets stay valid.
	for k := len(next) - 1; k >= 0; k-- {
		e := next[k]
		starts := make([]int, len(result))
		deltas := make([]int, len(result)+1)
		for i, c := range result {
			starts[i] = c.Span.Start + deltas[i]
			deltas[i+1] = deltas[i] + len(c.Text) - (c.Span.End - c.Span.Start)
		}
		lo := 0
		for lo < len(result) && starts[lo]+len(result[lo].Text) < e.Span.Start {
			lo++
		}
		hi := lo - 1
		for hi+1 < len(result) && starts[hi+1] <= e.Span.End {
			hi++
		}
		merged := Edit{Span: Span{e.Span.Start - deltas[lo], 0}, Text: e.Text}
		if lo <= hi && starts[lo] <= e.Span.Start {
			merged.Span.Start = result[lo].Span.Start
			merged.Text = result[lo].Text[:e.Span.Start-starts[lo]] + merged.Text
		}
		if lo <= hi && starts[hi]+len(result[hi].Text) >= e.Span.End {
			merged.Span.End = result[hi].Span.End
			merged.Text += result[hi].Text[e.Span.End-starts[hi]:]
		} else {
			merged.Span.End = e.Span.End - deltas[hi+1]
		}
		result = slices.Replace(result, lo, hi+1, merged)
	}
	return result
}

// minimalEdits trims bytes each replacement retains unchanged. Boundaries stay
// on rune starts and never split CRLF, keeping editor coordinates lossless.
func minimalEdits(base []byte, edits []Edit) []Edit {
	boundary := func(pos int) bool {
		return pos <= 0 || pos >= len(base) || utf8.RuneStart(base[pos]) && (base[pos] != '\n' || base[pos-1] != '\r')
	}
	// Adjacent replacements coalesce first so trimming cannot leave two
	// insertions at one offset.
	var coalesced []Edit
	for _, e := range edits {
		if last := len(coalesced) - 1; last >= 0 && coalesced[last].Span.End == e.Span.Start {
			coalesced[last].Span.End = e.Span.End
			coalesced[last].Text += e.Text
			continue
		}
		coalesced = append(coalesced, e)
	}
	var result []Edit
	for _, e := range coalesced {
		old, text := base[e.Span.Start:e.Span.End], e.Text
		prefix := 0
		for prefix < len(old) && prefix < len(text) && old[prefix] == text[prefix] {
			prefix++
		}
		for prefix > 0 && !boundary(e.Span.Start+prefix) {
			prefix--
		}
		suffix := 0
		for suffix < len(old)-prefix && suffix < len(text)-prefix && old[len(old)-1-suffix] == text[len(text)-1-suffix] {
			suffix++
		}
		for suffix > 0 && !boundary(e.Span.End-suffix) {
			suffix--
		}
		trimmed := Edit{Span: Span{e.Span.Start + prefix, e.Span.End - suffix}, Text: text[prefix : len(text)-suffix]}
		if trimmed.Span.Start == trimmed.Span.End && trimmed.Text == "" {
			continue
		}
		result = append(result, trimmed)
	}
	return result
}

func attachStructuralFixes(s *Source, ds []Diagnostic) {
	var rules []string
	providers := map[string]*structuralFixProvider{}
	for _, rule := range Rules() {
		if rule.structural != nil {
			providers[rule.ID] = rule.structural
		}
	}
	proposals := map[*structuralFixProvider][]structuralFix{}
	for _, d := range ds {
		provider := providers[d.RuleID]
		if provider == nil {
			continue
		}
		if !provider.requireProposal {
			rules = append(rules, d.RuleID)
			continue
		}
		candidates, ok := proposals[provider]
		if !ok {
			candidates = provider.propose(s)
			proposals[provider] = candidates
		}
		for _, proposal := range candidates {
			if proposal.rule == d.RuleID && proposal.span == d.Span {
				rules = append(rules, d.RuleID)
				break
			}
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
