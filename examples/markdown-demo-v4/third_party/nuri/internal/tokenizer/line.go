package tokenizer

import (
	"context"
	"strings"
	"time"

	"github.com/frostybee/nuri/internal/grammar"
	"github.com/frostybee/nuri/internal/oniguruma"
)

func tokenizeLine(
	ctx context.Context,
	line []byte,
	g *grammar.Grammar,
	onigLib oniguruma.OnigLib,
	state *StateStack,
	resolver grammar.GrammarResolver,
	injections []grammar.Injection,
	memo *compileMemo,
	startPos int,
	isFirstLine bool,
	deadline time.Time,
) ([]Token, *StateStack, bool, error) {

	builder := newLineTokenBuilder(startPos)
	lineLen := len(line)
	anchorPosition := -1

	// vscode-textmate appends "\n" to every bare line before tokenizing
	// (grammar.ts:380): anchors like $ and lookaheads in end patterns
	// need a newline character to interact with. scanLine mirrors that.
	// It is used for regex matching only; token production stays within
	// the bare line.
	scanLine := append(line[:len(line):len(line)], '\n')

	cc := &captureContext{
		ctx:        ctx,
		line:       scanLine,
		g:          g,
		onigLib:    onigLib,
		resolver:   resolver,
		injections: injections,
		memo:       memo,
		deadline:   deadline,
	}

	// Lines are bare (no trailing newline), so the token boundary equals
	// the line length. The sentinel newline exists only in scanLine.
	tokenEnd := lineLen

	// Phase A: check while conditions (only for top-level calls, not retokenization)
	if startPos == 0 {
		wcr := checkWhileConditions(ctx, line, isFirstLine, g, onigLib, state, builder, memo, cc)
		state = wcr.state
		startPos = wcr.linePos
		anchorPosition = wcr.anchorPosition
		isFirstLine = wcr.isFirstLine
	}

	// The scan boundary is the full scan string, matching vscode-textmate
	// whose lineLength counts the bare line plus its appended newline.
	// Rule state transitions (begin, end, while) are legitimate anywhere in
	// that range, including zero width matches at or past the bare line
	// end. Tokens are clamped back to the bare line on return.
	scanLen := len(scanLine)

	pos := startPos
loop:
	for pos <= scanLen {
		if !deadline.IsZero() && time.Now().After(deadline) {
			if pos < tokenEnd {
				builder.produce(tokenEnd, state.scopeSlice())
			}
			return clampTokens(builder.finish(), tokenEnd), state, true, nil
		}

		top := state.top()
		activeRules, endRule := getActivePatterns(state, g)

		compileG := g
		if top.ContentGrammar != nil {
			compileG = top.ContentGrammar
		}
		entry := memo.getOrCompile(ctx, top.Rule, activeRules, compileG, endRule)

		searchOpts := computeSearchOptions(isFirstLine, pos, anchorPosition)
		mr, err := findNextMatch(ctx, entry, scanLine, pos, searchOpts)
		if err != nil {
			break
		}

		injMatch, injPriority, injErr := matchInjections(ctx, injections, g, state, scanLine, pos, memo, searchOpts)
		if injErr != nil {
			break
		}

		mr = pickBestMatch(mr, injMatch, injPriority)

		if mr == nil {
			if pos < tokenEnd {
				builder.produce(tokenEnd, state.scopeSlice())
			}
			break
		}

		// A begin match that consumes the full scan string must record
		// BeginCapturedEOL, which seeds anchorPosition = 0 for while rule
		// checks on the next line. vscode-textmate computes the flag as
		// end == lineLength (tokenizeString.ts line 181), where lineLength
		// counts the bare line plus the engine's appended newline. scanLine
		// here is exactly that: bare line plus sentinel.
		capturedEOL := mr.match.Captures[0].End == scanLen

		// Captures stay unclamped: vscode-textmate feeds raw indices to
		// every handler, so positions, anchor updates, and rule state
		// transitions may land inside the sentinel newline. Token output
		// is clamped back to the bare line in clampTokens on return.
		matchStart := mr.match.Captures[0].Start
		matchEnd := mr.match.Captures[0].End

		if matchStart > pos {
			builder.produce(matchStart, state.scopeSlice())
		}

		hasAdvanced := matchEnd > pos

		switch rule := mr.rule.(type) {
		case *grammar.EndRule:
			// Under memo hits, mr.rule may be an equivalent EndRule cached
			// from the frame that filled the entry (same EndPattern, same
			// Parent, same EndCaptures map). The live frame's EndRule is
			// authoritative — substitute it to make that invariant explicit.
			rule = state.top().EndRule
			poppedFrame := *state.top()
			handleEndRule(rule, mr.match, state, builder, cc)
			anchorPosition = poppedFrame.AnchorPosition

			// Check [1]: EndRule popped without advancing, frame entered at same pos
			// (vscode-textmate lines 148-163).
			if !hasAdvanced && poppedFrame.EnterPosition == pos {
				state.push(poppedFrame)
				builder.produce(tokenEnd, state.scopeSlice())
				break loop
			}

		case *grammar.MatchRule:
			handleMatchRule(rule, mr.match, state, builder, cc, mr.ruleGrammar)

			// Check [4]: MatchRule without advancement (vscode-textmate lines 317-328).
			if !hasAdvanced {
				state.safePop()
				builder.produce(tokenEnd, state.scopeSlice())
				break loop
			}

		case *grammar.BeginEndRule:
			handleBeginRule(rule, mr.match, scanLine, state, builder, pos, cc, mr.ruleGrammar, capturedEOL)
			anchorPosition = matchEnd

			// Check [2]: BeginEndRule pushed same rule without advancing
			// (vscode-textmate lines 230-241).
			if !hasAdvanced && state.topHasSameRuleBelow() {
				state.pop()
				builder.produce(tokenEnd, state.scopeSlice())
				break loop
			}

		case *grammar.BeginWhileRule:
			handleBeginWhileRule(rule, mr.match, scanLine, state, builder, pos, cc, mr.ruleGrammar, capturedEOL)
			anchorPosition = matchEnd

			// Check [3]: BeginWhileRule pushed same rule without advancing
			// (vscode-textmate lines 279-290).
			if !hasAdvanced && state.topHasSameRuleBelow() {
				state.pop()
				builder.produce(tokenEnd, state.scopeSlice())
				break loop
			}
		}

		if matchEnd > pos {
			pos = matchEnd
			isFirstLine = false
		}
	}
	return clampTokens(builder.finish(), tokenEnd), state, false, nil
}

