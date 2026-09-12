package theme

import "strings"

// Match resolves the style for a token with the given scope stack.
// scopes[0] is the root scope, scopes[len-1] is the most specific.
// Each property (foreground, background, fontStyle) is taken from the
// highest-scoring matching rule that defines it.
func (t *Theme) Match(scopes []string) TokenSettings {
	result := TokenSettings{FontStyle: FontStyleNotSet}
	var fgScore, bgScore, fsScore matchScore
	var fgSet, bgSet, fsSet bool

	for i := range t.TokenColors {
		rule := &t.TokenColors[i]
		score, ok := bestSelectorScore(rule, scopes)
		if !ok {
			continue
		}
		s := rule.Settings
		if s.Foreground != "" && (!fgSet || score.greaterThan(fgScore)) {
			result.Foreground = s.Foreground
			fgScore = score
			fgSet = true
		}
		if s.Background != "" && (!bgSet || score.greaterThan(bgScore)) {
			result.Background = s.Background
			bgScore = score
			bgSet = true
		}
		if s.FontStyle != FontStyleNotSet && (!fsSet || score.greaterThan(fsScore)) {
			result.FontStyle = s.FontStyle
			fsScore = score
			fsSet = true
		}
	}
	return result
}

func bestSelectorScore(rule *TokenColor, scopeStack []string) (matchScore, bool) {
	var best matchScore
	var found bool
	for i, sel := range rule.Scopes {
		var s matchScore
		var ok bool
		// Use the pre-compiled selector only when it provably corresponds to
		// the current Scopes entry — the source check (a pointer-equal string
		// compare after Parse) keeps in-place Scopes edits by API consumers
		// correct, and hand-built themes (nil compiled) fall back entirely.
		if i < len(rule.compiled) && rule.compiled[i].source == sel {
			s, ok = scoreCompiled(rule.compiled[i].parts, rule.compiled[i].scopeDepth, scopeStack)
		} else {
			s, ok = scoreSelector(sel, scopeStack)
		}
		if ok && (!found || s.greaterThan(best)) {
			best = s
			found = true
		}
	}
	return best, found
}

// compiledSelector is the parse-time pre-split form of one scope selector.
// Splitting selectors per Match call was the single largest allocator in the
// highlight pipeline (strings.Fields on static strings, per rule per token).
type compiledSelector struct {
	source     string   // the Scopes entry this was compiled from
	parts      []string // strings.Fields(source)
	scopeDepth int      // dot-segments in the last part; 0 when parts is empty
}

func compileSelector(sel string) compiledSelector {
	parts := strings.Fields(sel)
	c := compiledSelector{source: sel, parts: parts}
	if len(parts) > 0 {
		c.scopeDepth = strings.Count(parts[len(parts)-1], ".") + 1
	}
	return c
}

func compileSelectors(scopes []string) []compiledSelector {
	if len(scopes) == 0 {
		return nil
	}
	compiled := make([]compiledSelector, len(scopes))
	for i, sel := range scopes {
		compiled[i] = compileSelector(sel)
	}
	return compiled
}

type matchScore struct {
	depth      int // index of the deepest matched scope in the stack
	scopeDepth int // dot-segments in the rule's target scope (last selector part)
	parents    int // number of parent scope parts in the selector
}

func (s matchScore) greaterThan(other matchScore) bool {
	if s.depth != other.depth {
		return s.depth > other.depth
	}
	if s.scopeDepth != other.scopeDepth {
		return s.scopeDepth > other.scopeDepth
	}
	return s.parents > other.parents
}

// scoreSelector scores a selector against a scope stack.
// A selector may contain spaces for parent scope matching
// (e.g. "source.go keyword" requires "keyword" to appear below "source.go").
// Per-call parsing fallback — the hot path goes through pre-compiled
// selectors and scoreCompiled directly.
func scoreSelector(selector string, scopeStack []string) (matchScore, bool) {
	c := compileSelector(selector)
	return scoreCompiled(c.parts, c.scopeDepth, scopeStack)
}

// scoreCompiled scores a pre-split selector against a scope stack.
func scoreCompiled(parts []string, scopeDepth int, scopeStack []string) (matchScore, bool) {
	if len(parts) == 0 {
		return matchScore{}, false
	}

	partIdx := len(parts) - 1
	var depth int

	for stackIdx := len(scopeStack) - 1; stackIdx >= 0 && partIdx >= 0; stackIdx-- {
		if scopePrefixMatch(parts[partIdx], scopeStack[stackIdx]) {
			if partIdx == len(parts)-1 {
				depth = stackIdx
			}
			partIdx--
		}
	}

	if partIdx >= 0 {
		return matchScore{}, false
	}

	return matchScore{
		depth:      depth,
		scopeDepth: scopeDepth,
		parents:    len(parts),
	}, true
}

// scopePrefixMatch checks if selector is a prefix of scope on dot boundaries.
// "keyword" matches "keyword", "keyword.control", "keyword.control.go"
// but not "keywordx" or "keywords".
func scopePrefixMatch(selector, scope string) bool {
	if scope == selector {
		return true
	}
	return len(scope) > len(selector) &&
		scope[:len(selector)] == selector &&
		scope[len(selector)] == '.'
}