// clampTokens trims token spans back to the bare line. The tokenizer scans
// and transitions rule state across the sentinel newline exactly like
// vscode-textmate, whose emitted tokens may cover its appended newline;
// Shiki clamps them away on the consumer side, and this is the equivalent
// step here. Tokens fully inside the sentinel are dropped.
func clampTokens(tokens []Token, tokenEnd int) []Token {
	out := tokens[:0]
	for _, tok := range tokens {
		if tok.Start >= tokenEnd {
			continue
		}
		if tok.End > tokenEnd {
			tok.End = tokenEnd
		}
		if tok.Start >= tok.End {
			continue
		}
		out = append(out, tok)
	}
	return out
}

func getActivePatterns(state *StateStack, g *grammar.Grammar) ([]grammar.Rule, *grammar.EndRule) {
	top := state.top()
	if top.Rule == nil {
		return g.Patterns, nil
	}

	switch r := top.Rule.(type) {
	case *grammar.BeginEndRule:
		return r.Patterns, top.EndRule
	case *grammar.BeginWhileRule:
		return r.Patterns, nil
	case *grammar.CollectionRule:
		return r.Patterns, nil
	default:
		return g.Patterns, nil
	}
}

func computeSearchOptions(isFirstLine bool, pos, anchorPosition int) oniguruma.SearchOptions {
	opts := oniguruma.SearchOptionNone
	if !isFirstLine {
		opts |= oniguruma.SearchOptionNotBeginString
	}
	if pos != anchorPosition {
		opts |= oniguruma.SearchOptionNotBeginPosition
	}
	return opts
}

// captureContextForGrammar returns a captureContext that uses the rule's
// grammar for include resolution during capture retokenization. When a
// cross-grammar rule (e.g., C# inside razor) has captures with patterns,
// the includes must resolve against the rule's grammar, not the root grammar.
func captureContextForGrammar(cc *captureContext, ruleGrammar *grammar.Grammar) *captureContext {
	if ruleGrammar == nil || ruleGrammar == cc.g {
		return cc
	}
	tmp := *cc
	tmp.g = ruleGrammar
	return &tmp
}

func resolveScopeName(name string, captures []oniguruma.Capture, line []byte) string {
	// ResolveScopeBackrefs is a pure no-op without a $ marker — skip the
	// capture-text extraction entirely in that (overwhelmingly common) case.
	if name == "" || !strings.ContainsRune(name, '$') {
		return name
	}
	captureTexts := extractCaptureTexts(captures, line)
	return grammar.ResolveScopeBackrefs(name, captureTexts)
}

func handleMatchRule(
	rule *grammar.MatchRule,
	match *oniguruma.Match,
	state *StateStack,
	builder *lineTokenBuilder,
	cc *captureContext,
	ruleGrammar *grammar.Grammar,
) {
	scopes := state.scopeSlice()
	if rule.Name != "" {
		resolved := resolveScopeName(rule.Name, match.Captures, cc.line)
		scopes = appendScopes(scopes, resolved)
	}

	if len(rule.Captures) > 0 {
		handleCaptures(match.Captures, rule.Captures, scopes, builder, captureContextForGrammar(cc, ruleGrammar))
	} else {
		builder.produce(match.Captures[0].End, scopes)
	}
}

func handleBeginRule(
	rule *grammar.BeginEndRule,
	match *oniguruma.Match,
	line []byte,
	state *StateStack,
	builder *lineTokenBuilder,
	pos int,
	cc *captureContext,
	ruleGrammar *grammar.Grammar,
	capturedEOL bool,
) {
	// ResolveBackrefs/ResolveScopeBackrefs are pure no-ops without markers
	// (flag computed at parse time), so extraction is skipped harmlessly.
	var captureTexts []string
	if rule.NeedsBeginCaptureTexts {
		captureTexts = extractCaptureTexts(match.Captures, line)
	}

	// Resolve scope names against captures
	resolvedName := grammar.ResolveScopeBackrefs(rule.Name, captureTexts)
	resolvedContentName := grammar.ResolveScopeBackrefs(rule.ContentName, captureTexts)

	// Build scopes with resolved name pushed
	scopes := state.scopeSlice()
	if resolvedName != "" {
		scopes = appendScopes(scopes, resolvedName)
	}

	// Handle begin captures
	if len(rule.BeginCaptures) > 0 {
		handleCaptures(match.Captures, rule.BeginCaptures, scopes, builder, captureContextForGrammar(cc, ruleGrammar))
	} else {
		builder.produce(match.Captures[0].End, scopes)
	}

	// Create EndRule with backref substitution
	endPattern := grammar.ResolveBackrefs(rule.End, captureTexts)
	endRule := &grammar.EndRule{
		ID:          rule.ID + 1000000, // synthetic ID
		Parent:      rule,
		EndPattern:  endPattern,
		EndCaptures: rule.EndCaptures,
	}

	matchEnd := match.Captures[0].End
	state.pushBeginEnd(rule, endRule, matchEnd, pos, resolvedName, resolvedContentName, ruleGrammar)
	state.top().BeginCapturedEOL = capturedEOL
}

func handleEndRule(
	rule *grammar.EndRule,
	match *oniguruma.Match,
	state *StateStack,
	builder *lineTokenBuilder,
	cc *captureContext,
) {
	top := state.top()

	// Pop content scope by building scopes without it
	scopes := state.scopeSlice()
	if top.ContentScope != "" {
		scopes = scopes[:len(scopes)-countScopes(top.ContentScope)]
	}

	// Handle end captures — use the content grammar for capture retokenization
	if len(rule.EndCaptures) > 0 {
		handleCaptures(match.Captures, rule.EndCaptures, scopes, builder, captureContextForGrammar(cc, top.ContentGrammar))
	} else {
		builder.produce(match.Captures[0].End, scopes)
	}

	state.pop()
}

func handleBeginWhileRule(
	rule *grammar.BeginWhileRule,
	match *oniguruma.Match,
	line []byte,
	state *StateStack,
	builder *lineTokenBuilder,
	pos int,
	cc *captureContext,
	ruleGrammar *grammar.Grammar,
	capturedEOL bool,
) {
	// Same parse-time gating as handleBeginRule.
	var captureTexts []string
	if rule.NeedsBeginCaptureTexts {
		captureTexts = extractCaptureTexts(match.Captures, line)
	}

	resolvedName := grammar.ResolveScopeBackrefs(rule.Name, captureTexts)
	resolvedContentName := grammar.ResolveScopeBackrefs(rule.ContentName, captureTexts)

	scopes := state.scopeSlice()
	if resolvedName != "" {
		scopes = appendScopes(scopes, resolvedName)
	}

	if len(rule.BeginCaptures) > 0 {
		handleCaptures(match.Captures, rule.BeginCaptures, scopes, builder, captureContextForGrammar(cc, ruleGrammar))
	} else {
		builder.produce(match.Captures[0].End, scopes)
	}

	whilePattern := grammar.ResolveBackrefs(rule.While, captureTexts)
	whileRule := &grammar.WhileRule{
		ID:            rule.ID + 2000000,
		Parent:        rule,
		WhilePattern:  whilePattern,
		WhileCaptures: rule.WhileCaptures,
	}

	matchEnd := match.Captures[0].End
	state.pushBeginWhile(rule, whileRule, matchEnd, pos, resolvedName, resolvedContentName, ruleGrammar)
	state.top().BeginCapturedEOL = capturedEOL
}

type whileCheckResult struct {
	state          *StateStack
	linePos        int
	anchorPosition int
	isFirstLine    bool
}

// checkWhileConditions checks while-rule conditions at the start of a line.
// Matches vscode-textmate's _checkWhileConditions (tokenizeString.ts:345-403).
func checkWhileConditions(
	ctx context.Context,
	line []byte,
	isFirstLine bool,
	g *grammar.Grammar,
	onigLib oniguruma.OnigLib,
	state *StateStack,
	builder *lineTokenBuilder,
	memo *compileMemo,
	cc *captureContext,
) whileCheckResult {
	linePos := 0
	anchorPosition := -1
	if state.top().BeginCapturedEOL {
		anchorPosition = 0
	}

	// vscode-textmate appends "\n" before tokenizing, so while-condition
	// patterns like ^[\t ]*$ can match after the content newline. cc.line
	// is exactly that (the caller's scanLine) — reuse it instead of
	// duplicating the bytes, which also keeps the upload pin warm.
	whileScanLine := cc.line

	// Collect while-rule frame indices from bottom to top
	var whileIndices []int
	for i := range state.frames {
		if state.frames[i].WhileRule != nil {
			whileIndices = append(whileIndices, i)
		}
	}

	// Check in outermost-first order (matching vscode-textmate's reversed pop loop)
	for _, idx := range whileIndices {
		wr := state.frames[idx].WhileRule

		entry := memo.getOrCompileWhile(ctx, wr)

		whileOpts := computeSearchOptions(isFirstLine, linePos, anchorPosition)
		mr, err := findNextMatch(ctx, entry, whileScanLine, linePos, whileOpts)
		if err != nil || mr == nil {
			// While condition failed — pop back to this frame's parent
			for state.depth() > idx {
				state.pop()
			}
			break
		}

		// While matched — emit tokens around captures (vscode-textmate lines 383-393)
		if len(mr.match.Captures) > 0 {
			captureStart := mr.match.Captures[0].Start
			captureEnd := mr.match.Captures[0].End

			// Scope for this while-rule's frame
			scopes := state.scopeSliceTo(idx)

			builder.produce(captureStart, scopes)
			if len(wr.WhileCaptures) > 0 {
				handleCaptures(mr.match.Captures, wr.WhileCaptures, scopes, builder, cc)
			}
			builder.produce(captureEnd, scopes)

			anchorPosition = captureEnd
			if captureEnd > linePos {
				linePos = captureEnd
				isFirstLine = false
			}
		}
	}

	return whileCheckResult{
		state:          state,
		linePos:        linePos,
		anchorPosition: anchorPosition,
		isFirstLine:    isFirstLine,
	}
}

// pickBestMatch returns the winning match between a grammar match and an
// injection match. Earlier start position wins. On a tie, L: (PriorityLeft)
// lets the injection win; otherwise the grammar match wins.
func pickBestMatch(grammarMatch, injMatch *matchResult, injPriority grammar.Priority) *matchResult {
	if injMatch == nil {
		return grammarMatch
	}
	if grammarMatch == nil {
		return injMatch
	}

	gStart := grammarMatch.match.Captures[0].Start
	iStart := injMatch.match.Captures[0].Start

	if iStart < gStart {
		return injMatch
	}
	if gStart < iStart {
		return grammarMatch
	}

	if injPriority == grammar.PriorityLeft {
		return injMatch
	}
	return grammarMatch
}

// extractCaptureTexts extracts the text of each capture group.
func extractCaptureTexts(captures []oniguruma.Capture, line []byte) []string {
	texts := make([]string, len(captures))
	for i, c := range captures {
		if c.Start >= 0 && c.End >= c.Start && c.End <= len(line) {
			texts[i] = string(line[c.Start:c.End])
		}
	}
	return texts
}
